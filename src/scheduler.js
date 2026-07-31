// The all-day collector and the daily email, running on their own.
//
// Both are driven by one timer that wakes up every minute and asks "is anything due?".
// State lives in the settings table, not in memory, so a Railway redeploy doesn't
// silently switch automation off or double-send the day's email.
//
// IMPORTANT — the collector ships PAUSED. Every collector pass costs real
// RapidAPI calls, and that subscription isn't live yet, so leaving it running would
// spend quota (or fail all day) before he's ready. He turns it on from the Automation
// panel, or by setting COLLECTOR_ENABLED=true.
//
// Settings used:
//   collector.enabled      bool    run the collector automatically
//   collector.intervalMin  number  minutes between passes (default 180 = 8x/day)
//   collector.limitPerSpec number  listings pulled per spec per pass
//   collector.lastRunAt    ISO     when the last automatic pass finished
//   digest.enabled         bool    send the daily email automatically
//   digest.hourPT          number  hour to send it, in HIS time (Los Angeles)
//   digest.hourUTC         number  legacy: an hour stored in UTC, migrated on read
//   digest.lastSentDate    string  YYYY-MM-DD of the last send, so it goes once a day

const { q } = require('./db');
const { runCollector } = require('./pipeline');
const { sendDigest } = require('./digest');

const TICK_MS = 60 * 1000;

const DEFAULTS = {
  'collector.enabled': false,      // deliberately off — see the note above
  'collector.intervalMin': 180,
  'collector.limitPerSpec': 12,
  'digest.enabled': true,
  'digest.hourPT': 6,              // 6am Los Angeles, so it's waiting when he starts
};

// His timezone. The email time is stored in HIS hours, not UTC, because a fixed UTC
// hour drifts by one when daylight saving starts and ends — 6am Pacific is 13:00 UTC in
// winter but 14:00 in summer.
const TZ = 'America/Los_Angeles';

// What hour is it right now where he is?
function hourInPT(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', hour12: false,
  }).format(d));
}

// Today's calendar date where he is. Used for the once-a-day guard, so "today" means
// his today — otherwise an evening email would look like a second one for the same day.
function dateInPT(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// The UTC offset of his timezone at a given moment, in minutes (handles DST).
function ptOffsetMinutes(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).format(d);
  const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return -8 * 60;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

let timer = null;
let running = false;               // guards against overlapping passes
let lastError = null;

async function setting(key) {
  const v = await q.getSetting(key, undefined);
  return v === undefined || v === null ? DEFAULTS[key] : v;
}

// ---- collector ----
async function collectorDue() {
  if (!(await setting('collector.enabled'))) return false;
  const last = await q.getSetting('collector.lastRunAt', null);
  if (!last) return true; // never run — go now
  const mins = (Date.now() - new Date(last).getTime()) / 60000;
  return mins >= (await setting('collector.intervalMin'));
}

async function runCollectorPass({ manual = false } = {}) {
  const limitPerSpec = await setting('collector.limitPerSpec');
  const r = await runCollector({ limitPerSpec });
  await q.setSetting('collector.lastRunAt', new Date().toISOString());
  console.log(`[scheduler] collector${manual ? ' (manual)' : ''}: `
    + `${r.kept} new of ${r.sourced}, ${r.priceChanges.length} price change(s)`);
  return r;
}

// ---- daily email ----
// Keyed on the calendar date rather than an interval, so it lands at a predictable
// hour and a restart 30 minutes later can't trigger a second send for the same day.

// The send hour, in HIS time. Reads the new setting, and falls back to converting a
// legacy UTC hour so an existing deployment keeps roughly the time he had chosen.
async function sendHourPT() {
  const pt = await q.getSetting('digest.hourPT', null);
  if (pt !== null && pt !== undefined) return Number(pt);
  const legacy = await q.getSetting('digest.hourUTC', null);
  if (legacy !== null && legacy !== undefined) {
    const offset = ptOffsetMinutes() / 60;            // e.g. -7 in summer
    return ((Number(legacy) + offset) % 24 + 24) % 24;
  }
  return DEFAULTS['digest.hourPT'];
}

async function digestDue() {
  if (!(await setting('digest.enabled'))) return false;
  if (hourInPT() < (await sendHourPT())) return false;
  const lastSent = await q.getSetting('digest.lastSentDate', null);
  return lastSent !== dateInPT();
}

async function runDigestPass() {
  const r = await sendDigest({ days: 1, force: false });
  // Stamp the date even when there was nothing to report: the point is one attempt a
  // day, and re-checking every minute for a quiet day is pointless noise.
  await q.setSetting('digest.lastSentDate', dateInPT());
  console.log(`[scheduler] daily email: ${r.sent ? 'sent' : 'not sent'}`
    + ` (${r.newCount} new, ${r.priceChangeCount} price changes)`
    + (r.reason ? ` — ${r.reason}` : ''));
  return r;
}

// ---- the tick ----
async function tick() {
  if (running) return;             // a slow collector pass must not stack up
  running = true;
  try {
    if (await collectorDue()) await runCollectorPass();
    if (await digestDue()) await runDigestPass();
    lastError = null;
  } catch (e) {
    // Never let a bad pass kill the timer — the next tick tries again.
    lastError = { at: new Date().toISOString(), message: e.message };
    console.error('[scheduler] tick failed:', e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  // COLLECTOR_ENABLED can force the collector on or OFF at boot, overriding whatever is
  // in the database. Explicit "false" matters as much as "true": it's the kill switch
  // for a deployment that must not spend listing-API quota, whatever a stray write or a
  // test against the shared database may have left in the settings row.
  const envFlag = String(process.env.COLLECTOR_ENABLED || '').toLowerCase();
  if (envFlag === 'true' || envFlag === 'false') {
    q.setSetting('collector.enabled', envFlag === 'true').catch(() => {});
    console.log(`[scheduler] COLLECTOR_ENABLED=${envFlag} — forcing the collector ${envFlag === 'true' ? 'on' : 'off'}`);
  }
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();  // don't hold a test process open
  console.log('[scheduler] started (checks every minute)');
  // Check once shortly after boot rather than waiting a full minute.
  setTimeout(() => { tick().catch(() => {}); }, 5000).unref?.();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// What the Automation panel shows.
async function status() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = await setting(k);
  const lastRunAt = await q.getSetting('collector.lastRunAt', null);
  const lastSentDate = await q.getSetting('digest.lastSentDate', null);

  let nextRunAt = null;
  if (s['collector.enabled']) {
    nextRunAt = lastRunAt
      ? new Date(new Date(lastRunAt).getTime() + s['collector.intervalMin'] * 60000).toISOString()
      : 'due now';
  }

  // Next daily email: today at his hour if it hasn't gone yet, else tomorrow. Built
  // from the Pacific date + hour and converted back to an instant, so it stays correct
  // across a daylight-saving change.
  const now = new Date();
  const hourPT = await sendHourPT();
  let nextDigestAt = null;
  if (s['digest.enabled']) {
    const [y, m, day] = dateInPT(now).split('-').map(Number);
    const asUtc = (yy, mm, dd) =>
      new Date(Date.UTC(yy, mm - 1, dd, hourPT, 0, 0) - ptOffsetMinutes(now) * 60000);
    let d = asUtc(y, m, day);
    if (lastSentDate === dateInPT(now) || now.getTime() > d.getTime()) {
      const t = new Date(Date.UTC(y, m - 1, day) + 864e5);
      d = asUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    nextDigestAt = d.toISOString();
  }

  return {
    running: !!timer,
    busy: running,
    collector: {
      enabled: s['collector.enabled'],
      intervalMin: s['collector.intervalMin'],
      limitPerSpec: s['collector.limitPerSpec'],
      lastRunAt, nextRunAt,
    },
    digest: {
      enabled: s['digest.enabled'],
      hourPT,                       // his time, not UTC
      timezone: 'PT',
      lastSentDate, nextDigestAt,
    },
    lastError,
    recentRuns: await q.recentRuns(5),
  };
}

module.exports = { start, stop, tick, status, runCollectorPass, runDigestPass, collectorDue, digestDue, DEFAULTS };
