// The single source of truth for HIS operational fields.
//
// These are mapped ONE-FOR-ONE against the column list he supplied, using HIS labels —
// "Relationship", not "role"; "Property Bio / Owner's Agenda", not "notes". Where a
// column of his is already filled from the listing feed (address, beds, sq ft, county,
// style, capacities, architect, gated community…) it is NOT repeated here; those stay
// read-only in the detail card. Everything here is the part no feed can supply: his own
// commercial and operational knowledge, blank and editable for his team.
//
// Everything downstream reads this list: the Postgres columns are created from it, the
// PATCH endpoint validates against it, the detail form renders from it, and the
// permission gate uses `sensitive`. Adding a field later means one entry here.
//
//   key       column + JSON key
//   label     exactly what he calls it
//   type      text | textarea | number | money | select   (drives the input)
//   options   for select
//   group     which section of the edit form it lands in
//   sensitive true  => only users with can_view_sensitive may read or write it
//
// OPEN QUESTION — his sheet lists Monthly / Nightly / Event / Film TWICE. Rather than
// guess what the second set means (asking vs achieved? owner cost vs client price?),
// both sets exist as "Rate set 1" and "Rate set 2" and he will be asked to confirm the
// labels. Renaming a label here does not touch the stored data.

const FIELDS = [
  // --- Positioning -------------------------------------------------------------
  { key: 'tier',              label: 'Tier',              type: 'select', group: 'Positioning',
    options: ['', 'A', 'B', 'C', 'D'] },
  { key: 'wedding_spotlight', label: 'Wedding Spotlight',  type: 'select', group: 'Positioning',
    options: ['', 'Yes', 'No', 'Maybe'] },
  { key: 'adult_rentals',     label: 'Adult Rentals',      type: 'select', group: 'Positioning',
    options: ['', 'Yes', 'No'] },
  { key: 'compensation_type', label: 'Compensation Type',  type: 'text',   group: 'Positioning' },

  // --- Rates · set 1 (labels to be confirmed with him) -------------------------
  { key: 'rate1_monthly', label: 'Monthly', type: 'money', group: 'Rate set 1' },
  { key: 'rate1_nightly', label: 'Nightly', type: 'money', group: 'Rate set 1' },
  { key: 'rate1_event',   label: 'Event',   type: 'money', group: 'Rate set 1' },
  { key: 'rate1_film',    label: 'Film',    type: 'money', group: 'Rate set 1' },

  // --- Rates · set 2 -----------------------------------------------------------
  { key: 'rate2_monthly', label: 'Monthly', type: 'money', group: 'Rate set 2' },
  { key: 'rate2_nightly', label: 'Nightly', type: 'money', group: 'Rate set 2' },
  { key: 'rate2_event',   label: 'Event',   type: 'money', group: 'Rate set 2' },
  { key: 'rate2_film',    label: 'Film',    type: 'money', group: 'Rate set 2' },

  // --- Availability ------------------------------------------------------------
  // Free text on purpose: his sheet holds phrases like "weekends only, not Aug",
  // which a date picker would lose.
  { key: 'availability_monthly_nightly', label: 'Availability — Monthly / Nightly', type: 'text', group: 'Availability' },
  { key: 'availability_events_film',     label: 'Availability — Events / Film',     type: 'text', group: 'Availability' },
  // Free text, not a time picker: his sheet may well say "10pm" or "midnight (city
  // permit)", and a strict HH:MM would silently discard those on import.
  { key: 'event_end_time',               label: 'Event End Time',                   type: 'text', group: 'Availability' },
  { key: 'service_schedule',             label: 'Service Schedule',                 type: 'text', group: 'Availability' },

  // --- Space -------------------------------------------------------------------
  { key: 'available_space_off_limits', label: 'Available Space / Off Limits', type: 'textarea', group: 'Space' },
  { key: 'occupied_by',                label: 'Occupied By',                  type: 'text',     group: 'Space' },
  { key: 'visited',                    label: 'Visited',                      type: 'text',     group: 'Space' },

  // --- Listings elsewhere ------------------------------------------------------
  { key: 'airbnb_vrbo',          label: 'AirBnb / Vrbo',         type: 'text', group: 'Listed on' },
  { key: 'giggster_peerspace',   label: 'Giggster / Peerspace',  type: 'text', group: 'Listed on' },

  // --- Contacts (sensitive: real people's details) -----------------------------
  { key: 'contact1',              label: 'Contact 1',    type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact1_relationship', label: 'Relationship', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact2',              label: 'Contact 2',    type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact2_relationship', label: 'Relationship', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact3',              label: 'Contact 3',    type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact3_relationship', label: 'Relationship', type: 'text', group: 'Contacts', sensitive: true },

  // --- Private / on-site (sensitive: access details + candid owner notes) -------
  { key: 'property_bio',  label: "Property Bio / Owner's Agenda / Additional Info", type: 'textarea', group: 'Private', sensitive: true },
  { key: 'owner_temper',  label: 'Owner Temper', type: 'textarea', group: 'Private', sensitive: true },
  { key: 'wifi_info',     label: 'Wifi Info',    type: 'text',     group: 'Private', sensitive: true },
  { key: 'access_info',   label: 'Access Info',  type: 'textarea', group: 'Private', sensitive: true },
];

// Postgres type per field type. Money is stored as BIGINT whole dollars to keep it
// exact and sortable.
const SQL_TYPE = { text: 'TEXT', textarea: 'TEXT', select: 'TEXT', number: 'INTEGER', money: 'BIGINT' };

const FIELD_KEYS = FIELDS.map(f => f.key);
const SENSITIVE_KEYS = FIELDS.filter(f => f.sensitive).map(f => f.key);
const byKey = Object.fromEntries(FIELDS.map(f => [f.key, f]));

// Ordered group names, for rendering the form in a stable order.
const GROUPS = [...new Set(FIELDS.map(f => f.group))];

// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for every field — idempotent, so it
// doubles as the migration for databases created before these fields existed.
function alterStatements(table = 'listings') {
  return FIELDS.map(f => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${f.key} ${SQL_TYPE[f.type]};`).join('\n');
}

// Coerce an incoming value to something safe for its column. Empty string means
// "cleared" -> NULL, so blanking a field in the form actually blanks it.
function coerce(key, raw) {
  const f = byKey[key];
  if (!f) return undefined;
  if (raw === null || raw === undefined || raw === '') return null;
  if (f.type === 'money' || f.type === 'number') {
    // Tolerate what a human or a spreadsheet actually types: "$15,000/mo", "15 000".
    // Only accept it if a digit was actually present — otherwise "n/a" or "TBD" would
    // reduce to "" and Number("") is 0, silently recording a rate of zero.
    const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
    if (!/\d/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (f.type === 'select') {
    // Match case-insensitively but store the canonical option, so a typed "a"
    // becomes "A" and the values stay consistent for filtering and display.
    const v = String(raw).trim().toLowerCase();
    return (f.options || []).find(o => o.toLowerCase() === v) || null;
  }
  return String(raw).trim();
}

// Strip sensitive fields from a listing for a user who may not see them.
function redact(listing, canViewSensitive) {
  if (!listing || canViewSensitive) return listing;
  const out = { ...listing };
  for (const k of SENSITIVE_KEYS) delete out[k];
  out.sensitive_hidden = true; // lets the UI say "hidden" instead of "empty"
  return out;
}

module.exports = {
  FIELDS, FIELD_KEYS, SENSITIVE_KEYS, GROUPS, byKey,
  alterStatements, coerce, redact,
};
