// Authentication — email + password login with DB-backed sessions.
// No external deps: passwords are scrypt-hashed (Node crypto), sessions are random
// tokens stored in Postgres and carried in an httpOnly cookie. Two roles: 'admin'
// (the owner — full access, can manage users) and 'member' (limited).

const crypto = require('crypto');
const { q } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'esl_session';

// ---- password hashing (scrypt: salt:hash, hex) ----
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(plain, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- sessions ----
async function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await q.createSession(token, userId, expires.toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: SESSION_DAYS * 864e5,
  });
  return token;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Attaches req.user (or null). Non-blocking — routes decide what to require.
async function attachUser(req, _res, next) {
  try {
    const token = readCookie(req, COOKIE);
    req.sessionToken = token || null;
    req.user = token ? await q.getSessionUser(token) : null;
  } catch { req.user = null; }
  next();
}

// Gate: must be logged in.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  next();
}

// Gate: must be an admin (owner-level).
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

// First account created becomes the admin (the owner). Subsequent ones are members
// unless an admin creates them with a role.
async function bootstrapFirstAdminRole() {
  return (await q.countUsers()) === 0 ? 'admin' : 'member';
}

// ---- password reset tokens ----
// The raw token goes to the user (in the link); only its hash is stored, so the
// database never holds anything that can be replayed as a reset.
const RESET_MINUTES = 60;
function newResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: sha256(token) };
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

module.exports = {
  COOKIE, RESET_MINUTES,
  hashPassword, verifyPassword,
  issueSession, attachUser, requireAuth, requireAdmin,
  bootstrapFirstAdminRole,
  newResetToken, sha256,
};
