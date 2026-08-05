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
function isRunning() {
  if (!job || job.stopped || job.error) return false;
  return job.counting || job.done < job.total;
}

function snapshot() {
  if (!job) return null;
  const { startedAt, promise, counting, ...rest } = job;
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

  let viaApi = { updates: [] };
  if (process.env.REALTYAPI_KEY) {
    const doneIds = new Set(fromDrive.updates.map(u => u.id));
    const left = rows.filter(r => !doneIds.has(r.id));
    if (left.length) {
      try {
        viaApi = await enrichPhotos.backfill(left, { limit: left.length });
        for (const u of viaApi.updates) await q.setPhotos(u.id, u.photos, u.propertyUrl);
      } catch (e) { console.error('[photo-job] listing lookup:', e.message); }
    }
  }

  return {
    fromDrive: fromDrive.withPhotos,
    fromListing: viaApi.updates.length,
    folderDenied: fromDrive.denied.length,
  };
}

// Fire and forget. Returns the initial state so the caller can report a count without
// waiting for any of the work.
function start(q, { onDone } = {}) {
  if (isRunning()) return snapshot();

  job = {
    total: 0, done: 0, withPhotos: 0,
    fromDrive: 0, fromListing: 0, folderDenied: 0, noneAvailable: 0,
    error: null, stopped: false, startedAt: Date.now(),
    // Counting the rows is itself a query, so until it lands the job has total 0 and
    // would otherwise read as "already finished" to anyone polling.
    counting: true,
  };

  job.promise = (async () => {
    try {
      const all = await q.withoutPhotos();
      job.total = all.length;
      job.counting = false;
      if (!all.length) return;

      for (let i = 0; i < all.length; i += BATCH) {
        if (job.stopped) break;
        const batch = all.slice(i, i + BATCH);
        const r = await runBatch(q, batch);
        const got = r.fromDrive + r.fromListing;
        job.fromDrive += r.fromDrive;
        job.fromListing += r.fromListing;
        job.folderDenied += r.folderDenied;
        job.withPhotos += got;
        job.noneAvailable += batch.length - got;
        job.done += batch.length;
      }
    } catch (e) {
      job.error = e.message;
      console.error('[photo-job]', e);
    } finally {
      // Make sure a finished job never reads as still running, whatever went wrong.
      if (job) job.counting = false;
      if (job && !job.error) job.done = job.total;
      if (onDone) { try { await onDone(snapshot()); } catch {} }
    }
  })();

  return snapshot();
}

function status() { return snapshot(); }

function stop() { if (job) job.stopped = true; }

module.exports = { start, status, stop, isRunning, BATCH };
