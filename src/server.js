const express = require('express');
const path = require('path');
const { q, init } = require('./db');
const { runCollector, processApproved } = require('./pipeline');
const { driveMode } = require('./drive');
const auth = require('./auth');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// small wrapper so any async route error becomes a clean 500 instead of a hang
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(req.method, req.path, e.message);
  res.status(500).json({ error: e.message });
});

// Attach req.user on every request (null if not logged in). attachUser is a
// 3-arg middleware and already swallows its own errors, so it is used directly
// (not via wrap, which only passes req/res).
app.use(auth.attachUser);

// ---- auth routes ----
// Register. The very first account becomes the admin (owner); after that, only an
// admin can create accounts, and they choose the new user's role.
app.post('/api/auth/register', wrap(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const existingCount = await q.countUsers();
  let assignedRole;
  if (existingCount === 0) {
    assignedRole = 'admin'; // first user = owner
  } else {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'only an admin can add users' });
    assignedRole = role === 'admin' ? 'admin' : 'member';
  }
  const user = await q.createUser(email, name, auth.hashPassword(password), assignedRole);
  if (!user) return res.status(409).json({ error: 'that email already exists' });
  // log the first (owner) user straight in; admins adding others stay logged in as themselves
  if (existingCount === 0) await auth.issueSession(res, user.id);
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await q.getUserByEmail(email);
  if (!user || !auth.verifyPassword(password, user.pass_hash)) {
    return res.status(401).json({ error: 'wrong email or password' });
  }
  await auth.issueSession(res, user.id);
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  if (req.sessionToken) await q.deleteSession(req.sessionToken);
  res.clearCookie(auth.COOKIE);
  res.json({ ok: true });
}));

// Who am I — the frontend calls this on load to decide login vs app.
// needsSetup=true means no users exist yet (show "create owner account").
app.get('/api/auth/me', wrap(async (req, res) => {
  res.json({ user: req.user || null, needsSetup: (await q.countUsers()) === 0 });
}));

// Admin: list / add team members.
app.get('/api/auth/users', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await q.listUsers());
}));

// Everything below requires a logged-in user. (Auth routes above are public.)
// ---- state summary for dashboard ----
app.get('/api/summary', auth.requireAuth, wrap(async (req, res) => {
  res.json({ counts: await q.counts(), driveMode: driveMode(), build: 'pg-1' });
}));

// ---- review queue (swipe) ----
app.get('/api/queue', auth.requireAuth, wrap(async (req, res) => res.json(await q.queue())));

// ---- listings by spec / all / ready / one ----
app.get('/api/listings', auth.requireAuth, wrap(async (req, res) => {
  const { spec, status } = req.query;
  let rows = await q.all();
  if (spec) rows = rows.filter(r => r.spec === spec);
  if (status) rows = rows.filter(r => r.status === status);
  res.json(rows);
}));
app.get('/api/ready', auth.requireAuth, wrap(async (req, res) => res.json(await q.ready())));
app.get('/api/listing/:id', auth.requireAuth, wrap(async (req, res) => {
  const l = await q.get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  res.json(l);
}));

// ---- swipe: approve / pass ----
app.post('/api/listing/:id/pass', auth.requireAuth, wrap(async (req, res) => {
  const l = await q.setStatus(+req.params.id, 'passed');
  res.json(l);
}));
app.post('/api/listing/:id/approve', auth.requireAuth, wrap(async (req, res) => {
  const id = +req.params.id;
  const l = await q.setStatus(id, 'approved', { approved_at: new Date().toISOString() });
  if (!l) return res.status(404).json({ error: 'not found' });
  // kick processing async; client polls the listing/summary
  processApproved(id).catch(e => console.error('processApproved', id, e.message));
  res.json({ ok: true, id, status: 'approved' });
}));

// ---- run the collector on demand (admin only) ----
app.post('/api/collect', auth.requireAdmin, wrap(async (req, res) => {
  const limitPerSpec = Math.min(+(req.body?.limitPerSpec || 12), 40);
  const r = await runCollector({ limitPerSpec });
  res.json(r);
}));

// ---- reset (admin only) ----
app.post('/api/reset', auth.requireAdmin, wrap(async (req, res) => { await q.clearAll(); res.json({ ok: true }); }));

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
