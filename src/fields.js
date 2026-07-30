// The single source of truth for HIS operational fields — the ones no listing feed
// can supply because they're his own commercial knowledge (what he charges, who he
// calls, what the owner is like). The AI fills what it can from the listing; these
// stay blank and editable for his team, exactly as promised in the system design.
//
// Everything downstream reads this list: the Postgres columns are created from it,
// the PATCH endpoint validates against it, the detail form renders from it, and the
// permission gate uses `sensitive`. Adding a field later means one entry here — no
// migration to hand-write, no form to touch.
//
//   key       column + JSON key
//   label     what he sees
//   type      text | textarea | number | money | date | select  (drives the input)
//   options   for select
//   group     which section of the edit form it lands in
//   sensitive true  => only users with can_view_sensitive may read or write it

const FIELDS = [
  // --- Positioning -------------------------------------------------------------
  { key: 'tier',              label: 'Tier',               type: 'select', group: 'Positioning',
    options: ['', 'A', 'B', 'C', 'D'] },
  { key: 'wedding_spotlight', label: 'Wedding Spotlight',  type: 'select', group: 'Positioning',
    options: ['', 'Yes', 'No', 'Maybe'] },
  { key: 'internal_notes',    label: 'Notes',              type: 'textarea', group: 'Positioning' },

  // --- Rates (his negotiated commercial rates, unrelated to the listing price) --
  { key: 'monthly_rate', label: 'Monthly rate', type: 'money', group: 'Rates' },
  { key: 'nightly_rate', label: 'Nightly rate', type: 'money', group: 'Rates' },
  { key: 'event_rate',   label: 'Event rate',   type: 'money', group: 'Rates' },
  { key: 'film_rate',    label: 'Film rate',    type: 'money', group: 'Rates' },

  // --- Availability ------------------------------------------------------------
  { key: 'available_from',   label: 'Available from',  type: 'date', group: 'Availability' },
  { key: 'available_to',     label: 'Available to',    type: 'date', group: 'Availability' },
  { key: 'availability_note',label: 'Availability note', type: 'text', group: 'Availability' },

  // --- Contacts (sensitive: real people's details) -----------------------------
  { key: 'contact1_name',  label: 'Contact 1 · name',  type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact1_role',  label: 'Contact 1 · role',  type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact1_phone', label: 'Contact 1 · phone', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact1_email', label: 'Contact 1 · email', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact2_name',  label: 'Contact 2 · name',  type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact2_role',  label: 'Contact 2 · role',  type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact2_phone', label: 'Contact 2 · phone', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact2_email', label: 'Contact 2 · email', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact3_name',  label: 'Contact 3 · name',  type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact3_role',  label: 'Contact 3 · role',  type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact3_phone', label: 'Contact 3 · phone', type: 'text', group: 'Contacts', sensitive: true },
  { key: 'contact3_email', label: 'Contact 3 · email', type: 'text', group: 'Contacts', sensitive: true },

  // --- On-site / private (sensitive: access details + candid owner notes) -------
  { key: 'owner_temper', label: 'Owner temper',  type: 'textarea', group: 'Private', sensitive: true },
  { key: 'wifi_info',    label: 'Wifi',          type: 'text',     group: 'Private', sensitive: true },
  { key: 'access_info',  label: 'Access info',   type: 'textarea', group: 'Private', sensitive: true },
  { key: 'private_notes',label: 'Private notes', type: 'textarea', group: 'Private', sensitive: true },
];

// Postgres type per field type. Money is stored as BIGINT cents-free dollars to keep
// it exact and sortable; dates as TEXT (ISO yyyy-mm-dd) to match the existing columns.
const SQL_TYPE = { text: 'TEXT', textarea: 'TEXT', select: 'TEXT', number: 'INTEGER', money: 'BIGINT', date: 'TEXT' };

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
    // Strip currency/separators, but only accept the result if a digit was actually
    // present — otherwise "n/a" or "TBD" would reduce to "" and Number("") is 0,
    // silently recording a rate of zero.
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
  if (f.type === 'date') {
    const s = String(raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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
