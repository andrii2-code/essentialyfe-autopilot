'use strict';

// Reading availability calendars.
//
// He pastes a link and the app blocks out the dates. The link can come from anywhere:
// Airbnb, Vrbo, Google, Giggster. They all publish the same format (RFC 5545 .ics), so
// one reader covers every one of them, and a property can carry several at once.
//
// Written by hand rather than pulled in as a dependency, because what these feeds
// actually contain is a narrow slice of the standard: all-day VEVENTs with a start, an
// end and a summary. The parts that matter and are easy to get wrong are the ones this
// file is careful about, and they are noted where they happen.

const MAX_BYTES = 4 * 1024 * 1024;   // a year of bookings is a few KB; this is generous
const FETCH_TIMEOUT = 15000;

// ---- line handling ---------------------------------------------------------------
//
// Long properties are folded across lines: a continuation begins with a space or tab
// and belongs to the line before it. Unfolding first means a URL or a summary split
// over three lines is read as one value rather than three broken ones.
function unfold(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

// NAME;PARAM=VAL:value  ->  { name, params, value }
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const bits = left.split(';');
  const name = bits[0].toUpperCase();
  const params = {};
  for (const b of bits.slice(1)) {
    const eq = b.indexOf('=');
    if (eq > 0) params[b.slice(0, eq).toUpperCase()] = b.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// ---- dates -----------------------------------------------------------------------
//
// Everything is reduced to a plain YYYY-MM-DD. A booking is a range of days, not an
// instant, and turning these into Date objects invites the timezone bug where a
// booking starting on the 3rd shows as the 2nd for anyone west of UTC.
function toDay(value, params = {}) {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  // A DATE-TIME in UTC (trailing Z) can fall on the previous day locally, but these
  // feeds use it for the same purpose: the day the stay changes hands. Take the date
  // part as written, which is what every provider means by it.
  void params;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

// ---- what a block means ----------------------------------------------------------
//
// A feed can only ever tell us two things: a date has an event on it, or it does not.
// On Hold and Maintenance are not in any provider's export, so those are set by hand
// in the app and stored separately. Anything a feed gives us is a booking.
//
// The wording still matters for what he reads on screen. Airbnb writes "Reserved" for
// a real guest and "Airbnb (Not available)" for a date the owner blocked themselves;
// Vrbo writes "Blocked". Keeping that distinction means a date the owner shut off does
// not get reported to him as a paying booking.
function classify(summary) {
  const s = String(summary || '').toLowerCase();
  if (/not available|unavailable|blocked|block\b|closed/.test(s)) return 'blocked';
  return 'booked';
}

// ---- parsing ---------------------------------------------------------------------
//
// Returns { events, calName, error }. Never throws: one malformed feed among several
// on a property must not stop the others from being read.
function parseIcs(text) {
  const out = { events: [], calName: null, error: null };
  if (!text || !/BEGIN:VCALENDAR/i.test(text)) {
    out.error = 'That does not look like a calendar feed.';
    return out;
  }

  const lines = unfold(text).split('\n');
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();

    if (upper === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (upper === 'END:VEVENT') {
      if (cur && cur.start) {
        // DTEND is EXCLUSIVE for all-day events: a stay of the 3rd to the 5th is
        // written as DTEND 20260506 and covers the 3rd, 4th and 5th. Treating it as
        // inclusive blocks one day too many on every single booking, and a property
        // then looks unavailable on days it is free.
        const endExclusive = cur.end || addDays(cur.start, 1);
        const last = addDays(endExclusive, -1);
        out.events.push({
          uid: cur.uid || null,
          start: cur.start,
          // Stored inclusive, because that is what a person means by "booked until".
          end: last < cur.start ? cur.start : last,
          summary: cur.summary || null,
          state: classify(cur.summary),
        });
      }
      cur = null;
      continue;
    }

    const p = parseLine(line);
    if (!p) continue;
    if (!cur) {
      if (p.name === 'X-WR-CALNAME') out.calName = p.value.trim() || null;
      continue;
    }
    if (p.name === 'DTSTART') cur.start = toDay(p.value, p.params);
    else if (p.name === 'DTEND') cur.end = toDay(p.value, p.params);
    else if (p.name === 'UID') cur.uid = p.value.trim();
    else if (p.name === 'SUMMARY') {
      // Escaped commas and semicolons are part of the format, not part of the text.
      cur.summary = p.value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
    }
  }

  if (!out.events.length && !out.error) {
    // A valid but empty calendar is a normal answer: the property is simply free.
    out.error = null;
  }
  return out;
}

// ---- fetching --------------------------------------------------------------------

// Providers hand out webcal:// links as often as https://. They are the same URL.
function normaliseUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (/^webcal:\/\//i.test(u)) return 'https://' + u.slice(9);
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

async function fetchIcs(url) {
  const target = normaliseUrl(url);
  if (!target) return { events: [], error: 'That is not a calendar link.' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: ctl.signal,
      // Some providers serve the ICS only to clients that ask for it plainly.
      headers: { accept: 'text/calendar, text/plain, */*', 'user-agent': 'EssentiaLyfe/1.0' },
    });
    if (!res.ok) {
      return { events: [], error: res.status === 404
        ? 'The calendar link is no longer valid. Ask the owner for a new one.'
        : `The calendar could not be read (${res.status}).` };
    }
    const text = (await res.text()).slice(0, MAX_BYTES);
    const parsed = parseIcs(text);
    return { events: parsed.events, calName: parsed.calName, error: parsed.error };
  } catch (e) {
    return { events: [], error: e.name === 'AbortError'
      ? 'The calendar did not answer in time.'
      : 'The calendar could not be reached.' };
  } finally { clearTimeout(timer); }
}

// ---- merging ---------------------------------------------------------------------
//
// A home can be on Airbnb and Vrbo at once, and he asked for those to be merged. Two
// feeds will each carry the same stay when a guest books through one and the owner
// syncs it to the other, so overlapping ranges collapse to one answer per day.
//
// Precedence when two sources disagree about a day: whatever he set by hand wins over
// anything a feed says, because he is the one who knows the property is being painted
// that week. Between feeds, booked beats blocked, since a paying guest is the more
// important fact to see.
const RANK = { available: 0, blocked: 1, booked: 2, hold: 3, maintenance: 4 };

// Turn events and manual blocks into one state per day across a window.
// `manual` entries look like { start, end, state } with state 'hold' | 'maintenance'.
function mergeDays(feedEvents = [], manual = [], { from, to } = {}) {
  const days = new Map();
  const mark = (start, end, state, extra = {}) => {
    if (!start) return;
    let d = start;
    const last = end && end >= start ? end : start;
    // A runaway range would otherwise loop for years.
    for (let i = 0; d <= last && i < 800; i++, d = addDays(d, 1)) {
      if (from && d < from) continue;
      if (to && d > to) break;
      const prev = days.get(d);
      if (!prev || RANK[state] > RANK[prev.state]) days.set(d, { state, ...extra });
    }
  };

  for (const e of feedEvents) mark(e.start, e.end, e.state || 'booked', { via: e.via || null, summary: e.summary || null });
  for (const m of manual) mark(m.start, m.end, m.state, { note: m.note || null, manual: true });
  return days;
}

// The same thing as a plain list, which is what the API returns.
function daysList(feedEvents, manual, window) {
  return [...mergeDays(feedEvents, manual, window).entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, ...v }));
}

module.exports = {
  parseIcs, fetchIcs, normaliseUrl, classify, mergeDays, daysList, addDays, toDay,
  FETCH_TIMEOUT,
};
