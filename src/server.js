const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { q, init, importListings } = require('./db');
const importer = require('./import');
const enrichPhotos = require('./photo-enrich');
const drivePhotos = require('./drive-photos');
const photoJob = require('./photo-job');
const { runCollector, processApproved } = require('./pipeline');
const { driveMode, fetchDriveFile } = require('./drive');
const auth = require('./auth');
const mailer = require('./mailer');
const fields = require('./fields');
const digest = require('./digest');
const scheduler = require('./scheduler');

// Admins always see the sensitive columns; members only when he grants it.
const canViewSensitive = (user) => !!user && (user.role === 'admin' || user.can_view_sensitive === true);

// Parsed-but-not-yet-written imports, keyed by a token handed to the browser. Kept in
// memory deliberately: an import is a single sitting, and this avoids writing a 6,000
// row scratch copy to the database just to show him a preview.
const pendingImports = new Map();

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

  // Someone added to the team gets told about it. Previously the account was created
  // silently and the new person had no idea, so they were never actually invited.
  let invited = null;
  if (existingCount > 0) {
    const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const who = req.user?.name || req.user?.email || 'An administrator';
    const mail = await mailer.send({
      to: user.email,
      subject: 'You have been added to EssentiaLyfe',
      text: `${who} has given you access to EssentiaLyfe — Sourcing Autopilot.\n\n`
        + `Sign in here: ${base}\n`
        + `  email:    ${user.email}\n`
        + `  password: ${password}\n\n`
        + `Please change that password once you are in: click your name at the bottom of the\n`
        + `sidebar, then "Change password".`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <div style="background:#0f1b2d;padding:18px 22px;color:#fff">
      <div style="font-size:17px;font-weight:600">EssentiaLyfe</div>
      <div style="font-size:12px;color:#9fb0c4;margin-top:2px">Sourcing Autopilot</div>
    </div>
    <div style="padding:22px;font-size:14px;color:#1b2431;line-height:1.6">
      <p style="margin:0 0 14px">${String(who).replace(/[<>&]/g, '')} has given you access to EssentiaLyfe.</p>
      <table style="font-size:14px;margin:0 0 16px">
        <tr><td style="color:#7a8698;padding-right:12px">Email</td><td><b>${user.email}</b></td></tr>
        <tr><td style="color:#7a8698;padding-right:12px">Password</td><td><b>${String(password).replace(/[<>&]/g, '')}</b></td></tr>
      </table>
      <a href="${base}" style="display:inline-block;background:#c8a44d;color:#1a1300;text-decoration:none;
         font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Sign in</a>
      <p style="margin:16px 0 0;color:#7a8698;font-size:13px">Please change that password once you are in —
        click your name at the bottom of the sidebar, then "Change password".</p>
    </div>
  </div>
</div>`,
    });
    invited = { emailed: mail.delivered, to: user.email, error: mail.error || null };
  }

  res.json({ id: user.id, email: user.email, name: user.name, role: user.role,
             can_view_sensitive: user.can_view_sensitive, invited });
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
// The table needs one thumbnail per row, not the whole gallery. Same rule the browser
// used: the cleaned image if we have one, else the first real listing photo, else
// nothing (the client draws its own placeholder).
function thumbFor(r) {
  const images = Array.isArray(r.images) ? r.images : [];
  const i = images.findIndex(im => im && im.driveFileId);
  if (i >= 0) return `/api/listing/${r.id}/image/${i}`;
  const photos = Array.isArray(r.photoUrls) ? r.photoUrls : [];
  const first = photos.find(p => p && (typeof p === 'string' ? p : p.url));
  return first ? (typeof first === 'string' ? first : first.url) : null;
}

// Drop the arrays that make a row heavy. A property carries up to 50 photo URLs and 50
// cleaned-image records; at 6,735 rows that is ~139 MB, which is the multi-second wait
// he reported on the database page. The detail view fetches /api/listing/:id and still
// gets everything.
function forList(r) {
  const { photoUrls, images, photo_urls, photoPositions, photo_positions, ...rest } = r;
  return {
    ...rest,
    thumb: thumbFor(r),
    photoCount: (Array.isArray(images) ? images.length : 0)
      || (Array.isArray(photoUrls) ? photoUrls.length : 0),
  };
}

app.get('/api/listings', auth.requireAuth, wrap(async (req, res) => {
  const { spec, status, area, tier, sort } = req.query;
  const search = req.query.q || '';
  // limit=0 means every match — the CSV export needs that. Anything else is capped so a
  // stray value cannot ask for the whole table again.
  const raw = req.query.limit;
  const limit = raw === '0' ? 0 : Math.min(Number(raw) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const { rows, total } = await q.page({ limit, offset, q: search, status, area, tier, spec, sort });
  const canSee = canViewSensitive(req.user);
  const customDefs = await q.listCustomFields();
  res.json({ rows: rows.map(r => forList(redactAll(r, canSee, customDefs))), total });
}));

// The Area dropdown, read on its own so the filter no longer needs every property.
app.get('/api/listings/areas', auth.requireAuth, wrap(async (req, res) => {
  res.json(await q.areas());
}));
app.get('/api/ready', auth.requireAuth, wrap(async (req, res) => res.json(await q.ready())));

// The editable field definitions, so the UI builds the form from the same source the
// database and validation use. `canEditSensitive` tells the client whether to render
// the Contacts / Private sections at all.
// Everything he can put in the property table as a column — feed data, his built-in
// fields, and any field he has created himself.
app.get('/api/columns', auth.requireAuth, wrap(async (req, res) => {
  const canSee = canViewSensitive(req.user);
  const custom = (await q.listCustomFields())
    .filter(f => canSee || !f.sensitive)
    .map(f => ({ key: f.key, label: f.label, group: 'Your own fields', type: f.type,
                 editable: true, custom: true, sensitive: !!f.sensitive }));
  // A hidden field leaves the column picker as well, so "switched off" means one thing
  // everywhere rather than gone from the form but still offered as a column.
  const hidden = new Set(await q.getSetting('fields.hidden', []));
  const columns = [...fields.columnCatalogue({ canViewSensitive: canSee }), ...custom]
    .filter(c => !hidden.has(c.key));
  res.json({ columns, hidden: [...hidden] });
}));

// ---- fields he creates himself ----
// Turn what he types into a safe key. Prefixed so a custom field can never collide
// with a real database column or a built-in field name.
function customKeyFrom(label) {
  const slug = String(label).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return slug ? `cf_${slug}` : null;
}

// Fields he has switched off. Hiding is deliberately NOT a deletion: the column keeps
// its data, so turning one back on brings the values with it and an import never
// silently drops a column he happens to have hidden. It is stored on the account
// rather than in the browser, so his team sees the same form he does.
//
// Provenance and identity are not hideable — a property with no address, or one that
// will not say where it came from, is not something he can act on.
const NEVER_HIDE = new Set(['street_line', 'address', 'city', 'price', 'status', 'spec',
  'source', 'brokerage', 'mls_id', 'property_name']);

app.get('/api/hidden-fields', auth.requireAuth, wrap(async (req, res) => {
  res.json({ hidden: await q.getSetting('fields.hidden', []) });
}));

app.put('/api/hidden-fields', auth.requireAdmin, wrap(async (req, res) => {
  const wanted = Array.isArray(req.body?.hidden) ? req.body.hidden.map(String) : [];
  const hidden = [...new Set(wanted.filter(k => !NEVER_HIDE.has(k)))];
  await q.setSetting('fields.hidden', hidden);
  res.json({ hidden, refused: wanted.filter(k => NEVER_HIDE.has(k)) });
}));

app.get('/api/custom-fields', auth.requireAuth, wrap(async (req, res) => {
  const canSee = canViewSensitive(req.user);
  res.json((await q.listCustomFields()).filter(f => canSee || !f.sensitive));
}));

app.post('/api/custom-fields', auth.requireAdmin, wrap(async (req, res) => {
  const { label, type, options, sensitive } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'a name is required' });

  const allowed = ['text', 'textarea', 'number', 'money', 'select', 'date'];
  const t = allowed.includes(type) ? type : 'text';
  const key = customKeyFrom(label);
  if (!key) return res.status(400).json({ error: 'that name has no letters or numbers in it' });

  // Don't let a new field shadow one that already exists. Custom keys carry a cf_
  // prefix so they never literally collide with a built-in column, but a field NAMED
  // "Tier" or "Bed" would still sit in the form twice with no way to tell them apart —
  // so the check is on the visible name, not just the key.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wanted = norm(label);

  const existing = await q.listCustomFields();
  const clash = existing.find(f => f.key === key || norm(f.label) === wanted);
  if (clash) {
    return res.status(409).json({
      error: `You already have a field called "${clash.label}". Use it, or pick a different name.`,
    });
  }
  const builtIn = [...fields.FIELDS, ...fields.FEED_COLUMNS, ...fields.FEED_EDITABLE_FIELDS]
    .find(f => norm(f.label) === wanted || f.key === norm(label));
  if (builtIn) {
    return res.status(409).json({
      error: `"${builtIn.label}" is already a field on every property. Turn it on in Columns rather than adding it again.`,
    });
  }
  let opts;
  if (t === 'select') {
    opts = String(options || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!opts.length) return res.status(400).json({ error: 'a dropdown needs at least one choice' });
    opts.unshift('');   // allow "not set"
  }

  const created = await q.createCustomField({ key, label: String(label).trim(), type: t, options: opts, sensitive: !!sensitive });
  if (!created) return res.status(409).json({ error: 'that field already exists' });
  res.json({ ok: true, field: { ...created, options: opts, custom: true } });
}));

app.patch('/api/custom-fields/:key', auth.requireAdmin, wrap(async (req, res) => {
  const { label, sensitive } = req.body || {};
  const updated = await q.updateCustomField(req.params.key, { label, sensitive });
  if (!updated) return res.status(404).json({ error: 'no such field' });
  res.json({ ok: true, field: updated });
}));

// Deleting removes the field AND the values stored under it, on every property.
app.delete('/api/custom-fields/:key', auth.requireAdmin, wrap(async (req, res) => {
  const gone = await q.deleteCustomField(req.params.key);
  if (!gone) return res.status(404).json({ error: 'no such field' });
  res.json({ ok: true });
}));

app.get('/api/fields', auth.requireAuth, wrap(async (req, res) => {
  const canSee = canViewSensitive(req.user);
  // The building's own facts come first: for an imported property there is no feed
  // behind them, so he is the only one who can correct a blank year built or a wrong
  // bed count. His commercial fields follow.
  const hidden = new Set(await q.getSetting('fields.hidden', []));
  const all = [...fields.FEED_EDITABLE_FIELDS, ...fields.FIELDS.filter(f => canSee || !f.sensitive)]
    .filter(f => !hidden.has(f.key));
  res.json({
    fields: all,
    // A group with nothing left in it should not leave an empty heading behind.
    groups: ['Property facts',
      ...fields.GROUPS.filter(g => canSee || !fields.FIELDS.some(f => f.group === g && f.sensitive))]
      .filter(g => all.some(f => f.group === g)),
    hidden: [...hidden],
    canViewSensitive: canSee,
  });
}));

app.get('/api/listing/:id', auth.requireAuth, wrap(async (req, res) => {
  const l = await q.get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  res.json(redactAll(l, canViewSensitive(req.user), await q.listCustomFields()));
}));

// Save his manual field edits. Only keys from fields.js are accepted; a member without
// sensitive access silently cannot write those columns even by crafting the request.
app.patch('/api/listing/:id', auth.requireAuth, wrap(async (req, res) => {
  const id = +req.params.id;
  if (!(await q.get(id))) return res.status(404).json({ error: 'not found' });
  const canSee = canViewSensitive(req.user);
  const body = req.body || {};

  // Split his own custom fields out: they live in a JSON column, not their own columns.
  const customDefs = await q.listCustomFields();
  const byKey = new Map(customDefs.map(f => [f.key, f]));
  const builtin = {}, customPatch = {};
  for (const [k, v] of Object.entries(body)) {
    const def = byKey.get(k);
    if (!def) { builtin[k] = v; continue; }
    if (def.sensitive && !canSee) continue;    // same gate as the built-in fields
    customPatch[k] = customValue(def, v);
  }

  const { updated, listing } = await q.updateFields(id, builtin, { allowSensitive: canSee });
  let extra = 0;
  if (Object.keys(customPatch).length) {
    await q.updateCustomValues(id, customPatch);
    extra = Object.keys(customPatch).length;
  }
  const fresh = extra ? await q.get(id) : listing;
  res.json({ ok: true, updated: updated + extra, listing: redactAll(fresh, canSee, customDefs) });
}));

// Coerce a custom value the same way the built-in fields are coerced, so "$1,200"
// stored in a money field is a number and a dropdown can only hold its own options.
function customValue(def, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (def.type === 'money' || def.type === 'number') {
    const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
    if (!/\d/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (def.type === 'select') {
    const v = String(raw).trim().toLowerCase();
    return (def.options || []).find(o => String(o).toLowerCase() === v) || null;
  }
  if (def.type === 'date') {
    const s = String(raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  return String(raw).trim();
}

// Redact built-in sensitive fields AND any custom field he marked restricted.
function redactAll(listing, canSee, customDefs) {
  const out = fields.redact(listing, canSee);
  if (!out || canSee) return out;
  for (const f of customDefs) if (f.sensitive) delete out[f.key];
  return out;
}

// ---- cleaned images ----
// Serves the PROCESSED photo (watermark removed, address blurred, tagged, resized)
// rather than the original listing URL. Without this the app could only show the
// source photo, so what he saw and downloaded still had the MLS logo on it.
const imageCache = new Map();   // fileId -> Buffer, so a gallery doesn't refetch per view
app.get('/api/listing/:id/image/:idx', auth.requireAuth, wrap(async (req, res) => {
  const l = await q.get(+req.params.id);
  if (!l) return res.status(404).json({ error: 'not found' });
  const im = (l.images || [])[+req.params.idx];
  if (!im || !im.driveFileId) return res.status(404).json({ error: 'no processed image' });

  let buf = imageCache.get(im.driveFileId);
  if (!buf) {
    buf = await fetchDriveFile(im.driveFileId);
    if (!buf) return res.status(404).json({ error: 'could not fetch the processed image' });
    if (imageCache.size > 200) imageCache.clear();   // crude bound; these are large
    imageCache.set(im.driveFileId, buf);
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buf);
}));

// Serve any Drive image by id. His own photo folders are shared with him, not with
// whoever is looking at the app, so a direct Drive URL in an <img> renders as a broken
// image for everyone else. Proxying through here means the app's own credentials do
// the fetching and the browser just gets JPEG bytes.
app.get('/api/drive-image/:fileId', auth.requireAuth, wrap(async (req, res) => {
  const id = String(req.params.fileId);
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return res.status(400).json({ error: 'bad file id' });

  let buf = imageCache.get(id);
  if (!buf) {
    buf = await fetchDriveFile(id);
    if (!buf) return res.status(404).json({ error: 'could not fetch that image' });
    if (imageCache.size > 200) imageCache.clear();
    imageCache.set(id, buf);
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(buf);
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
  const customDefs = await q.listCustomFields();
  res.json(rows.map(r => redactAll(r, canSee, customDefs)));
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
  // DIGEST_TEST_TO redirects "Send it to me now" to one address, so the daily email can
  // be checked from an inbox we control without changing anyone's account. Unset it and
  // the button goes back to mailing whoever is signed in — no code change to undo.
  const testTo = (process.env.DIGEST_TEST_TO || '').trim() || null;
  const r = await digest.sendDigest({
    days,
    force: req.body?.force !== false,
    to: toMe ? (testTo || req.user.email) : null,
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

// ---- importing his own spreadsheet (admin only) ----
//
// Two steps on purpose. /preview parses the file and tells him what WOULD happen —
// how many properties, which of his columns were understood, how many links came
// across — and writes nothing. /commit then does the work. Nobody should hand 6,789
// rows to a database on the strength of a file picker.
const importRaw = express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'], limit: '80mb' });

app.post('/api/import/preview', auth.requireAdmin, importRaw, wrap(async (req, res) => {
  const filename = String(req.query.filename || '');
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file received' });
  let parsed;
  try {
    parsed = importer.parseWorkbook(req.body, { filename });
  } catch (e) {
    return res.status(400).json({ error: `Could not read that file: ${e.message}` });
  }
  // Hold the parsed rows for the commit step so the file is only uploaded once.
  const token = crypto.randomBytes(9).toString('hex');
  pendingImports.set(token, { rows: parsed.rows, at: Date.now(), filename });
  // Only ever keep the few most recent; these are big.
  for (const [k, v] of pendingImports) {
    if (Date.now() - v.at > 30 * 60 * 1000 || pendingImports.size > 3) pendingImports.delete(k);
  }
  const labelFor = (k) => (fields.byKey[k]?.label) || k;
  res.json({
    token,
    filename,
    summary: parsed.summary,
    mapped: parsed.mapped.map(m => ({ ...m, label: labelFor(m.key) })),
    unmapped: parsed.unmapped,
    duplicates: parsed.duplicates,
    sample: parsed.rows.slice(0, 3),
  });
}));

app.post('/api/import/commit', auth.requireAdmin, wrap(async (req, res) => {
  const token = String(req.body?.token || '');
  const held = pendingImports.get(token);
  if (!held) return res.status(400).json({ error: 'That upload has expired — choose the file again.' });
  pendingImports.delete(token);
  const r = await importListings(held.rows);
  await q.newRun(held.rows.length, r.inserted, `import: ${r.inserted} added, ${r.updated} updated from ${held.filename || 'spreadsheet'}`);

  // Photos start fetching on their own. His sheet links a folder rather than the
  // pictures, so an import that stopped here left stand-ins — which is what he saw,
  // and why there used to be a separate "Fetch photos" button. Doing it inline instead
  // would hold this request open past any sensible timeout on a 6,789-row file, so the
  // job runs in the background and the import panel polls it. No button, no row cap.
  let photos = null;
  try {
    photos = photoJob.start(q);
  } catch (e) { console.error('[import] photo job:', e.message); }
  res.json({ ...r, photos });
}));

// ---- photos for imported properties (admin only) ----
// Progress for the background job the import starts. The panel polls this so he can
// watch the pictures arrive instead of pressing a button and waiting on a spinner.
app.get('/api/import/photos', auth.requireAuth, wrap(async (req, res) => {
  const job = photoJob.status() || { running: false, total: 0, done: 0 };
  // The breakdown is what turns "2,000 none available" into causes he can act on:
  // a deleted Dropbox folder, no link in his sheet, or a lookup that never ran.
  let breakdown = [];
  try { breakdown = await q.photoFailureBreakdown(); } catch {}
  const retryable = breakdown.reduce((n, r) => n + (r.retryable || 0), 0);
  res.json({ ...job, breakdown, retryable });
}));

// A manual re-run, kept for the case his folders were unshared during the import and
// he has since fixed the sharing. It starts the same job rather than a second code
// path, and does nothing if one is already running.
app.post('/api/import/photos', auth.requireAdmin, wrap(async (req, res) => {
  // retryOnly is the run to make once the subscription is in: it works only the rows
  // the lookup never got to ask about, so the ones already ruled out are not paid for
  // a second time.
  const retryOnly = req.body?.retryOnly === true;
  res.json(photoJob.start(q, { retryOnly }) || { running: false, total: 0, done: 0 });
}));

// Stop a run in progress. Photos already fetched are kept, so starting again resumes
// from what is still missing rather than from the beginning.
app.post('/api/import/photos/stop', auth.requireAdmin, wrap(async (req, res) => {
  res.json(photoJob.stop() || { running: false, total: 0, done: 0 });
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
