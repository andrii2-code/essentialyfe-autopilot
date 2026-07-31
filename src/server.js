const express = require('express');
const path = require('path');
const { q, init } = require('./db');
const { runCollector, processApproved } = require('./pipeline');
const { driveMode } = require('./drive');
const auth = require('./auth');
const mailer = require('./mailer');
const fields = require('./fields');
const digest = require('./digest');
const scheduler = require('./scheduler');

// Admins always see the sensitive columns; members only when he grants it.
const canViewSensitive = (user) => !!user && (user.role === 'admin' || user.can_view_sensitive === true);

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
  const { email, password, name, role, canViewSensitive: cvs } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const existingCount = await q.countUsers();
  let assignedRole;
  if (existingCount === 0) {
    assignedRole = 'admin'; // first user = owner
  } else {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'only an admin can add users' });
    assignedRole = role === 'admin' ? 'admin' : 'member';
  }
  const user = await q.createUser(email, name, auth.hashPassword(password), assignedRole, !!cvs);
  if (!user) return res.status(409).json({ error: 'that email already exists' });
  // log the first (owner) user straight in; admins adding others stay logged in as themselves
  if (existingCount === 0) await auth.issueSession(res, user.id);
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role,
             can_view_sensitive: user.can_view_sensitive });
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

// Change my own password. Requires the current password; on success it rotates
// the hash and signs out every OTHER session (the current one stays valid).
app.post('/api/auth/password', auth.requireAuth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'current and new password required' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
  const user = await q.getUserById(req.user.id);
  if (!user || !auth.verifyPassword(currentPassword, user.pass_hash)) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  await q.updatePassword(user.id, auth.hashPassword(newPassword));
  await q.deleteUserSessions(user.id, req.sessionToken); // keep me signed in, drop others
  res.json({ ok: true });
}));

// ---- forgot / reset password ----
// Step 1: request a reset link. Always replies 200 with the same message whether or
// not the email exists (so this cannot be used to discover who has an account).
app.post('/api/auth/forgot', wrap(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const generic = { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  if (!email) return res.status(400).json({ error: 'email required' });

  const user = await q.getUserByEmail(email);
  if (!user) return res.json(generic);

  const { token, tokenHash } = auth.newResetToken();
  const expires = new Date(Date.now() + auth.RESET_MINUTES * 60000);
  await q.createPasswordReset(tokenHash, user.id, expires.toISOString());

  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${base}/?reset=${token}`;
  const mail = await mailer.send({
    to: user.email,
    subject: 'Reset your EssentiaLyfe password',
    text: `Someone asked to reset the password for this EssentiaLyfe account.\n\n`
      + `Open this link to choose a new password (valid for ${auth.RESET_MINUTES} minutes, one use):\n${link}\n\n`
      + `If this wasn't you, ignore this email — nothing has changed.`,
  });

  // Until SMTP is configured the link cannot be emailed. Rather than fail silently,
  // return it directly IF the caller proves owner access with the recovery key
  // (OWNER_RECOVERY_KEY env var). Without that key the response stays generic.
  const key = process.env.OWNER_RECOVERY_KEY;
  if (!mail.delivered && key && req.body?.recoveryKey === key) {
    return res.json({ ...generic, emailed: false, resetUrl: link });
  }
  res.json({ ...generic, emailed: mail.delivered });
}));

// Step 2: check a token is still good (so the UI can show the form or an error).
app.get('/api/auth/reset/check', wrap(async (req, res) => {
  const rec = await q.getPasswordReset(auth.sha256(req.query.token || ''));
  res.json({ valid: !!rec, email: rec?.email || null });
}));

// Step 3: set the new password. Consumes the token (single use) and signs out every
// session for that user, so anyone holding the old password is logged out.
app.post('/api/auth/reset', wrap(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'token and new password required' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });

  const tokenHash = auth.sha256(token);
  const rec = await q.getPasswordReset(tokenHash);
  if (!rec) return res.status(400).json({ error: 'this reset link is invalid or has expired' });
  // Consume first: if two requests race, only one wins.
  if (!(await q.consumePasswordReset(tokenHash))) {
    return res.status(400).json({ error: 'this reset link has already been used' });
  }

  await q.updatePassword(rec.user_id, auth.hashPassword(newPassword));
  await q.deleteAllUserSessions(rec.user_id);
  await auth.issueSession(res, rec.user_id); // log them straight in
  const user = await q.getUserById(rec.user_id);
  res.json({ ok: true, id: user.id, email: user.email, name: user.name, role: user.role });
}));

// Admin: list / add team members.
app.get('/api/auth/users', auth.requireAdmin, wrap(async (req, res) => {
  res.json(await q.listUsers());
}));

// Admin: change a team member's role / sensitive-field access.
app.patch('/api/auth/users/:id', auth.requireAdmin, wrap(async (req, res) => {
  const id = +req.params.id;
  const target = await q.getUserById(id);
  if (!target) return res.status(404).json({ error: 'no such user' });
  const { role, canViewSensitive: cvs } = req.body || {};
  // Don't let the last admin demote themselves and lock everyone out of user management.
  if (target.role === 'admin' && role === 'member' && (await q.countAdmins()) <= 1) {
    return res.status(400).json({ error: 'you are the only admin — promote someone else first' });
  }
  const updated = await q.updateUserAccess(id, { role, canViewSensitive: cvs });
  res.json({ id: updated.id, email: updated.email, name: updated.name, role: updated.role,
             can_view_sensitive: updated.can_view_sensitive });
}));

// Admin: remove a team member.
app.delete('/api/auth/users/:id', auth.requireAdmin, wrap(async (req, res) => {
  const id = +req.params.id;
  // Compare as strings: BIGINT ids come back from pg as strings, so a numeric ===
  // would never match and an admin could delete their own account.
  if (String(id) === String(req.user.id)) {
    return res.status(400).json({ error: "you can't remove your own account" });
  }
  const target = await q.getUserById(id);
  if (!target) return res.status(404).json({ error: 'no such user' });
  if (target.role === 'admin' && (await q.countAdmins()) <= 1) {
    return res.status(400).json({ error: 'that is the only admin account' });
  }
  await q.deleteUser(id);
  res.json({ ok: true });
}));

// Admin: send a reset link to a team member who is locked out.
app.post('/api/auth/users/:id/reset-link', auth.requireAdmin, wrap(async (req, res) => {
  const user = await q.getUserById(+req.params.id);
  if (!user) return res.status(404).json({ error: 'no such user' });
  const { token, tokenHash } = auth.newResetToken();
  await q.createPasswordReset(tokenHash, user.id, new Date(Date.now() + auth.RESET_MINUTES * 60000).toISOString());
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${base}/?reset=${token}`;
  const mail = await mailer.send({
    to: user.email,
    subject: 'Your EssentiaLyfe password reset',
    text: `An admin started a password reset for your EssentiaLyfe account.\n\n`
      + `Open this link to choose a new password (valid for ${auth.RESET_MINUTES} minutes):\n${link}`,
  });
  // An admin is already trusted, so hand back the link when email isn't wired up —
  // that way they can pass it to the person directly.
  res.json({ ok: true, emailed: mail.delivered, resetUrl: mail.delivered ? undefined : link });
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
  const canSee = canViewSensitive(req.user);
  res.json(rows.map(r => fields.redact(r, canSee)));
}));
app.get('/api/ready', auth.requireAuth, wrap(async (req, res) => res.json(await q.ready())));

// The editable field definitions, so the UI builds the form from the same source the
// database and validation use. `canEditSensitive` tells the client whether to render
// the Contacts / Private sections at all.
// Everything he can put in the property table as a column — feed data and his own
// fields together. The table builds its column picker from this.
app.get('/api/columns', auth.requireAuth, wrap(async (req, res) => {
  res.json({ columns: fields.columnCatalogue({ canViewSensitive: canViewSensitive(req.user) }) });
}));

app.get('/api/fields', auth.requireAuth, wrap(async (req, res) => {
  const canSee = canViewSensitive(req.user);
  res.json({
    fields: fields.FIELDS.filter(f => canSee || !f.sensitive),
    groups: fields.GROUPS.filter(g => canSee || !fields.FIELDS.some(f => f.group === g && f.sensitive)),
    canViewSensitive: canSee,
  });
}));

app.get('/api/listing/:id', auth.requireAuth, wrap(async (req, res) => {
  const l = await q.get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  res.json(fields.redact(l, canViewSensitive(req.user)));
}));

// Save his manual field edits. Only keys from fields.js are accepted; a member without
// sensitive access silently cannot write those columns even by crafting the request.
app.patch('/api/listing/:id', auth.requireAuth, wrap(async (req, res) => {
  const id = +req.params.id;
  if (!(await q.get(id))) return res.status(404).json({ error: 'not found' });
  const { updated, listing } = await q.updateFields(id, req.body || {}, {
    allowSensitive: canViewSensitive(req.user),
  });
  res.json({ ok: true, updated, listing: fields.redact(listing, canViewSensitive(req.user)) });
}));

// ---- swipe: approve / pass ----
app.post('/api/listing/:id/pass', auth.requireAuth, wrap(async (req, res) => {
  const l = await q.setStatus(+req.params.id, 'passed');
  res.json(l);
}));
app.post('/api/listing/:id/approve', auth.requireAuth, wrap(async (req, res) => {
  const id = +req.params.id;
  const existing = await q.get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // Already approved? Do NOT run the image pipeline again. Every run creates a fresh
  // Drive folder, so a second Like on an approved property duplicated the photos in
  // Drive. Re-liking is now a no-op that reports the state it is already in.
  if (['approved', 'processing', 'ready', 'live'].includes(existing.status)) {
    return res.json({
      ok: true, id, status: existing.status, alreadyApproved: true,
      message: existing.status === 'processing'
        ? 'Already approved — the images are still being processed.'
        : 'Already approved — the images are in your Drive.',
    });
  }

  const l = await q.setStatus(id, 'approved', { approved_at: new Date().toISOString() });
  if (!l) return res.status(404).json({ error: 'not found' });
  // kick processing async; client polls the listing/summary
  processApproved(id).catch(e => console.error('processApproved', id, e.message));
  res.json({ ok: true, id, status: 'approved' });
}));

// ---- price monitoring ----
// Known properties whose price moved. ?drops=1 for reductions only.
app.get('/api/price-changes', auth.requireAuth, wrap(async (req, res) => {
  const days = Math.min(Math.max(+(req.query.days || 30), 1), 365);
  const rows = await q.priceChanges({ days, onlyDrops: req.query.drops === '1' });
  const canSee = canViewSensitive(req.user);
  res.json(rows.map(r => fields.redact(r, canSee)));
}));

// ---- daily email ----
// What the next email would contain. Counts only by default — the dashboard shows one
// line, so rendering the full HTML for that would be ~14KB of waste on every load.
// ?html=1 when the whole email body is actually wanted.
app.get('/api/digest/preview', auth.requireAdmin, wrap(async (req, res) => {
  const days = Math.min(Math.max(+(req.query.days || 1), 1), 90);
  if (req.query.html === '1') {
    const contents = await q.digestContents({ days });
    return res.json({
      newCount: contents.newListings.length,
      priceChangeCount: contents.priceChanges.length,
      subject: digest.subjectFor(contents),
      html: digest.renderHtml(contents),
      mailMode: mailer.mailMode(),
    });
  }
  const counts = await q.digestCounts({ days });
  res.json({ ...counts, mailMode: mailer.mailMode() });
}));

// Send it now — to himself by default, so testing never mails the whole team.
app.post('/api/digest/send', auth.requireAdmin, wrap(async (req, res) => {
  const days = Math.min(Math.max(+(req.body?.days || 1), 1), 90);
  const toMe = req.body?.toMe !== false;
  const r = await digest.sendDigest({
    days,
    force: req.body?.force !== false,
    to: toMe ? req.user.email : null,
  });
  res.json(r);
}));

// ---- automation (all-day collector + daily email) ----
app.get('/api/automation', auth.requireAdmin, wrap(async (req, res) => {
  res.json({ ...(await scheduler.status()), mailMode: mailer.mailMode() });
}));

// Turn either job on/off and adjust its cadence. Stored in the database, so a redeploy
// keeps his choice — in particular, the collector stays OFF until he switches it on.
app.patch('/api/automation', auth.requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const num = (v, lo, hi) => Math.min(Math.max(Math.round(Number(v)), lo), hi);

  if (typeof b.collectorEnabled === 'boolean') await q.setSetting('collector.enabled', b.collectorEnabled);
  if (b.intervalMin != null) await q.setSetting('collector.intervalMin', num(b.intervalMin, 15, 1440));
  if (b.limitPerSpec != null) await q.setSetting('collector.limitPerSpec', num(b.limitPerSpec, 1, 40));
  if (typeof b.digestEnabled === 'boolean') await q.setSetting('digest.enabled', b.digestEnabled);
  // The send hour is his local time (Pacific). Clear any legacy UTC value so it can't
  // win the fallback in sendHourPT().
  if (b.hourPT != null) {
    await q.setSetting('digest.hourPT', num(b.hourPT, 0, 23));
    await q.deleteSetting('digest.hourUTC');   // drop the legacy value so it can't win
  }

  res.json(await scheduler.status());
}));

// ---- run the collector on demand (admin only) ----
app.post('/api/collect', auth.requireAdmin, wrap(async (req, res) => {
  // Goes through the scheduler so a manual pass also stamps lastRunAt — otherwise the
  // automatic one could fire again seconds later and spend API calls twice.
  const r = await scheduler.runCollectorPass({ manual: true });
  res.json(r);
}));

// ---- reset (admin only) ----
app.post('/api/reset', auth.requireAdmin, wrap(async (req, res) => { await q.clearAll(); res.json({ ok: true }); }));

// On boot, if the queue is empty, pull a first batch so the app is never blank.
// This costs real API calls, so it only runs when automation is switched on —
// otherwise a redeploy would quietly spend quota while the collector is paused.
async function seedIfEmpty() {
  try {
    if (!(await q.getSetting('collector.enabled', false))) {
      console.log('[boot] collector is paused — skipping the seed pass');
      return;
    }
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
        scheduler.start();   // all-day collector + daily email
      });
    })
    .catch((e) => { console.error('[boot] DB init failed:', e.message); process.exit(1); });
}
module.exports = app;
