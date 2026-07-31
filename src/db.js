// DB layer — PostgreSQL (Neon) via the `pg` pool.
// Schema mirrors HIS full property field list so nothing he asked for is lost.
//
// Moved off node:sqlite to Postgres for durability (a managed DB that survives
// redeploys), concurrency (multiple users once roles land), and scale (7k+ imported
// rows, ~50 columns, richer filtering). Every query is async; callers await them.
//
// Connection: DATABASE_URL (Neon connection string). Required in production.

const { Pool } = require('pg');
const { alterStatements, FIELD_KEYS, coerce } = require('./fields');

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

      -- Password resets: single-use, short-lived tokens. Only the SHA-256 of the
      -- token is stored, so a database read cannot be replayed as a reset link.
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      );
    `);

    // His own operational fields (rates, contacts, owner temper, access…) are added
    // from the fields.js definition. ADD COLUMN IF NOT EXISTS makes this the migration
    // too, so an existing database picks them up on the next boot without a manual step.
    await pool.query(alterStatements('listings'));

    // Fields HE creates from the UI. Definitions live in a table (not in code), and the
    // values go in a JSON column on the listing rather than a new database column —
    // adding a column per field would mean letting the app run DDL on user input, and
    // would leave dead columns behind whenever he removed one.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custom_fields (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        options TEXT,
        sensitive BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS custom TEXT;
    `);

    // Per-user permission to see the sensitive fields. Admins always can; members only
    // if he grants it. Default false, so granting is a deliberate act.
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_sensitive BOOLEAN NOT NULL DEFAULT false;
    `);
    // Every admin can see everything by definition — keep the flag consistent with that.
    await pool.query(`UPDATE users SET can_view_sensitive = true WHERE role = 'admin' AND can_view_sensitive = false`);

    // Price monitoring: the previous price and when it changed, so a re-list at a new
    // price updates the row he already has instead of being thrown away as a duplicate.
    // "Previous vs current" is all he needs; a full history table would be heavier for
    // no extra answer.
    await pool.query(`
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS previous_price BIGINT;
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_changed_at TIMESTAMPTZ;
    `);

    // Digest bookkeeping — which listings have already been reported, so a second
    // send on the same day doesn't repeat itself.
    await pool.query(`
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;
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
     -- Identity is the property, so a re-list is the SAME row. If the price moved,
     -- record where it came from and when, and refresh the fields that go stale.
     -- His own manual fields are never touched here. The xmax = 0 test in the
     -- RETURNING clause distinguishes a fresh insert from an update of an existing row.
     ON CONFLICT (street_line, city) DO UPDATE SET
       previous_price = CASE WHEN EXCLUDED.price IS DISTINCT FROM listings.price
                             THEN listings.price ELSE listings.previous_price END,
       price_changed_at = CASE WHEN EXCLUDED.price IS DISTINCT FROM listings.price
                               THEN now() ELSE listings.price_changed_at END,
       price = COALESCE(EXCLUDED.price, listings.price),
       price_per_sqft = COALESCE(EXCLUDED.price_per_sqft, listings.price_per_sqft),
       last_updated = COALESCE(EXCLUDED.last_updated, listings.last_updated),
       days_on_market = COALESCE(EXCLUDED.days_on_market, listings.days_on_market),
       source_url = COALESCE(EXCLUDED.source_url, listings.source_url)
     WHERE EXCLUDED.price IS DISTINCT FROM listings.price
     RETURNING id, (xmax = 0) AS inserted, previous_price, price`,
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
  // Three outcomes, and the collector reports each differently:
  //   inserted        a property he has never seen
  //   priceChanged    one he already had, now listed at a different price
  //   (neither)       already known at the same price — nothing to say
  const row = res.rows[0];
  if (!row) return { inserted: false, priceChanged: false };
  if (row.inserted) return { inserted: true, priceChanged: false, id: row.id };
  return {
    inserted: false,
    priceChanged: true,
    id: row.id,
    from: row.previous_price == null ? null : Number(row.previous_price),
    to: row.price == null ? null : Number(row.price),
  };
}

function rowToApi(row) {
  if (!row) return null;
  // Values of his own custom fields are stored together in one JSON column, but they
  // are spread onto the object so the table, filters and sort treat them exactly like
  // any other field — nothing downstream needs to know they are custom.
  const custom = P(row.custom) || {};
  return {
    ...row,
    ...custom,
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
  // Save edits to his own fields. Only keys defined in fields.js are accepted and each
  // value is coerced to its column type, so a hand-typed "$15,000/mo" lands as 15000
  // and an unknown key can never reach the SQL.
  async updateFields(id, patch, { allowSensitive = true } = {}) {
    const { SENSITIVE_KEYS } = require('./fields');
    const sets = [], vals = [];
    let i = 1;
    for (const [k, raw] of Object.entries(patch || {})) {
      if (!FIELD_KEYS.includes(k)) continue;
      if (!allowSensitive && SENSITIVE_KEYS.includes(k)) continue; // silently refuse
      const v = coerce(k, raw);
      if (v === undefined) continue;
      sets.push(`${k}=$${i++}`);
      vals.push(v);
    }
    if (!sets.length) return { updated: 0, listing: await q.get(id) };
    vals.push(id);
    const r = await pool.query(`UPDATE listings SET ${sets.join(', ')} WHERE id=$${i}`, vals);
    return { updated: r.rowCount ? sets.length : 0, listing: await q.get(id) };
  },

  // Properties whose price moved, newest change first. `drop` is positive when the
  // price came DOWN, which is the direction he cares about.
  async priceChanges({ days = 30, onlyDrops = false } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM listings
        WHERE price_changed_at IS NOT NULL
          AND previous_price IS NOT NULL
          AND price_changed_at > now() - ($1 || ' days')::interval
          ${onlyDrops ? 'AND price < previous_price' : ''}
        ORDER BY price_changed_at DESC`,
      [String(days)]
    );
    return rows.map(r => ({
      ...rowToApi(r),
      drop: Number(r.previous_price) - Number(r.price),
      dropPct: Number(r.previous_price) ? Math.round((1 - Number(r.price) / Number(r.previous_price)) * 100) : null,
    }));
  },

  // What the digest should cover: properties sourced since the last digest, plus any
  // price change since then. Nothing is marked as reported until the send succeeds.
  async digestContents({ days = 1 } = {}) {
    const iv = `($1 || ' days')::interval`;
    const fresh = await pool.query(
      `SELECT * FROM listings
        WHERE digest_sent_at IS NULL AND created_at > now() - ${iv}
        ORDER BY price DESC NULLS LAST`, [String(days)]);
    const moved = await pool.query(
      `SELECT * FROM listings
        WHERE previous_price IS NOT NULL
          AND price_changed_at > now() - ${iv}
        ORDER BY price_changed_at DESC`, [String(days)]);
    return {
      newListings: fresh.rows.map(rowToApi),
      priceChanges: moved.rows.map(r => ({
        ...rowToApi(r),
        drop: Number(r.previous_price) - Number(r.price),
      })),
    };
  },

  // Just the two numbers the dashboard line needs — COUNT in the database instead of
  // shipping every row (with its photo JSON) to the app to be counted there.
  async digestCounts({ days = 1 } = {}) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM listings
           WHERE digest_sent_at IS NULL AND created_at > now() - ($1 || ' days')::interval) AS new_count,
         (SELECT COUNT(*)::int FROM listings
           WHERE previous_price IS NOT NULL
             AND price_changed_at > now() - ($1 || ' days')::interval) AS price_change_count`,
      [String(days)]
    );
    return { newCount: rows[0].new_count, priceChangeCount: rows[0].price_change_count };
  },

  async markDigestSent(ids) {
    if (!ids || !ids.length) return 0;
    const { rowCount } = await pool.query(
      `UPDATE listings SET digest_sent_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
    return rowCount;
  },

  // Which of these properties do we already have? Keyed on address the same way the
  // unique constraint is, and matched case-insensitively so "123 Main St" and
  // "123 main st" are the same property. Returns a Map of "street|city" -> {id, price},
  // so the collector can skip a known property before spending an AI call on it.
  async knownProperties(pairs) {
    const out = new Map();
    const streets = [...new Set((pairs || [])
      .map(p => (p.streetLine || '').toLowerCase().trim())
      .filter(Boolean))];
    if (!streets.length) return out;
    const { rows } = await pool.query(
      `SELECT id, street_line, city, price FROM listings
        WHERE lower(trim(street_line)) = ANY($1::text[])`,
      [streets]
    );
    for (const r of rows) {
      out.set(`${(r.street_line || '').toLowerCase().trim()}|${(r.city || '').toLowerCase().trim()}`,
              { id: r.id, price: r.price == null ? null : Number(r.price) });
    }
    return out;
  },

  // ---- custom fields (the ones he creates himself) ----
  async listCustomFields() {
    const { rows } = await pool.query(
      `SELECT key, label, type, options, sensitive FROM custom_fields ORDER BY sort_order, created_at`);
    return rows.map(r => ({
      key: r.key, label: r.label, type: r.type,
      options: r.options ? JSON.parse(r.options) : undefined,
      sensitive: r.sensitive, custom: true,
    }));
  },
  async createCustomField({ key, label, type, options, sensitive }) {
    const { rows } = await pool.query(
      `INSERT INTO custom_fields (key, label, type, options, sensitive, sort_order)
       VALUES ($1,$2,$3,$4,$5, (SELECT COALESCE(MAX(sort_order),0)+1 FROM custom_fields))
       ON CONFLICT (key) DO NOTHING
       RETURNING key, label, type, options, sensitive`,
      [key, label, type, options ? JSON.stringify(options) : null, !!sensitive]
    );
    return rows[0] || null;
  },
  async updateCustomField(key, { label, options, sensitive }) {
    const sets = [], vals = [];
    let i = 1;
    if (label != null) { sets.push(`label=$${i++}`); vals.push(label); }
    if (options !== undefined) { sets.push(`options=$${i++}`); vals.push(options ? JSON.stringify(options) : null); }
    if (typeof sensitive === 'boolean') { sets.push(`sensitive=$${i++}`); vals.push(sensitive); }
    if (!sets.length) return null;
    vals.push(key);
    const { rows } = await pool.query(
      `UPDATE custom_fields SET ${sets.join(', ')} WHERE key=$${i} RETURNING key, label, type, options, sensitive`, vals);
    return rows[0] || null;
  },
  // Removing a field drops its definition AND its stored values, so a deleted field
  // doesn't linger invisibly inside the JSON of every property.
  async deleteCustomField(key) {
    const { rowCount } = await pool.query(`DELETE FROM custom_fields WHERE key=$1`, [key]);
    if (rowCount) {
      await pool.query(`UPDATE listings SET custom = (custom::jsonb - $1)::text WHERE custom IS NOT NULL`, [key]);
    }
    return rowCount > 0;
  },
  // Merge a patch into the listing's custom JSON, so saving one field doesn't wipe
  // the others.
  async updateCustomValues(id, patch) {
    const { rows } = await pool.query(
      `UPDATE listings
          SET custom = (COALESCE(custom::jsonb, '{}'::jsonb) || $1::jsonb)::text
        WHERE id=$2 RETURNING custom`,
      [JSON.stringify(patch), id]
    );
    return rows[0] ? P(rows[0].custom) : null;
  },

  // ---- settings (small key/value state that must survive a restart) ----
  async getSetting(key, fallback = null) {
    const { rows } = await pool.query(`SELECT v FROM settings WHERE k=$1`, [key]);
    if (!rows[0]) return fallback;
    try { return JSON.parse(rows[0].v); } catch { return rows[0].v; }
  },
  async setSetting(key, value) {
    await pool.query(
      `INSERT INTO settings (k, v) VALUES ($1,$2)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [key, JSON.stringify(value)]
    );
    return value;
  },
  async deleteSetting(key) {
    await pool.query(`DELETE FROM settings WHERE k=$1`, [key]);
  },
  async allSettings() {
    const { rows } = await pool.query(`SELECT k, v FROM settings`);
    const out = {};
    for (const r of rows) { try { out[r.k] = JSON.parse(r.v); } catch { out[r.k] = r.v; } }
    return out;
  },

  // Recent collector runs, for the automation panel.
  async recentRuns(limit = 10) {
    const { rows } = await pool.query(
      `SELECT id, started_at, sourced, kept, note FROM runs ORDER BY started_at DESC LIMIT $1`, [limit]);
    return rows;
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
  async createUser(email, name, passHash, role, canViewSensitive = false) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, pass_hash, role, can_view_sensitive) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role, can_view_sensitive`,
      [email.toLowerCase().trim(), name || null, passHash, role || 'member',
       role === 'admin' ? true : !!canViewSensitive]
    );
    return rows[0] || null;
  },
  async getUserByEmail(email) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email.toLowerCase().trim()]);
    return rows[0] || null;
  },
  async listUsers() {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, can_view_sensitive, created_at FROM users ORDER BY created_at`);
    return rows;
  },
  // Change a member's role / sensitive-field access. Admins implicitly see everything,
  // so promoting to admin also grants it.
  async updateUserAccess(id, { role, canViewSensitive }) {
    const sets = [], vals = [];
    let i = 1;
    if (role === 'admin' || role === 'member') { sets.push(`role=$${i++}`); vals.push(role); }
    if (typeof canViewSensitive === 'boolean') { sets.push(`can_view_sensitive=$${i++}`); vals.push(canViewSensitive); }
    if (role === 'admin') { sets.push(`can_view_sensitive=true`); }
    if (!sets.length) return q.getUserById(id);
    vals.push(id);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i}`, vals);
    return q.getUserById(id);
  },
  async deleteUser(id) {
    const { rowCount } = await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
    return rowCount > 0;
  },
  async countAdmins() {
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE role='admin'`);
    return rows[0].n;
  },
  async createSession(token, userId, expiresAt) {
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, userId, expiresAt]);
  },
  async getSessionUser(token) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.can_view_sensitive FROM sessions s
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

  // ---- password reset ----
  // Any still-valid tokens for this user are dropped first, so the newest request
  // is the only one that works (a second "forgot password" click voids the first).
  async createPasswordReset(tokenHash, userId, expiresAt) {
    await pool.query(`DELETE FROM password_resets WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    await pool.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`,
      [tokenHash, userId, expiresAt]
    );
  },
  async getPasswordReset(tokenHash) {
    const { rows } = await pool.query(
      `SELECT pr.user_id, u.email FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
      [tokenHash]
    );
    return rows[0] || null;
  },
  async consumePasswordReset(tokenHash) {
    const { rowCount } = await pool.query(
      `UPDATE password_resets SET used_at = now()
       WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    return rowCount > 0; // false => already used or expired (race-safe)
  },
  async deleteAllUserSessions(userId) {
    await pool.query(`DELETE FROM sessions WHERE user_id=$1`, [userId]);
  },
};

module.exports = { pool, init, upsertListing, q };
