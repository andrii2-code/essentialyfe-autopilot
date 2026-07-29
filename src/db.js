// DB layer. Uses node:sqlite (built into Node 22+) for local + most hosts.
// Schema mirrors HIS full property field list so nothing he asked for is lost.
// Kept deliberately simple/abstracted so a Postgres swap on deploy is trivial.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// DB_DIR lets the host point the database at a persistent volume. On Railway,
// attach a volume mounted at (e.g.) /data and set DB_DIR=/data — otherwise a
// redeploy/restart wipes the container disk and the database resets to empty.
// Falls back to the local ./data dir for development.
const DATA_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'essentialyfe.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT, source_url TEXT, mls_id TEXT, listing_id TEXT, property_id TEXT,
  spec TEXT,                    -- for-sale | sold | for-rent
  status TEXT DEFAULT 'in_review', -- in_review | approved | passed | processing | ready | live
  title TEXT, address TEXT, street_line TEXT,
  country TEXT, state TEXT, county TEXT, city TEXT, neighborhood TEXT, area TEXT, zip TEXT,
  lat REAL, lng REAL, gated_community TEXT,
  beds INTEGER, baths REAL, full_baths INTEGER, sqft INTEGER, lot_acres REAL,
  floors REAL, parking INTEGER, year_built INTEGER,
  property_style TEXT, architect TEXT, color_palette TEXT, furnished TEXT, also_known_as TEXT,
  sleep_capacity INTEGER, stand_capacity INTEGER, seating_capacity INTEGER,
  price INTEGER, price_per_sqft INTEGER, is_rental INTEGER, hoa INTEGER,
  amenities TEXT,               -- JSON array
  num_photos INTEGER, has_video INTEGER, description TEXT,
  is_redfin INTEGER, photo_group_code TEXT, photo_positions TEXT, -- real-photo source (JSON array)
  photo_urls TEXT,             -- realtor.com full gallery (JSON array of rdcpix URLs)
  photo_source TEXT,           -- realtor-real | redfin-real | pool
  owner_info TEXT,              -- gated (Phase 2)
  enriched_by TEXT,
  drive_folder_id TEXT, drive_folder_url TEXT,
  images TEXT,                  -- JSON array of processed-image records
  last_updated TEXT, days_on_market INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT, ready_at TEXT,
  -- Identity is the PROPERTY (address), not the price. Luxury listings re-list and
  -- change price often; keying on price would let a passed/approved home reappear as
  -- "new" the moment its price moved. Keying on street_line + city keeps one row per
  -- real property, so a home you already passed or delivered never comes back.
  UNIQUE(street_line, city)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT DEFAULT (datetime('now')),
  sourced INTEGER DEFAULT 0, kept INTEGER DEFAULT 0, note TEXT
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
`);

const J = (v) => v == null ? null : JSON.stringify(v);
const P = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

function upsertListing(r) {
  const stmt = db.prepare(`
    INSERT INTO listings (source, source_url, mls_id, listing_id, property_id, spec, status,
      title, address, street_line, country, state, county, city, neighborhood, area, zip, lat, lng, gated_community,
      beds, baths, full_baths, sqft, lot_acres, floors, parking, year_built,
      property_style, architect, color_palette, furnished, also_known_as,
      sleep_capacity, stand_capacity, seating_capacity,
      price, price_per_sqft, is_rental, hoa, amenities, num_photos, has_video, description, owner_info,
      is_redfin, photo_group_code, photo_positions, photo_urls,
      enriched_by, last_updated, days_on_market)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?)
    ON CONFLICT(street_line, city) DO NOTHING
  `);
  const info = stmt.run(
    r.source, r.sourceUrl, r.mlsId, r.listingId != null ? String(r.listingId) : null, r.propertyId != null ? String(r.propertyId) : null, r.spec, 'in_review',
    r.title, r.address, r.streetLine, r.country, r.state, r.county, r.city, r.neighborhood, r.area, r.zip != null ? String(r.zip) : null, r.lat, r.lng, r.gatedCommunity,
    r.beds, r.baths, r.fullBaths, r.sqft, r.lotAcres, r.floors, r.parking, r.yearBuilt,
    J(r.propertyStyle), r.architect, J(r.colorPalette), r.furnished, r.alsoKnownAs,
    r.sleepCapacity, r.standCapacity, r.seatingCapacity,
    r.price, r.pricePerSqft, r.isRental ? 1 : 0, r.hoa, J(r.amenities), r.numPhotos, r.hasVideo ? 1 : 0, r.description, r.ownerInfo,
    r.isRedfin ? 1 : 0, r.photoGroupCode, J(r.photoPositions), J(r.photoUrls),
    r.enrichedBy, r.lastUpdated, r.daysOnMarket
  );
  return info.changes > 0;
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
    // camelCase aliases photosFor() reads
    photoGroupCode: row.photo_group_code || null,
    photoPositions: P(row.photo_positions),
    photoUrls: P(row.photo_urls),
  };
}

const q = {
  counts() {
    const rows = db.prepare(`SELECT status, COUNT(*) n FROM listings GROUP BY status`).all();
    const m = { in_review: 0, approved: 0, passed: 0, processing: 0, ready: 0, live: 0 };
    for (const r of rows) m[r.status] = r.n;
    m.sourced = db.prepare(`SELECT COUNT(*) n FROM listings`).get().n;
    return m;
  },
  queue() { return db.prepare(`SELECT * FROM listings WHERE status='in_review' ORDER BY price DESC`).all().map(rowToApi); },
  bySpec(spec) { return db.prepare(`SELECT * FROM listings WHERE spec=? ORDER BY price DESC`).all(spec).map(rowToApi); },
  ready() { return db.prepare(`SELECT * FROM listings WHERE status IN ('ready','live','processing') ORDER BY ready_at DESC, price DESC`).all().map(rowToApi); },
  get(id) { return rowToApi(db.prepare(`SELECT * FROM listings WHERE id=?`).get(id)); },
  all() { return db.prepare(`SELECT * FROM listings ORDER BY price DESC`).all().map(rowToApi); },
  setStatus(id, status, extra = {}) {
    const sets = ['status=?']; const vals = [status];
    if (extra.approved_at) { sets.push('approved_at=?'); vals.push(extra.approved_at); }
    if (extra.ready_at) { sets.push('ready_at=?'); vals.push(extra.ready_at); }
    if (extra.drive_folder_id) { sets.push('drive_folder_id=?'); vals.push(extra.drive_folder_id); }
    if (extra.drive_folder_url) { sets.push('drive_folder_url=?'); vals.push(extra.drive_folder_url); }
    if (extra.images) { sets.push('images=?'); vals.push(J(extra.images)); }
    vals.push(id);
    db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    return q.get(id);
  },
  newRun(sourced, kept, note) { db.prepare(`INSERT INTO runs (sourced, kept, note) VALUES (?,?,?)`).run(sourced, kept, note); },
  clearAll() { db.exec(`DELETE FROM listings; DELETE FROM runs;`); },
};

module.exports = { db, upsertListing, q };
