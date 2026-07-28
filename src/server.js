const express = require('express');
const path = require('path');
const { q } = require('./db');
const { runCollector, processApproved } = require('./pipeline');
const { driveMode } = require('./drive');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- state summary for dashboard ----
app.get('/api/summary', (req, res) => {
  res.json({ counts: q.counts(), driveMode: driveMode(), build: 'hybrid-photos-1' });
});

// ---- review queue (swipe) ----
app.get('/api/queue', (req, res) => res.json(q.queue()));

// ---- listings by spec / all / ready / one ----
app.get('/api/listings', (req, res) => {
  const { spec, status } = req.query;
  let rows = q.all();
  if (spec) rows = rows.filter(r => r.spec === spec);
  if (status) rows = rows.filter(r => r.status === status);
  res.json(rows);
});
app.get('/api/ready', (req, res) => res.json(q.ready()));
app.get('/api/listing/:id', (req, res) => {
  const l = q.get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  res.json(l);
});

// ---- swipe: approve / pass ----
app.post('/api/listing/:id/pass', (req, res) => {
  const l = q.setStatus(+req.params.id, 'passed');
  res.json(l);
});
app.post('/api/listing/:id/approve', async (req, res) => {
  const id = +req.params.id;
  const l = q.setStatus(id, 'approved', { approved_at: new Date().toISOString() });
  if (!l) return res.status(404).json({ error: 'not found' });
  // kick processing async; client polls the listing/summary
  processApproved(id).catch(e => console.error('processApproved', id, e.message));
  res.json({ ok: true, id, status: 'approved' });
});

// ---- run the collector on demand (also simulates the all-day cron) ----
app.post('/api/collect', async (req, res) => {
  try {
    const limitPerSpec = Math.min(+(req.body?.limitPerSpec || 12), 40);
    const r = await runCollector({ limitPerSpec });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- reset (demo convenience) ----
app.post('/api/reset', (req, res) => { q.clearAll(); res.json({ ok: true }); });

// ---- TEMP: tag diagnostic (remove after verifying the vague-tag fix) ----
app.get('/api/_diagtags', async (req, res) => {
  try {
    const { diagTags } = require('./realtor');
    res.json(await diagTags(req.query.spec, req.query.loc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// On boot, if the queue is empty, pull a first real batch so the live app is
// never blank. Runs in the background; the collector also runs on demand + could
// be put on a cron for the "all-day" behaviour.
async function seedIfEmpty() {
  try {
    const c = q.counts();
    if (c.sourced === 0) {
      console.log('[boot] empty DB — running first collector pass…');
      const r = await runCollector({ limitPerSpec: 10 });
      console.log('[boot] seeded:', JSON.stringify(r));
    }
  } catch (e) { console.error('[boot] seed failed:', e.message); }
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EssentiaLyfe running on http://localhost:${PORT}`);
    seedIfEmpty();
  });
}
module.exports = app;
