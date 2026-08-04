// Bringing his own spreadsheet into the app.
//
// The shape this is built against is his real file (6,789 properties, 60 columns,
// 13,597 hyperlinks). Three things about it drive the design:
//
//  1. The links are invisible. Cells read "Link", "The Carman 3", or an address, and
//     the URL sits behind the text as a hyperlink. So we read the .xlsx itself rather
//     than asking him for a CSV, which would drop every one of them.
//  2. Two rate blocks with identical headers. Monthly/Nightly/Event/Film appears
//     twice — the first is his cost, the second is the asking price. They can only be
//     told apart by position, so the mapping is positional for those eight columns.
//  3. The data is hand-typed over years. "Villa " and "villa", "Compund", "Unavilable",
//     "N/A" in money columns, numbers stored as "3.0". All of it gets normalised on
//     the way in rather than being pushed onto him to clean first.

const { readSheet } = require('./xlsx');
const { byKey } = require('./fields');

// His header -> our field key. Matching is done on a squashed form of the header
// (lowercased, punctuation and spacing removed) so "Acres/ Lot Size", "Acres / Lot
// Size" and "acres/lot size" all land on the same entry.
const HEADER_MAP = {
  properties: 'property_name',
  address: 'address',
  tier: 'tier',
  bed: 'beds',
  beds: 'beds',
  bath: 'baths',
  baths: 'baths',
  sqft: 'sqft',
  acreslotsize: 'lot_acres',
  offloors: 'floors',            // "# of Floors" -> the # is stripped
  parking: 'parking',
  furnishedequipped: 'furnished',
  updated: 'last_updated',
  state: 'state',
  county: 'county',
  city: 'city',
  neighborhood: 'neighborhood',
  area: 'area',
  propertytype: 'his_property_type',
  style1: 'style1',
  style2: 'style2',
  style3: 'style3',
  sleepcap: 'sleep_capacity',
  standcap: 'stand_capacity',
  seatcap: 'seating_capacity',
  wedding: 'wedding',
  spotlight: 'spotlight',
  availabilitymonthlynightly: 'availability_monthly_nightly',
  availabilityeventsfilm: 'availability_events_film',
  amenetiesdescription: 'amenities_note',
  amenitiesdescription: 'amenities_note',
  airbnbvrbo: 'airbnb_vrbo',
  giggsterpeerspace: 'giggster_peerspace',
  contact1: 'contact1',
  contact2: 'contact2',
  contact3: 'contact3',
  occupiedby: 'occupied_by',
  visited: 'visited',
  alsoknownas: 'also_known_as',
  propertybioownersagendaadditionalinfo: 'property_bio',
  ownertemper: 'owner_temper',
  compensationtype: 'compensation_type',
  availablespaceofflimits: 'available_space_off_limits',
  eventendtime: 'event_end_time',
  adultrentals: 'adult_rentals',
  architectdesignfirm: 'architect',
  gatedcommunity: 'gated_community',
  wifiinfo: 'wifi_info',
  accessinfo: 'access_info',
  serviceschedule: 'service_schedule',
};

// The eight rate columns, in the order they appear. Header text alone cannot
// distinguish them — both blocks say Monthly/Nightly/Event/Film — so the first block
// encountered is his cost and the second is the asking price.
const RATE_SEQUENCE = ['monthly', 'nightly', 'event', 'film'];
const RATE_KEYS = [
  ['rate1_monthly', 'rate1_nightly', 'rate1_event', 'rate1_film'],
  ['rate2_monthly', 'rate2_nightly', 'rate2_event', 'rate2_film'],
];

// "Relationship" appears three times, once after each Contact column.
const REL_KEYS = ['contact1_relationship', 'contact2_relationship', 'contact3_relationship'];

function squash(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Work out, for each column index in his file, which field it feeds.
//
// Duplicate headers are the subtle part. His file has BOTH "Bed" (column E, filled on
// 6,626 rows) and "Beds" (column I, filled on 138) — and on 35 of those they disagree.
// Whichever is read last would win, so a stray column of 138 values would quietly
// overwrite his real bedroom count. The rule is therefore: the first column to claim a
// field keeps it, and any later claimant is reported as a duplicate rather than
// silently applied. The rate and Relationship blocks are exempt — repetition there is
// meaningful and handled positionally above.
function buildMapping(headers) {
  const mapping = [];
  const claimed = new Map();     // field key -> header that claimed it
  const duplicates = [];
  let rateBlock = 0, rateSeen = 0, relSeen = 0;

  headers.forEach((h, i) => {
    const s = squash(h);
    if (!s) { mapping[i] = null; return; }

    // rate columns — positional
    const ratePos = RATE_SEQUENCE.indexOf(s);
    if (ratePos !== -1) {
      // A new block starts whenever we see "monthly" again.
      if (ratePos === 0 && rateSeen > 0) rateBlock = Math.min(rateBlock + 1, RATE_KEYS.length - 1);
      rateSeen++;
      mapping[i] = { key: RATE_KEYS[rateBlock][ratePos], source: h };
      return;
    }

    // the three Relationship columns — positional
    if (s === 'relationship') {
      mapping[i] = relSeen < REL_KEYS.length ? { key: REL_KEYS[relSeen], source: h } : null;
      relSeen++;
      return;
    }

    const key = HEADER_MAP[s];
    if (!key) { mapping[i] = null; return; }
    if (claimed.has(key)) {
      duplicates.push({ source: h, key, kept: claimed.get(key) });
      mapping[i] = null;
      return;
    }
    claimed.set(key, h);
    mapping[i] = { key, source: h };
  });

  mapping.duplicates = duplicates;
  return mapping;
}

// ---- value normalisation ----------------------------------------------------

// His sheet writes whole numbers as "3.0" (a Google Sheets export artefact) and uses
// "N/A", "n/a", "tbd", "-" for "nothing here".
const NULLISH = new Set(['', 'n/a', 'na', 'tbd', 'tba', '-', '—', 'none', 'null', 'unknown', '?']);

function cleanScalar(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  if (NULLISH.has(s.toLowerCase())) return null;
  // "3.0" -> "3", but leave "3.5" and "0.79" alone
  if (/^-?\d+\.0+$/.test(s)) s = String(parseInt(s, 10));
  return s === '' ? null : s;
}

function toNumber(raw) {
  const s = cleanScalar(raw);
  if (s == null) return null;
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Title-case a hand-typed category so "villa ", "Villa" and "VILLA" agree, and fix
// the typos that actually occur in his file.
const TYPO = {
  compund: 'Compound', famrhouse: 'Farmhouse', unavilable: 'Unavailable',
  unavailabe: 'Unavailable', mansions: 'Mansion', appartment: 'Apartment',
  townhouse: 'Townhouse', beachhouse: 'Beach House', farmhouse: 'Farmhouse',
};
function titleCase(raw) {
  const s = cleanScalar(raw);
  if (s == null) return null;
  const fixed = TYPO[squash(s)];
  if (fixed) return fixed;
  return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// "x" in his tick columns means yes.
function tickToYesNo(raw) {
  const s = cleanScalar(raw);
  if (s == null) return null;
  const l = s.toLowerCase();
  if (l === 'x' || l === 'yes' || l === 'y' || l === 'true') return 'Yes';
  if (l === 'no' || l === 'n' || l === 'false') return 'No';
  if (l === 'maybe') return 'Maybe';
  if (l === 'tbd') return 'TBD';
  return s;
}

// Split "2402 Carman Crest Dr, Los Angeles, CA 90068" into its parts, so an imported
// row can be matched against a collected one on street + city.
//
// The city matters more than it looks: a property is identified by (street, city), and
// in SQL a NULL never equals another NULL. So a row with no city would fail to match
// itself on the next import and be inserted again, every time. Seven of his rows are
// written without a comma ("22400 Bessemer St", "9130 w. sunset blvd los angeles"), so
// this pulls a city out of a comma-less address where it can, and falls back to a
// placeholder rather than ever leaving it empty.
const KNOWN_CITIES = [
  'Los Angeles', 'Beverly Hills', 'West Hollywood', 'Santa Monica', 'Malibu',
  'Pacific Palisades', 'Calabasas', 'Encino', 'Sherman Oaks', 'Studio City',
  'Woodland Hills', 'Tarzana', 'Bel Air', 'Brentwood', 'Venice', 'Hidden Hills',
  'Topanga', 'Pasadena', 'Glendale', 'Burbank', 'Valley Village', 'Northridge',
  'Newport Beach', 'Laguna Beach', 'San Diego', 'Palm Springs', 'Hollywood',
];

function splitAddress(addr) {
  const s = cleanScalar(addr);
  if (!s) return { streetLine: null, city: null, state: null, zip: null };

  // "8041-Bulwer-Dr-Los-Angeles-CA-90046" — a pasted URL slug, not an address.
  const normalised = /^[^\s,]+(-[^\s,]+){3,}$/.test(s) ? s.replace(/-/g, ' ') : s;

  const parts = normalised.split(',').map(p => p.trim()).filter(Boolean);
  const out = { streetLine: parts[0] || null, city: null, state: null, zip: null };

  if (parts.length >= 2) {
    const tail = parts[parts.length - 1];
    const m = tail.match(/^([A-Za-z .]+?)\s*(\d{5})(?:-\d{4})?$/);
    if (m) {
      // "CA 90210" is a state and a zip; "Beverly Hills 90210" is a city and a zip.
      // A state here is two letters or the word California — anything longer is the
      // city, which some of his rows write without the state.
      const word = m[1].trim();
      const isState = /^([A-Z]{2}|california|new york|new jersey|florida|texas|nevada)$/i.test(word);
      if (isState) {
        out.state = word;
        out.city = parts.length >= 3 ? parts[parts.length - 2] : null;
      } else {
        out.city = word;
      }
      out.zip = m[2];
    } else if (/^\d{5}(-\d{4})?$/.test(tail)) {
      out.zip = tail;
      out.city = parts.length >= 3 ? parts[parts.length - 2] : null;
    } else {
      out.city = tail;
    }
  }

  // No comma, or a comma that yielded no city: look for a city name inside the string
  // and treat whatever precedes it as the street.
  if (!out.city) {
    const hay = normalised.toLowerCase();
    let best = null;
    for (const c of KNOWN_CITIES) {
      const at = hay.indexOf(c.toLowerCase());
      if (at > 0 && (!best || at < best.at)) best = { city: c, at };
    }
    if (best) {
      out.city = best.city;
      const street = normalised.slice(0, best.at).replace(/[,\s]+$/, '').trim();
      if (street) out.streetLine = street;
    }
  }

  // Still nothing. Anything is better than NULL here, because NULL breaks the match
  // and re-imports the row forever.
  if (!out.city) out.city = 'Unknown';

  // Trim a trailing state/zip off the street when the address had no commas.
  if (out.streetLine) {
    out.streetLine = out.streetLine
      .replace(/\s*,?\s*(CA|California)\s*\d{5}(-\d{4})?$/i, '')
      .replace(/\s*\d{5}(-\d{4})?$/, '')
      .replace(/[,\s]+$/, '')
      .trim() || out.streetLine;
  }

  return out;
}

// A URL that is really a URL. His sheet has a couple of stray values ("v", ".") that
// were hyperlinked by accident.
function cleanUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (/^mailto:/i.test(s)) return s;
  if (!/^https?:\/\//i.test(s)) return null;
  if (s.length < 12) return null;
  return s;
}

// Which host a photo-folder link points at — used only for the preview summary.
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; }
}

// ---- the row builder --------------------------------------------------------

function buildRow(cells, mapping) {
  const out = {};
  const warnings = [];

  for (let i = 0; i < mapping.length; i++) {
    const m = mapping[i];
    const cell = cells[i];
    if (!m || !cell) continue;
    const { key } = m;
    const def = byKey[key];
    const raw = cell.v;

    // A hyperlink is worth keeping even when the visible text is only "Link".
    const link = cleanUrl(cell.link);

    if (key === 'address') {
      const parts = splitAddress(raw);
      out.address = cleanScalar(raw);
      out.streetLine = parts.streetLine;
      if (parts.city) out.city = parts.city;
      if (parts.state) out.state = parts.state;
      if (parts.zip) out.zip = parts.zip;
      // The address cell links to the listing page it came from.
      if (link) out.listing_url = link;
      continue;
    }

    if (key === 'property_name') {
      out.property_name = cleanScalar(raw);
      // The property name links to the existing photo folder (Drive/Dropbox).
      if (link) out.photos_url = link;
      continue;
    }

    // Link-bearing fields: prefer the hyperlink over the placeholder text.
    if (def && def.type === 'url') {
      out[key] = link || (/^https?:\/\//i.test(String(raw || '')) ? String(raw).trim() : null);
      continue;
    }

    // Contacts can carry a mailto: or a website behind the name; keep the name as the
    // value and hang the URL on the property's website field if we have nowhere else.
    if (/^contact\d$/.test(key)) {
      out[key] = cleanScalar(raw);
      if (link && !out.website_url && !/^mailto:/i.test(link)) out.website_url = link;
      continue;
    }

    if (def && (def.type === 'money' || def.type === 'number')) {
      // Round: money and counts are whole-number columns, but his sheet computes some
      // of these with formulas — a monthly rate divided by 30 arrives as
      // 6666.666666666667, which Postgres rejects outright ("invalid input syntax for
      // type bigint") and took the whole property down with it. Seven of his 29 test
      // rows failed this way, every one of them on a nightly rate or an event fee.
      const n = toNumber(raw);
      if (n != null) out[key] = Math.round(n);
      else if (cleanScalar(raw) != null) warnings.push(`${m.source}: "${raw}" is not a number`);
      continue;
    }

    if (key === 'wedding' || key === 'spotlight' || key === 'adult_rentals'
        || key === 'furnished' || key === 'gated_community') {
      out[key] = tickToYesNo(raw);
      continue;
    }

    if (key === 'his_property_type' || key === 'style1' || key === 'style2' || key === 'style3'
        || key === 'county' || key === 'occupied_by') {
      out[key] = titleCase(raw);
      continue;
    }

    if (key === 'tier') {
      const n = toNumber(raw);
      out.tier = n != null && n >= 1 && n <= 7 ? String(Math.round(n)) : null;
      if (n != null && (n < 1 || n > 7)) warnings.push(`Tier "${raw}" is outside 1-7`);
      continue;
    }

    if (key === 'beds' || key === 'baths' || key === 'sqft' || key === 'floors'
        || key === 'parking' || key === 'sleep_capacity' || key === 'stand_capacity'
        || key === 'seating_capacity' || key === 'lot_acres') {
      const n = toNumber(raw);
      // baths and lot_acres are REAL in the table — 7.5 baths and 0.35 acres are real
      // values and must keep their decimal. Everything else here is an INTEGER column,
      // so a fractional value has to be rounded or Postgres refuses the whole row.
      if (n != null) out[key] = (key === 'baths' || key === 'lot_acres') ? n : Math.round(n);
      continue;
    }

    out[key] = cleanScalar(raw);
  }

  // Drop keys that came out empty so an import never blanks a field that already has
  // a value in the app.
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];

  return { row: out, warnings };
}

// ---- the public entry point -------------------------------------------------

// Parse a workbook (or CSV text) into app-shaped rows plus a summary he can look at
// before committing. Nothing is written here — this is the dry run.
function parseWorkbook(buffer, { filename = '', maxRows = 100000 } = {}) {
  const isCsv = /\.csv$/i.test(filename);
  const { headers, rows } = isCsv ? readCsv(buffer.toString('utf8')) : readSheet(buffer, { maxRows });

  const mapping = buildMapping(headers);
  const mapped = [];
  const unmapped = [];
  headers.forEach((h, i) => {
    if (!String(h || '').trim()) return;
    if (mapping[i]) mapped.push({ source: h, key: mapping[i].key });
    else unmapped.push(h);   // includes duplicate headers, which are listed separately too
  });

  const out = [];
  const warnings = [];
  for (const d of (mapping.duplicates || [])) {
    warnings.push(`Two columns mean "${d.key}" — kept "${d.kept}", ignored "${d.source}"`);
  }
  let skippedNoAddress = 0;
  let linkCount = 0;
  const photoHosts = new Map();

  for (const cells of rows) {
    const { row, warnings: w } = buildRow(cells, mapping);
    // Address is the identity of a property here; without one there is nothing to
    // match on and nothing meaningful to show.
    if (!row.streetLine && !row.address) { skippedNoAddress++; continue; }
    for (const u of [row.listing_url, row.photos_url, row.airbnb_vrbo, row.giggster_peerspace, row.website_url]) {
      if (u) linkCount++;
    }
    if (row.photos_url) {
      const h = hostOf(row.photos_url);
      if (h) photoHosts.set(h, (photoHosts.get(h) || 0) + 1);
    }
    if (w.length && warnings.length < 200) warnings.push(...w.slice(0, 3));
    out.push(row);
  }

  // Two rows in his sheet can describe the same address — 50 of them do. Some are
  // genuine repeats, some are two units at one address ("The Chalon 5" and "The Chalon
  // Six"), and a few are the same property typed twice with a mangled zip. A property
  // is identified by street + city, so these would silently collapse into one row on
  // import and he would be left wondering where fifty properties went. Instead we
  // detect them here, keep the LAST one (the later row is generally the newer entry),
  // and report exactly which addresses were affected so he can look at them.
  const byKey = new Map();
  const collided = [];
  for (const row of out) {
    const k = `${(row.streetLine || '').toLowerCase().trim()}|${(row.city || '').toLowerCase().trim()}`;
    if (byKey.has(k)) {
      const prev = byKey.get(k);
      collided.push({
        address: row.address || row.streetLine,
        kept: row.property_name || '(unnamed)',
        dropped: prev.property_name || '(unnamed)',
      });
    }
    byKey.set(k, row);
  }
  const deduped = [...byKey.values()];

  // How full each mapped field is, so he can see at a glance what actually carried
  // over rather than trusting a row count.
  const fill = {};
  for (const { key } of mapped) {
    const n = deduped.reduce((acc, r) => acc + (r[key] != null && r[key] !== '' ? 1 : 0), 0);
    if (n) fill[key] = n;
  }

  return {
    headers,
    mapped,
    unmapped,
    duplicates: mapping.duplicates || [],
    collided,
    rows: deduped,
    summary: {
      fileRows: rows.length,
      readable: out.length,
      importable: deduped.length,
      skippedNoAddress,
      sameAddress: collided.length,
      duplicates: (mapping.duplicates || []).length,
      links: linkCount,
      photoHosts: [...photoHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      fill,
      warnings: warnings.slice(0, 25),
    },
  };
}

// A small CSV reader, for when he exports rather than uploading the workbook. Handles
// quoted fields and embedded newlines; there are no links to recover in this path.
function readCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map(h => String(h || '').trim());
  const body = rows.slice(1)
    .filter(r => r.some(c => String(c || '').trim() !== ''))
    .map(r => r.map(v => ({ v: String(v || '').trim() || null, link: null })));
  return { headers, rows: body };
}

module.exports = { parseWorkbook, buildMapping, splitAddress, cleanScalar, toNumber, titleCase, HEADER_MAP };
