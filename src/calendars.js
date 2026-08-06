'use strict';

// Keeping the availability calendars up to date.
//
// A feed is fetched, parsed and stored per property. One failing feed never stops the
// others: a home can carry several, and an expired Airbnb link should not hide the
// Vrbo bookings sitting next to it.

const ical = require('./ical');

// How far ahead the calendar view runs. A year covers every booking these providers
// publish, and stops one bad feed from filling the table with a decade of rows.
const WINDOW_DAYS = 400;

// Guess a name from the link so he does not have to type one. The label is what he
// reads on screen next to each feed, and "Airbnb" is more use than the raw URL.
function labelFor(url, calName) {
  const u = String(url || '').toLowerCase();
  if (/airbnb\./.test(u)) return 'Airbnb';
  if (/vrbo\.|homeaway\./.test(u)) return 'Vrbo';
  if (/google\./.test(u)) return 'Google Calendar';
  if (/giggster\./.test(u)) return 'Giggster';
  if (/peerspace\./.test(u)) return 'Peerspace';
  if (/booking\.com/.test(u)) return 'Booking.com';
  if (/expedia\./.test(u)) return 'Expedia';
  // The feed often names itself, which beats anything guessed from the host.
  if (calName) return String(calName).slice(0, 60);
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Calendar'; }
}

// Fetch one feed and store what it holds. Returns what happened, in his terms.
async function syncOne(q, cal) {
  const r = await ical.fetchIcs(cal.url);
  // Keep only what falls inside the window. A feed occasionally carries years of
  // history, and none of it affects whether the house is free next month.
  const today = new Date().toISOString().slice(0, 10);
  const horizon = ical.addDays(today, WINDOW_DAYS);
  const kept = (r.events || []).filter(e => e.end >= ical.addDays(today, -1) && e.start <= horizon);

  await q.replaceCalendarEvents(cal.listing_id, cal.id, kept, r.error || null);
  return { id: cal.id, label: cal.label, events: kept.length, error: r.error || null, calName: r.calName || null };
}

// Every feed on one property, in parallel. Each is independently recoverable, so one
// dead link cannot take the rest of the property's availability with it.
async function syncListing(q, listingId) {
  const cals = await q.calendarsFor(listingId);
  const results = await Promise.all(cals.map(c =>
    syncOne(q, { ...c, listing_id: listingId }).catch(e => ({
      id: c.id, label: c.label, events: 0, error: e.message || 'Could not read this calendar.',
    }))));
  return results;
}

// The nightly pass over everything. Bounded concurrency: several hundred properties
// each with two feeds would otherwise open every connection at once.
async function syncAll(q, { concurrency = 6, onProgress = () => {} } = {}) {
  const cals = await q.allCalendars();
  let done = 0, failed = 0, events = 0;
  for (let i = 0; i < cals.length; i += concurrency) {
    const batch = cals.slice(i, i + concurrency);
    const rs = await Promise.all(batch.map(c => syncOne(q, c).catch(e => ({ error: e.message, events: 0 }))));
    for (const r of rs) {
      done++;
      if (r.error) failed++;
      events += r.events || 0;
      onProgress({ done, total: cals.length, error: r.error || null });
    }
  }
  return { calendars: cals.length, synced: done, failed, events };
}

// What the property page draws: one state per day, feeds and his own blocks merged.
async function availability(q, listingId, { from, to } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const start = from || today;
  const end = to || ical.addDays(start, WINDOW_DAYS);
  const [events, blocks, calendars] = await Promise.all([
    q.calendarEvents(listingId),
    q.manualBlocks(listingId),
    q.calendarsFor(listingId),
  ]);
  return {
    from: start, to: end,
    calendars,
    days: ical.daysList(events, blocks, { from: start, to: end }),
    blocks,
  };
}

module.exports = { syncOne, syncListing, syncAll, availability, labelFor, WINDOW_DAYS };
