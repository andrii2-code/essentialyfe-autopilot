const express = require('express');
const path = require('path');
const { q, init } = require('./db');
const { runCollector, processApproved } = require('./pipeline');
const { driveMode } = require('./drive');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// small wrapper so any async route error becomes a clean 500 instead of a hang
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(req.method, req.path, e.message);
  res.status(500).json({ error: e.message });
});

// ---- state summary for dashboard ----
app.get('/api/summary', wrap(async (req, res) => {
  res.json({ counts: await q.counts(), driveMode: driveMode(), build: 'pg-1' });
}));

// ---- review queue (swipe) ----
app.get('/api/queue', wrap(async (req, res) => res.json(await q.queue())));

// ---- listings by spec / all / ready / one ----
app.get('/api/listings', wrap(async (req, res) => {
  const { spec, status } = req.query;
  let rows = await q.all();
  if (spec) rows = rows.filter(r => r.spec === spec);
  if (status) rows = rows.filter(r => r.status === status);
  res.json(rows);
}));
app.get('/api/ready', wrap(async (req, res) => res.json(await q.ready())));
app.get('/api/listing/:id', wrap(async (req, res) => {
  const l = await q.get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  res.json(l);
}));

// ---- swipe: approve / pass ----
app.post('/api/listing/:id/pass', wrap(async (req, res) => {
  const l = await q.setStatus(+req.params.id, 'passed');
  res.json(l);
}));
app.post('/api/listing/:id/approve', wrap(async (req, res) => {
  const id = +req.params.id;
  const l = await q.setStatus(id, 'approved', { approved_at: new Date().toISOString() });
  if (!l) return res.status(404).json({ error: 'not found' });
  // kick processing async; client polls the listing/summary
  processApproved(id).catch(e => console.error('processApproved', id, e.message));
  res.json({ ok: true, id, status: 'approved' });
}));

// ---- run the collector on demand (also simulates the all-day cron) ----
app.post('/api/collect', wrap(async (req, res) => {
  const limitPerSpec = Math.min(+(req.body?.limitPerSpec || 12), 40);
  const r = await runCollector({ limitPerSpec });
  res.json(r);
}));

// ---- reset (demo convenience) ----
app.post('/api/reset', wrap(async (req, res) => { await q.clearAll(); res.json({ ok: true }); }));

// On boot, if the queue is empty, pull a first real batch so the live app is
// never blank. Runs in the background; the collector also runs on demand + could
// be put on a cron for the "all-day" behaviour.
async function seedIfEmpty() {
  try {
    const c = await q.counts();
    if (c.sourced === 0) {
      console.log('[boot] empty DB — running first collector pass…');
      const r = await runCollector({ limitPerSpec: 10 });
      console.log('[boot] seeded:', JSON.stringify(r));
    }
  } catch (e) { console.error('[boot] seed failed:', e.message); }
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  // Ensure the schema exists before serving, then boot.
  init()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`EssentiaLyfe running on http://localhost:${PORT}`);
        seedIfEmpty();
      });
    })
    .catch((e) => { console.error('[boot] DB init failed:', e.message); process.exit(1); });
}
module.exports = app;
