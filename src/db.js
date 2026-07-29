// DB layer — PostgreSQL (Neon) via the `pg` pool.
// Schema mirrors HIS full property field list so nothing he asked for is lost.
//
// Moved off node:sqlite to Postgres for durability (a managed DB that survives
// redeploys), concurrency (multiple users once roles land), and scale (7k+ imported
// rows, ~50 columns, richer filtering). Every query is async; callers await them.
//
// Connection: DATABASE_URL (Neon connection string). Required in production.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set — point it at the Neon connection string.');
}
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 8,
});

// JSON helpers — JSON columns are stored as TEXT (same shape as before) so nothing
// downstream changes; we stringify on write and parse on read.
const J = (v) => v == null ? null : JSON.stringify(v);
const P = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v; // already parsed
  try { return JSON.parse(v); } catch { return null; }
};

// One-time schema init. Called (and awaited) once at boot before serving.
let readyPromise = null;
function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source TEXT, source_url TEXT, mls_id TEXT, listing_id TEXT, property_id TEXT,
        spec TEXT,
        status TEXT DEFAULT 'in_review',
        title TEXT, address TEXT, street_line TEXT,
        country TEXT, state TEXT, county TEXT, city TEXT, neighborhood TEXT, area TEXT, zip TEXT,
        lat DOUBLE PRECISION, lng DOUBLE PRECISION, gated_community TEXT,
        beds INTEGER, baths REAL, full_baths INTEGER, sqft INTEGER, lot_acres REAL,
        floors REAL, parking INTEGER, year_built INTEGER,
        property_style TEXT, architect TEXT, color_palette TEXT, furnished TEXT, also_known_as TEXT,
        sleep_capacity INTEGER, stand_capacity INTEGER, seating_capacity INTEGER,
        price BIGINT, price_per_sqft INTEGER, is_rental BOOLEAN, hoa INTEGER,
        amenities TEXT,
        num_photos INTEGER, has_video BOOLEAN, description TEXT,
        is_redfin BOOLEAN, photo_group_code TEXT, photo_positions TEXT,
        photo_urls TEXT,
        photo_source TEXT,
        owner_info TEXT,
        enriched_by TEXT,
        drive_folder_id TEXT, drive_folder_url TEXT,
        images TEXT,
        last_updated TEXT, days_on_market INTEGER,
        created_at TIMESTAMPTZ DEFAULT now(),
        approved_at TEXT, ready_at TEXT,
        -- Identity is the PROPERTY (address), not the price: a re-list at a new price
        -- must NOT reappear as new. One row per real property.
        UNIQUE (street_line, city)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        started_at TIMESTAMPTZ DEFAULT now(),
        sourced INTEGER DEFAULT 0, kept INTEGER DEFAULT 0, note TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

      -- Auth: users + sessions. role is 'admin' (full access, e.g. the owner) or
      -- 'member' (limited). Passwords are scrypt-hashed (salt:hash), never plain.
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        pass_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
  })();
  return readyPromise;
}

async function upsertListing(r) {
  const res = await pool.query(
    `INSERT INTO listings (source, source_url, mls_id, listing_id, property_id, spec, status,
       title, address, street_line, country, state, county, city, neighborhood, area, zip, lat, lng, gated_community,
       beds, baths, full_baths, sqft, lot_acres, floors, parking, year_built,
       property_style, architect, color_palette, furnished, also_known_as,
       sleep_capacity, stand_capacity, seating_capacity,
       price, price_per_sqft, is_rental, hoa, amenities, num_photos, has_video, description, owner_info,
       is_redfin, photo_group_code, photo_positions, photo_urls,
       enriched_by, last_updated, days_on_market)
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28, $29,$30,$31,$32,$33, $34,$35,$36,
             $37,$38,$39,$40,$41,$42,$43,$44,$45, $46,$47,$48,$49, $50,$51,$52)
     ON CONFLICT (street_line, city) DO NOTHING`,
    [
      r.source, r.sourceUrl, r.mlsId, r.listingId != null ? String(r.listingId) : null, r.propertyId != null ? String(r.propertyId) : null, r.spec, 'in_review',
      r.title, r.address, r.streetLine, r.country, r.state, r.county, r.city, r.neighborhood, r.area, r.zip != null ? String(r.zip) : null, r.lat, r.lng, r.gatedCommunity,
      r.beds, r.baths, r.fullBaths, r.sqft, r.lotAcres, r.floors, r.parking, r.yearBuilt,
      J(r.propertyStyle), r.architect, J(r.colorPalette), r.furnished, r.alsoKnownAs,
      r.sleepCapacity, r.standCapacity, r.seatingCapacity,
      r.price, r.pricePerSqft, !!r.isRental, r.hoa, J(r.amenities), r.numPhotos, !!r.hasVideo, r.description, r.ownerInfo,
      !!r.isRedfin, r.photoGroupCode, J(r.photoPositions), J(r.photoUrls),
      r.enrichedBy, r.lastUpdated, r.daysOnMarket,
    ]
  );
  return res.rowCount > 0;
}

function rowToApi(row) {
  if (!row) return null;
  return {
    ...row,
    is_rental: !!row.is_rental,
    has_video: !!row.has_video,
    is_redfin: !!row.is_redfin,
    property_style: P(row.property_style),
    color_palette: P(row.color_palette),
    amenities: P(row.amenities),
    images: P(row.images),
    photoGroupCode: row.photo_group_code || null,
    photoPositions: P(row.photo_positions),
    photoUrls: P(row.photo_urls),
  };
}

const q = {
  async counts() {
    const { rows } = await pool.query(`SELECT status, COUNT(*)::int n FROM listings GROUP BY status`);
    const m = { in_review: 0, approved: 0, passed: 0, processing: 0, ready: 0, live: 0 };
    for (const r of rows) m[r.status] = r.n;
    const total = await pool.query(`SELECT COUNT(*)::int n FROM listings`);
    m.sourced = total.rows[0].n;
    return m;
  },
  async queue() {
    const { rows } = await pool.query(`SELECT * FROM listings WHERE status='in_review' ORDER BY price DESC NULLS LAST`);
    return rows.map(rowToApi);
  },
  async bySpec(spec) {
    const { rows } = await pool.query(`SELECT * FROM listings WHERE spec=$1 ORDER BY price DESC NULLS LAST`, [spec]);
    return rows.map(rowToApi);
  },
  async ready() {
    const { rows } = await pool.query(`SELECT * FROM listings WHERE status IN ('ready','live','processing') ORDER BY ready_at DESC NULLS LAST, price DESC NULLS LAST`);
    return rows.map(rowToApi);
  },
  async get(id) {
    const { rows } = await pool.query(`SELECT * FROM listings WHERE id=$1`, [id]);
    return rowToApi(rows[0]);
  },
  async all() {
    const { rows } = await pool.query(`SELECT * FROM listings ORDER BY price DESC NULLS LAST`);
    return rows.map(rowToApi);
  },
  async setStatus(id, status, extra = {}) {
    const sets = ['status=$1']; const vals = [status];
    let i = 2;
    if (extra.approved_at) { sets.push(`approved_at=$${i++}`); vals.push(extra.approved_at); }
    if (extra.ready_at) { sets.push(`ready_at=$${i++}`); vals.push(extra.ready_at); }
    if (extra.drive_folder_id) { sets.push(`drive_folder_id=$${i++}`); vals.push(extra.drive_folder_id); }
    if (extra.drive_folder_url) { sets.push(`drive_folder_url=$${i++}`); vals.push(extra.drive_folder_url); }
    if (extra.images) { sets.push(`images=$${i++}`); vals.push(J(extra.images)); }
    vals.push(id);
    await pool.query(`UPDATE listings SET ${sets.join(', ')} WHERE id=$${i}`, vals);
    return q.get(id);
  },
  async newRun(sourced, kept, note) {
    await pool.query(`INSERT INTO runs (sourced, kept, note) VALUES ($1,$2,$3)`, [sourced, kept, note]);
  },
  async clearAll() {
    await pool.query(`DELETE FROM listings`);
    await pool.query(`DELETE FROM runs`);
  },

  // ---- auth ----
  async countUsers() {
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM users`);
    return rows[0].n;
  },
  async createUser(email, name, passHash, role) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, pass_hash, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role`,
      [email.toLowerCase().trim(), name || null, passHash, role || 'member']
    );
    return rows[0] || null;
  },
  async getUserByEmail(email) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email.toLowerCase().trim()]);
    return rows[0] || null;
  },
  async listUsers() {
    const { rows } = await pool.query(`SELECT id, email, name, role, created_at FROM users ORDER BY created_at`);
    return rows;
  },
  async createSession(token, userId, expiresAt) {
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, userId, expiresAt]);
  },
  async getSessionUser(token) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token=$1 AND s.expires_at > now()`,
      [token]
    );
    return rows[0] || null;
  },
  async deleteSession(token) {
    await pool.query(`DELETE FROM sessions WHERE token=$1`, [token]);
  },
  async getUserById(id) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
    return rows[0] || null;
  },
  async updatePassword(userId, passHash) {
    await pool.query(`UPDATE users SET pass_hash=$1 WHERE id=$2`, [passHash, userId]);
  },
  async deleteUserSessions(userId, keepToken) {
    // invalidate all OTHER sessions after a password change (keep the current one)
    await pool.query(`DELETE FROM sessions WHERE user_id=$1 AND token <> $2`, [userId, keepToken || '']);
  },
};

module.exports = { pool, init, upsertListing, q };
