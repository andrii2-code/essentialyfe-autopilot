'use strict';

// Opening a Drive folder for every property that has none.
//
// His words: "many homes don't have pictures due to the property not being ready yet
// but we can open a google drive for them. Anyway to do it faster or do I need to do it
// manually with my va?" The answer is no, and this is it.
//
// Same shape as the photo job: it runs in the background, reports progress, can be
// stopped, and picks up where it left off. Drive is rate limited, so this goes at a
// deliberate pace rather than firing 6,000 requests at once.

const drive = require('./drive');

const BATCH = 5;
// Drive allows roughly 10 writes a second per user. A short pause between batches keeps
// a 6,000-property run well under that instead of collecting 403s halfway through.
const PAUSE_MS = 350;

let job = null;

// Running until the loop has actually exited, not until it was asked to stop. Pressing
// Stop leaves the batch in flight, and reporting "stopped" while folders were still
// being made meant the next run saw a half-written picture of what was done.
function isRunning() {
  return !!job && !job.finished;
}

function snapshot() {
  if (!job) return null;
  const { startedAt, promise, counting, finished, ...rest } = job;
  return { ...rest, running: isRunning() };
}

// Fire and forget. Returns the starting state so the caller can answer immediately.
function start(q, { onDone } = {}) {
  if (isRunning()) return snapshot();

  // `me` rather than the module-level `job`. Stopping only takes effect between
  // batches, so a stopped run is still finishing its current batch when the next one
  // starts, and writing to `job` meant the old loop kept incrementing the NEW run's
  // counters and re-asking Drive for properties it had already done.
  const me = {
    total: 0, done: 0, created: 0, reused: 0, failed: 0,
    error: null, stopped: false, startedAt: Date.now(), counting: true,
    lastError: null, finished: false,
  };
  job = me;

  me.promise = (async () => {
    try {
      if (drive.driveMode() !== 'live') {
        me.error = 'Drive is not connected, so no folders can be created yet.';
        return;
      }
      const rows = await q.withoutDriveFolder();
      if (job !== me) return;                  // superseded while counting
      me.total = rows.length;
      me.counting = false;
      if (!rows.length) return;

      for (let i = 0; i < rows.length; i += BATCH) {
        if (me.stopped || job !== me) break;
        const batch = rows.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async row => {
          try { return { row, r: await drive.createFolderFor(row) }; }
          catch (e) { return { row, r: { error: e.message } }; }
        }));
        if (job !== me) return;                // a newer run owns the counters now

        for (const { row, r } of results) {
          if (r.error) {
            me.failed++;
            // Keep the last reason rather than a count alone: "12 failed" tells him
            // nothing he can act on, and these fail for one reason at a time.
            me.lastError = r.error;
          } else {
            if (r.created) me.created++; else me.reused++;
            try { await q.setDriveFolder(row.id, r.folderId, r.folderUrl); }
            catch (e) { me.lastError = e.message; }
          }
          me.done++;
        }
        if (i + BATCH < rows.length) await new Promise(r => setTimeout(r, PAUSE_MS));
      }
    } catch (e) {
      me.error = e.message;
      console.error('[folder-job]', e);
    } finally {
      me.counting = false;
      if (!me.error && !me.stopped) me.done = me.total;
      me.finished = true;
      if (onDone && job === me) { try { await onDone(snapshot()); } catch {} }
    }
  })();

  return snapshot();
}

function status() { return snapshot(); }
function stop() { if (!job) return null; job.stopped = true; return snapshot(); }

module.exports = { start, status, stop, isRunning, BATCH };
