'use strict';

// Photos for imported properties, fetched in the background.
//
// His spreadsheet links a photo FOLDER per property rather than the pictures, so an
// imported row arrives with nothing for the gallery. Fetching them used to be a second
// button he had to know about, because doing every row inline would hold the import
// request open long past any sensible timeout.
//
// So the import kicks this off and returns immediately. The job keeps running after the
// response and works through every remaining property, reporting progress that the
// import panel polls. No button, and no 60-row ceiling either.

const drivePhotos = require('./drive-photos');
const enrichPhotos = require('./photo-enrich');

// Small enough that a batch always finishes well inside a request's worth of work, so
// progress moves visibly rather than jumping at the end.
const BATCH = 10;

let job = null;

// The job is a singleton: two imports in a row must not run two passes over the same
// rows and spend the credits twice.
//
// Running until the loop has actually exited, not until it was asked to stop. Pressing
// Stop leaves the batch in flight, and reporting "stopped" while photos were still
// being fetched meant the next run saw a half-written picture of what was done.
function isRunning() {
  return !!job && !job.finished;
}

function snapshot() {
  if (!job) return null;
  const { startedAt, promise, counting, finished, ...rest } = job;
  return { ...rest, running: isRunning() };
}

async function runBatch(q, rows) {
  let fromDrive = { updates: [], withPhotos: 0, denied: [] };
  try {
    // His own folders first. Every row of his sheet links one (29 of 29 in his test
    // export, against 26 of 29 that resolve by address), they are his own photographs
    // rather than the agent's, and they cost no API credits.
    fromDrive = await drivePhotos.backfill(rows, { limit: rows.length });
    for (const u of fromDrive.updates) await q.setPhotos(u.id, u.photos, null);
    await q.markFolderDenied(fromDrive.denied);
  } catch (e) {
    // Drive failing must not stop the listing lookup below — that is the whole point
    // of having a second source.
    console.error('[photo-job] drive:', e.message);
  }

  const doneIds = new Set(fromDrive.updates.map(u => u.id));
  let viaApi = { updates: [], unchecked: [], outOfCredits: false };
  const left = rows.filter(r => !doneIds.has(r.id));

  if (process.env.REALTYAPI_KEY && left.length) {
    try {
      viaApi = await enrichPhotos.backfill(left, { limit: left.length });
      for (const u of viaApi.updates) {
        await q.setPhotos(u.id, u.photos, u.propertyUrl);
        doneIds.add(u.id);
      }
    } catch (e) { console.error('[photo-job] listing lookup:', e.message); }
  }

  // Record WHY each remaining property has no gallery. Rows the lookup never got to
  // ask about are the only ones marked for retry: buying the subscription fixes those
  // and nothing else, so re-running must not re-ask about houses that genuinely have
  // no photograph anywhere.
  const unchecked = new Set(viaApi.unchecked || []);
  // No key at all is the same situation as a spent one — the lookup never ran.
  const noKey = !process.env.REALTYAPI_KEY;
  const retryIds = [], byReason = new Map();
  for (const row of left) {
    if (doneIds.has(row.id)) continue;
    if (noKey || unchecked.has(row.id)) { retryIds.push(row.id); continue; }
    const reason = (fromDrive.failures || []).find(f => f.id === row.id)?.reason || 'no_listing_photos';
    // Drive could not help AND the listing data had nothing: the honest reason is the
    // second one, since the lookup is what actually decided it.
    const final = reason === 'deleted_folder' ? 'deleted_folder_no_listing' : 'no_listing_photos';
    if (!byReason.has(final)) byReason.set(final, []);
    byReason.get(final).push(row.id);
  }
  try {
    if (retryIds.length) await q.markPhotoFailure(retryIds, 'out_of_credits', true);
    for (const [reason, ids] of byReason) await q.markPhotoFailure(ids, reason, false);
  } catch (e) { console.error('[photo-job] recording reasons:', e.message); }

  return {
    fromDrive: fromDrive.withPhotos,
    fromListing: viaApi.updates.length,
    folderDenied: fromDrive.denied.length,
    queuedForRetry: retryIds.length,
    outOfCredits: !!viaApi.outOfCredits || noKey,
  };
}

// Fire and forget. Returns the initial state so the caller can report a count without
// waiting for any of the work.
// `retryOnly` works the queue of rows that were never checked because the credits ran
// out. That is the run to make once he buys the subscription: it skips the properties
// already ruled out, so nothing is paid for twice.
function start(q, { onDone, retryOnly = false } = {}) {
  if (isRunning()) return snapshot();

  // `me` rather than the module-level `job`. Stopping only takes effect between
  // batches, so a stopped run is still finishing its current batch when the next one
  // starts, and writing to `job` meant the old loop kept incrementing the NEW run's
  // counters and re-reading properties it had already done.
  const me = {
    total: 0, done: 0, withPhotos: 0,
    fromDrive: 0, fromListing: 0, folderDenied: 0, noneAvailable: 0,
    // Kept apart from noneAvailable: these are waiting on the subscription, not on
    // photographs that do not exist.
    queuedForRetry: 0, outOfCredits: false,
    error: null, stopped: false, startedAt: Date.now(),
    // Counting the rows is itself a query, so until it lands the job has total 0 and
    // would otherwise read as "already finished" to anyone polling.
    counting: true, finished: false,
  };
  job = me;

  me.promise = (async () => {
    try {
      const all = retryOnly ? await q.photoRetryQueue() : await q.withoutPhotos();
      if (job !== me) return;                  // superseded while counting
      me.retryOnly = retryOnly;
      me.total = all.length;
      me.counting = false;
      if (!all.length) return;

      for (let i = 0; i < all.length; i += BATCH) {
        if (me.stopped || job !== me) break;
        const batch = all.slice(i, i + BATCH);
        const r = await runBatch(q, batch);
        if (job !== me) return;                // a newer run owns the counters now
        const got = r.fromDrive + r.fromListing;
        me.fromDrive += r.fromDrive;
        me.fromListing += r.fromListing;
        me.folderDenied += r.folderDenied;
        me.queuedForRetry += r.queuedForRetry;
        if (r.outOfCredits) me.outOfCredits = true;
        me.withPhotos += got;
        // Only the ones actually ruled out. A row waiting on credits has not been
        // checked, and counting it as "none available" is what made the number wrong.
        me.noneAvailable += batch.length - got - r.queuedForRetry;
        me.done += batch.length;
      }
    } catch (e) {
      me.error = e.message;
      console.error('[photo-job]', e);
    } finally {
      // A cancelled run keeps its real count: "stopped at 90 of 6,695" is the honest
      // number, and rounding it up to the total would claim work it never did.
      me.counting = false;
      if (!me.error && !me.stopped) me.done = me.total;
      me.finished = true;
      if (onDone && job === me) { try { await onDone(snapshot()); } catch {} }
    }
  })();

  return snapshot();
}

function status() { return snapshot(); }

// Stopping is checked between batches, so the batch already in flight finishes and
// its photos are kept. Cancelling must not throw away pictures it has already paid
// for — he can start again and it picks up from whatever is still missing.
function stop() {
  if (!job) return null;
  job.stopped = true;
  return snapshot();
}

module.exports = { start, status, stop, isRunning, BATCH };
