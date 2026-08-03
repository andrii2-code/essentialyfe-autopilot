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
// His sheet lists Monthly / Nightly / Event / Film twice. He confirmed (2026-08-01)
// what the two sets are: the first is HIS COST — what the property costs him — and the
// second is the ASKING PRICE his team should be upselling the rental at. The margin
// between them is the business, which is why both are worth holding.

const FIELDS = [
  // --- Positioning -------------------------------------------------------------
  // What he calls the property. This is the name shown in the table (linking to its
  // Drive folder) and it is what the Drive folder is named, so he controls both.
  { key: 'property_name',     label: 'Property Name',      type: 'text',   group: 'Positioning' },
  // 1-7, not A-D. His own sheet grades on 1-7 (confirmed on the call 2026-08-03 and
  // borne out by the file itself: 1,656 graded rows, every value between 1 and 7).
  { key: 'tier',              label: 'Tier',              type: 'select', group: 'Positioning',
    options: ['', '1', '2', '3', '4', '5', '6', '7'] },
  // His sheet keeps Wedding and Spotlight as two separate tick columns, so they are
  // two fields here rather than the single "Wedding Spotlight" I had guessed.
  { key: 'wedding',           label: 'Wedding',            type: 'select', group: 'Positioning',
    options: ['', 'Yes', 'No', 'Maybe'] },
  { key: 'spotlight',         label: 'Spotlight',          type: 'select', group: 'Positioning',
    options: ['', 'Yes', 'No'] },
  { key: 'adult_rentals',     label: 'Adult Rentals',      type: 'select', group: 'Positioning',
    options: ['', 'Yes', 'No', 'Maybe', 'TBD'] },
  { key: 'compensation_type', label: 'Compensation Type',  type: 'text',   group: 'Positioning' },

  // --- Rates · his cost ---------------------------------------------------------
  { key: 'rate1_monthly', label: 'Monthly', type: 'money', group: 'Your cost' },
  { key: 'rate1_nightly', label: 'Nightly', type: 'money', group: 'Your cost' },
  { key: 'rate1_event',   label: 'Event',   type: 'money', group: 'Your cost' },
  { key: 'rate1_film',    label: 'Film',    type: 'money', group: 'Your cost' },

  // --- Rates · what the team asks -----------------------------------------------
  { key: 'rate2_monthly', label: 'Monthly', type: 'money', group: 'Asking price' },
  { key: 'rate2_nightly', label: 'Nightly', type: 'money', group: 'Asking price' },
  { key: 'rate2_event',   label: 'Event',   type: 'money', group: 'Asking price' },
  { key: 'rate2_film',    label: 'Film',    type: 'money', group: 'Asking price' },

  // --- Character ---------------------------------------------------------------
  // His sheet carries its own Property Type ("Villa", "Mansion", "Compound") and up
  // to three Styles per property. These are HIS words, not the feed's — the feed's
  // own listing type (for sale / sold / for rent) is a different column entirely and
  // is read-only, further down in FEED_COLUMNS.
  { key: 'his_property_type', label: 'Property Type', type: 'text', group: 'Character' },
  { key: 'style1',            label: 'Style 1',       type: 'text', group: 'Character' },
  { key: 'style2',            label: 'Style 2',       type: 'text', group: 'Character' },
  { key: 'style3',            label: 'Style 3',       type: 'text', group: 'Character' },

  // --- Availability ------------------------------------------------------------
  // Free text on purpose: his sheet holds phrases like "weekends only, not Aug",
  // which a date picker would lose.
  { key: 'availability_monthly_nightly', label: 'Availability — Monthly / Nightly', type: 'text', group: 'Availability' },
  { key: 'availability_events_film',     label: 'Availability — Events / Film',     type: 'text', group: 'Availability' },
  // Free text, not a time picker: his sheet may well say "10pm" or "midnight (city
  // permit)", and a strict HH:MM would silently discard those on import.
  { key: 'event_end_time',               label: 'Event End Time',                   type: 'text', group: 'Availability' },
  { key: 'service_schedule',             label: 'Service Schedule',                 type: 'text', group: 'Availability' },
  // The property's calendar feed (AirBnb, Vrbo, Google Calendar all publish one).
  // Holding the URL is the first half of the iCal work; reading the feed to show
  // booked dates is the second, and is a separate piece.
  { key: 'ical_url',                     label: 'iCal Link',                        type: 'text', group: 'Availability' },

  // --- Space -------------------------------------------------------------------
  { key: 'available_space_off_limits', label: 'Available Space / Off Limits', type: 'textarea', group: 'Space' },
  { key: 'occupied_by',                label: 'Occupied By',                  type: 'text',     group: 'Space' },
  { key: 'visited',                    label: 'Visited',                      type: 'text',     group: 'Space' },

  // --- Listings elsewhere ------------------------------------------------------
  // In his sheet these cells read "Link" and carry the real URL as a hyperlink behind
  // the text — which is exactly what a plain CSV export throws away. They are `url`
  // type so the importer keeps the target and the UI renders them clickable.
  { key: 'airbnb_vrbo',          label: 'AirBnb / Vrbo',         type: 'url', group: 'Listed on' },
  { key: 'giggster_peerspace',   label: 'Giggster / Peerspace',  type: 'url', group: 'Listed on' },
  // The listing page the row came from (Zillow on 6,589 of his rows, plus Redfin,
  // Realtor, Compass, LoopNet). His "Address" cell links to it.
  { key: 'listing_url',          label: 'Listing Page',          type: 'url', group: 'Listed on' },
  // The property's existing photo folder. 6,286 of his rows link one — Drive, Dropbox
  // or a tinyurl — off the property name. Distinct from drive_folder_url, which is
  // the folder THIS app creates when he approves a property.
  { key: 'photos_url',           label: 'Existing Photos',       type: 'url', group: 'Listed on' },
  // His own marketing site for the property, where one exists.
  { key: 'website_url',          label: 'Website',               type: 'url', group: 'Listed on' },

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
const SQL_TYPE = { text: 'TEXT', textarea: 'TEXT', select: 'TEXT', url: 'TEXT', number: 'INTEGER', money: 'BIGINT' };

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

// Columns that come from the listing feed / AI rather than from him. These are
// read-only, but he can still choose to show them in the table — the point of the
// column picker is that nothing is off-limits.
const FEED_COLUMNS = [
  { key: 'street_line',      label: 'Address',           group: 'Listing' },
  { key: 'area',             label: 'Area',              group: 'Listing' },
  { key: 'city',             label: 'City',              group: 'Listing' },
  { key: 'county',           label: 'County',            group: 'Listing' },
  { key: 'state',            label: 'State',             group: 'Listing' },
  { key: 'zip',              label: 'Zip',               group: 'Listing' },
  { key: 'neighborhood',     label: 'Neighborhood',      group: 'Listing' },
  { key: 'price',            label: 'Price',             group: 'Listing', type: 'money' },
  { key: 'status',           label: 'Status',            group: 'Listing' },
  // This is which of his three searches the property came from: for sale, sold, or
  // for rent. It was labelled "Property Type" here, which was wrong twice over — it
  // reads like Villa/Mansion (a column he actually has, further up), and it left him
  // unable to tell a rental from a sale. It is the listing type, so it says so.
  { key: 'spec',             label: 'Listing Type',      group: 'Listing' },
  { key: 'source',           label: 'Source',            group: 'Listing' },
  { key: 'beds',             label: 'Bed',               group: 'Structure', type: 'number' },
  { key: 'baths',            label: 'Bath',              group: 'Structure', type: 'number' },
  { key: 'sqft',             label: 'Sq. Ft.',           group: 'Structure', type: 'number' },
  { key: 'lot_acres',        label: 'Acres / Lot Size',  group: 'Structure', type: 'number' },
  { key: 'floors',           label: '# of Floors',       group: 'Structure', type: 'number' },
  { key: 'parking',          label: '# Parking',         group: 'Structure', type: 'number' },
  { key: 'year_built',       label: 'Year Built',        group: 'Structure', type: 'number' },
  { key: 'furnished',        label: 'Furnished & Equipped', group: 'Structure' },
  { key: 'sleep_capacity',   label: 'Sleep Cap.',        group: 'Capacity', type: 'number' },
  { key: 'stand_capacity',   label: 'Stand Cap.',        group: 'Capacity', type: 'number' },
  { key: 'seating_capacity', label: 'Seat Cap.',         group: 'Capacity', type: 'number' },
  { key: 'property_style',   label: 'Style',             group: 'Character' },
  { key: 'architect',        label: 'Architect / Design Firm', group: 'Character' },
  { key: 'gated_community',  label: 'Gated Community',   group: 'Character' },
  { key: 'also_known_as',    label: 'Also Known As',      group: 'Character' },
  { key: 'amenities',        label: 'Amenities',         group: 'Character' },
  { key: 'last_updated',     label: 'Updated',           group: 'Listing' },
  { key: 'created_at',       label: 'Added',             group: 'Listing', type: 'datetime' },
];

// Everything he could put in the table: the feed columns plus his own fields. The UI
// builds the column picker from this, so adding a field in FIELDS above makes it
// available as a column with no further work.
function columnCatalogue({ canViewSensitive = true } = {}) {
  const mine = FIELDS
    .filter(f => canViewSensitive || !f.sensitive)
    .map(f => ({ key: f.key, label: f.label, group: f.group, type: f.type, editable: true, sensitive: !!f.sensitive }));
  const feed = FEED_COLUMNS.map(c => ({ ...c, editable: false, sensitive: false }));
  return [...feed, ...mine];
}

module.exports = {
  FIELDS, FIELD_KEYS, SENSITIVE_KEYS, GROUPS, byKey,
  FEED_COLUMNS, columnCatalogue,
  alterStatements, coerce, redact,
};
