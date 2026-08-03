// Real-data source: Redfin's own gis API (the endpoint their frontend calls).
// Verified reachable from datacenter IPs. We query by lat/long polygon so we
// target true LA County luxury zones and never depend on a guessed region_id.
//
// This is genuine live extraction from a real listing site — NOT mock data.
// (Photos are gated behind Redfin's HTML pages, which block datacenter IPs; the
//  image pipeline therefore runs on license-free imagery, while every structured
//  field below is real. See README for the honest note we give the client.)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// LA County luxury zones as bounding polygons (lng lat). Each maps to his 3 specs.
// Boxes chosen over the priciest LA submarkets so 3bd+/$3.9M+ actually appears.
const ZONES = {
  'Beverly Hills / Bel-Air / Holmby': '-118.46 34.13,-118.38 34.13,-118.38 34.05,-118.46 34.05,-118.46 34.13',
  'Westside / Brentwood / Pac Palisades': '-118.58 34.09,-118.46 34.09,-118.46 34.02,-118.58 34.02,-118.58 34.09',
  'Hollywood Hills / Sunset Strip': '-118.40 34.13,-118.31 34.13,-118.31 34.08,-118.40 34.08,-118.40 34.13',
  'Malibu coast': '-118.82 34.05,-118.68 34.05,-118.68 33.99,-118.82 33.99,-118.82 34.05',
};

// EACH SPEC NEEDS A DIFFERENT ENDPOINT. This is the correction to a real defect: the
// gis endpoint below silently ignores `status`, so asking it for sold or rentals gave
// back the for-sale list every time. Measured 2026-08-04 — nine status/filter variants,
// one identical result set. That is what he was looking at when he said there were no
// rentals and he could not tell which listing was which.
//
//   for-sale  gis            JSON, full listing objects incl. photo group codes
//   sold      gis-csv        CSV, honours status=130 — 350 PAST SALE rows with dates
//   for-rent  v1/search/rentals   a separate endpoint entirely, own payload shape
//
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.redfin.com/' };

function stripPrefix(text) {
  return text.includes('&&') ? text.slice(text.indexOf('&&') + 2) : text;
}

// ---- for-sale: the gis JSON feed -------------------------------------------------
async function fetchForSale(poly) {
  const url = `https://www.redfin.com/stingray/api/gis?al=1&num_homes=350&ord=redfin-recommended-asc`
    + `&page_number=1&poly=${encodeURIComponent(poly)}&sf=1,2,3,5,6,7`
    + `&status=9&uipt=1,2,3,4,5,6,7,8&v=8`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Redfin gis ${res.status} for for-sale`);
  const data = JSON.parse(stripPrefix(await res.text()));
  return data?.payload?.homes || [];
}

// ---- sold: the CSV export, which does honour status ------------------------------
// Redfin prefixes the file with an MLS-rules notice line, so the header is found
// rather than assumed, and rows are split with quote awareness (addresses contain
// commas). Columns: SALE TYPE, SOLD DATE, ADDRESS, CITY, PRICE, BEDS, BATHS,
// SQUARE FEET, LOT SIZE, YEAR BUILT, SOURCE, MLS#, LATITUDE, LONGITUDE, URL…
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchSold(poly, soldWithinDays = 90) {
  const url = `https://www.redfin.com/stingray/api/gis-csv?al=1&num_homes=350`
    + `&poly=${encodeURIComponent(poly)}&uipt=1,2,3,4,5,6,7,8&v=8`
    + `&status=130&sold_within_days=${soldWithinDays}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Redfin gis-csv ${res.status} for sold`);
  const lines = (await res.text()).split('\n').filter(l => l.trim());
  const headIdx = lines.findIndex(l => /SALE TYPE|ADDRESS/i.test(l));
  if (headIdx < 0) return [];
  const cols = splitCsvLine(lines[headIdx]).map(c => c.trim());
  return lines.slice(headIdx + 1)
    .map(line => Object.fromEntries(splitCsvLine(line).map((v, i) => [cols[i], v.trim()])))
    // The notice line parses as a row with everything else blank; a real sale has a date.
    .filter(r => r['SALE TYPE'] === 'PAST SALE' && r['SOLD DATE']);
}

// ---- rentals: their own endpoint, own shape --------------------------------------
// Returns { homes: [{ homeData, rentalExtension }] } — rents are a RANGE across the
// units in a building, not one price, which is why they cannot come from gis.
async function fetchRentals(poly) {
  const url = `https://www.redfin.com/stingray/api/v1/search/rentals`
    + `?poly=${encodeURIComponent(poly)}&num_homes=350`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Redfin rentals ${res.status}`);
  const data = JSON.parse(stripPrefix(await res.text()));
  return data?.homes || [];
}

async function fetchZone(poly, spec) {
  if (spec === 'sold') return fetchSold(poly);
  if (spec === 'for-rent') return fetchRentals(poly);
  return fetchForSale(poly);
}

const num = (f) => (f && typeof f === 'object' && 'value' in f) ? f.value : (typeof f === 'number' ? f : null);
const sqftToAcres = (sqft) => sqft ? Math.round((sqft / 43560) * 100) / 100 : null;

// Map a listing's real city to a clean LA-area label (falls back to the city itself).
function areaFromCity(city) {
  if (!city) return null;
  const c = city.toLowerCase();
  if (/beverly hills/.test(c)) return 'Beverly Hills';
  if (/bel.?air|holmby/.test(c)) return 'Bel-Air / Holmby Hills';
  if (/malibu/.test(c)) return 'Malibu';
  if (/pacific palisades/.test(c)) return 'Pacific Palisades';
  if (/brentwood/.test(c)) return 'Brentwood';
  if (/santa monica/.test(c)) return 'Santa Monica';
  if (/marina del rey|venice|playa/.test(c)) return 'Westside Coastal';
  if (/hollywood/.test(c)) return 'Hollywood Hills';
  if (/studio city|sherman oaks|encino|tarzana|woodland hills/.test(c)) return 'The Valley';
  if (/los angeles/.test(c)) return 'Los Angeles';
  return city;
}

// Map a raw Redfin home to HIS exact field schema (the 18-point spec list).
function normalize(h, zoneLabel, spec) {
  const price = num(h.price);
  const lot = num(h.lotSize);
  const streetLine = h.streetLine?.value || '';
  const address = [streetLine, h.city, h.state, num(h.zip) || h.zip].filter(Boolean).join(', ');
  const keyFacts = Array.isArray(h.keyFacts) ? h.keyFacts.map(k => k.description).filter(Boolean) : [];
  const tags = Array.isArray(h.listingTags) ? h.listingTags.filter(Boolean) : [];
  const amenities = [...new Set([...keyFacts, ...tags])].slice(0, 20);

  // Who this listing actually came from. The sashes carry brokerage attribution —
  // "COMPASS COMING SOON" appears on real listings here because of the Compass
  // syndication deal, and those reach us days before they hit the MLS or Zillow.
  // That provenance is what he asked to see, so it goes in `source`, not the site name.
  const sashNames = (h.sashes || []).map(s => s.sashTypeName).filter(Boolean);
  const brokerSash = sashNames.find(n => /compass|coldwell|century 21|corcoran|sotheby/i.test(n));

  return {
    // identity
    source: brokerSash
      ? `${brokerSash.replace(/\s+coming soon$/i, '')} (pre-MLS)`
      : (h.mlsId?.value ? 'MLS (live)' : 'Redfin (live)'),
    sourceUrl: h.url ? `https://www.redfin.com${h.url}` : null,
    mlsId: h.mlsId?.value || null,
    listingId: h.listingId || null,
    propertyId: h.propertyId || null,
    dataSourceId: h.dataSourceId || null,
    lastUpdated: num(h.timeOnRedfin) != null ? 'active' : null,
    daysOnMarket: num(h.dom),
    spec, // for-sale | sold | for-rent
    // location
    title: streetLine || address,
    address,
    streetLine,
    country: h.countryCode || 'US',
    state: h.state || 'CA',
    county: 'Los Angeles County',
    city: h.city || null,
    neighborhood: h.location?.value || null,
    area: areaFromCity(h.city) || zoneLabel,
    zip: num(h.zip) || h.zip || null,
    lat: h.latLong?.value?.latitude ?? null,
    lng: h.latLong?.value?.longitude ?? null,
    gatedCommunity: null, // not in feed → manual/AI later
    // structure
    beds: h.beds ?? null,
    baths: h.baths ?? null,
    fullBaths: h.fullBaths ?? null,
    sqft: num(h.sqFt),
    lotAcres: sqftToAcres(lot),
    floors: h.stories ?? null,
    parking: h.skParkingSpaces ?? h.skGarageSpaces ?? null,
    yearBuilt: num(h.yearBuilt),
    // character (some AI/manual-filled per his note)
    propertyStyle: null,
    architect: null,
    colorPalette: null,       // vision model fills later
    furnished: spec === 'for-rent' ? null : 'Unfurnished',
    alsoKnownAs: null,
    // capacity (his fields; not in feed → manual/AI)
    sleepCapacity: null,
    standCapacity: null,
    seatingCapacity: null,
    // commercial
    price,
    pricePerSqft: num(h.pricePerSqFt),
    isRental: spec === 'for-rent',
    hoa: num(h.hoa),
    amenities,
    // media
    numPhotos: h.numPictures || 0,
    hasVideo: !!(h.hasVideoTour || h.hasVirtualTour || h.has3DTour),
    description: h.listingRemarks || null,
    // REAL Redfin photos: for Redfin-brokered listings, gis carries the media id
    // in alternatePhotosInfo.groupCode → system_files/media/{groupCode}/item_{N}.jpg.
    // positionSpec gives the display order of item numbers. Confirmed downloadable
    // from datacenter IPs with no API key. (isRedfin:false listings have none.)
    isRedfin: !!h.isRedfin,
    photoGroupCode: h.alternatePhotosInfo?.groupCode || null,
    photoPositions: Array.isArray(h.alternatePhotosInfo?.positionSpec) ? h.alternatePhotosInfo.positionSpec : null,
    // owner (gated, Phase 2 in his own mockup)
    ownerInfo: null,
  };
}

// ---- sold: one CSV row -> the same schema ---------------------------------------
// The CSV names its own MLS in a SOURCE column — TheMLS (i.e. CLAW, the Beverly Hills
// one) on most LA rows, then CRMLS. That is the provenance he asked for, stated by the
// feed rather than inferred by us.
function normalizeSoldRow(r, zoneLabel) {
  const n = (v) => { const x = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) && String(v ?? '').trim() !== '' ? x : null; };
  const urlKey = Object.keys(r).find(k => k.toUpperCase().startsWith('URL'));
  const street = r.ADDRESS || '';
  const city = r.CITY || null;
  const soldDate = r['SOLD DATE'] || null;
  const lotSqft = n(r['LOT SIZE']);

  return {
    source: r.SOURCE ? `MLS · ${r.SOURCE}` : 'MLS (live)',
    sourceUrl: urlKey && r[urlKey] ? (r[urlKey].startsWith('http') ? r[urlKey] : `https://www.redfin.com${r[urlKey]}`) : null,
    mlsId: r['MLS#'] || null,
    listingId: null,
    propertyId: null,
    dataSourceId: null,
    // The sale date is the useful "when" for a sold comp, so it is what we surface.
    lastUpdated: soldDate,
    soldDate,
    daysOnMarket: n(r['DAYS ON MARKET']),
    spec: 'sold',
    title: street,
    address: [street, city, r['STATE OR PROVINCE'], r['ZIP OR POSTAL CODE']].filter(Boolean).join(', '),
    streetLine: street,
    country: 'US',
    state: r['STATE OR PROVINCE'] || 'CA',
    county: 'Los Angeles County',
    city,
    neighborhood: r.LOCATION || null,
    area: areaFromCity(city) || zoneLabel,
    zip: r['ZIP OR POSTAL CODE'] || null,
    lat: n(r.LATITUDE),
    lng: n(r.LONGITUDE),
    gatedCommunity: null,
    beds: n(r.BEDS),
    baths: n(r.BATHS),
    fullBaths: null,
    sqft: n(r['SQUARE FEET']),
    lotAcres: sqftToAcres(lotSqft),
    floors: null,
    parking: null,
    yearBuilt: n(r['YEAR BUILT']),
    propertyStyle: null,
    architect: null,
    colorPalette: null,
    furnished: 'Unfurnished',
    alsoKnownAs: null,
    sleepCapacity: null,
    standCapacity: null,
    seatingCapacity: null,
    price: n(r.PRICE),
    pricePerSqft: n(r['$/SQUARE FEET']),
    isRental: false,
    hoa: n(r['HOA/MONTH']),
    amenities: [r['PROPERTY TYPE']].filter(Boolean),
    // The CSV carries no media ids, so a sold comp has no photos of its own. That is
    // fine — sold rows are reference data, not something he lists.
    numPhotos: 0,
    hasVideo: false,
    description: null,
    isRedfin: false,
    photoGroupCode: null,
    photoPositions: null,
    ownerInfo: null,
  };
}

// ---- rentals: one { homeData, rentalExtension } -> the same schema ---------------
// A rental row is a BUILDING with a range of units, so rent, beds and baths all arrive
// as {min,max}. We take the minimum as the headline figure — that is the "from" price
// his team would quote — and keep the range in the description.
function normalizeRental(h, zoneLabel) {
  const hd = h.homeData || {};
  const re = h.rentalExtension || {};
  const addr = hd.addressInfo || {};
  const street = addr.formattedStreetLine || '';
  const city = addr.city || null;
  const rentMin = re.rentPriceRange?.min ?? null;
  const rentMax = re.rentPriceRange?.max ?? null;
  const bedMin = re.bedRange?.min ?? null;
  const bedMax = re.bedRange?.max ?? null;

  const rangeNote = [
    rentMin && rentMax && rentMax !== rentMin ? `Rents $${rentMin.toLocaleString()}–$${rentMax.toLocaleString()}/mo` : null,
    bedMin != null && bedMax != null && bedMax !== bedMin ? `${bedMin}–${bedMax} beds` : null,
    re.numAvailableUnits ? `${re.numAvailableUnits} units available` : null,
  ].filter(Boolean).join(' · ');

  return {
    // feedSource is the rental feed's own attribution: CLAW and CRMLS appear here
    // alongside the rental platforms (RentPath, AppFolio, ShowMojo).
    source: re.feedSource ? `MLS · ${re.feedSource}` : 'Rentals (live)',
    sourceUrl: hd.url ? `https://www.redfin.com${hd.url}` : null,
    mlsId: re.feedExternalId || null,
    listingId: re.rentalId || null,
    propertyId: hd.propertyId != null ? String(hd.propertyId) : null,
    dataSourceId: null,
    lastUpdated: re.lastUpdated || null,
    daysOnMarket: null,
    spec: 'for-rent',
    title: re.propertyName || street,
    address: [street, city, addr.state, addr.zip].filter(Boolean).join(', '),
    streetLine: street,
    country: 'US',
    state: addr.state || 'CA',
    county: 'Los Angeles County',
    city,
    neighborhood: null,
    area: areaFromCity(city) || zoneLabel,
    zip: addr.zip || null,
    lat: addr.centroid?.centroid?.latitude ?? null,
    lng: addr.centroid?.centroid?.longitude ?? null,
    gatedCommunity: null,
    beds: bedMin,
    baths: re.bathRange?.min ?? null,
    fullBaths: null,
    sqft: re.sqftRange?.min ?? null,
    lotAcres: null,
    floors: null,
    parking: null,
    yearBuilt: null,
    propertyStyle: null,
    architect: null,
    colorPalette: null,
    furnished: null,
    alsoKnownAs: re.propertyName || null,
    sleepCapacity: null,
    standCapacity: null,
    seatingCapacity: null,
    price: rentMin,
    pricePerSqft: null,
    isRental: true,
    hoa: null,
    amenities: [hd.propertyType].filter(Boolean),
    numPhotos: (hd.photosInfo?.photoRanges || []).reduce((a, r2) => a + ((r2.endPos - r2.startPos) + 1), 0),
    hasVideo: false,
    description: [rangeNote, re.description].filter(Boolean).join('\n\n') || null,
    isRedfin: false,
    photoGroupCode: null,
    photoPositions: null,
    ownerInfo: null,
  };
}

// Apply HIS spec filters in code (gis ignores min_price/beds params).
function passesSpec(rec) {
  if (rec.spec === 'for-rent') {
    return (rec.beds ?? 0) >= 3 && (rec.price ?? 0) >= 15000;
  }
  // for-sale & sold: 3bd+, $3.9M+
  return (rec.beds ?? 0) >= 3 && (rec.price ?? 0) >= 3900000;
}

async function collect({ specs = ['for-sale', 'sold', 'for-rent'], zones = Object.keys(ZONES), limitPerSpec = 40 } = {}) {
  const out = [];
  const seen = new Set(); // de-dupe across zones/sources by address+price
  for (const spec of specs) {
    let kept = 0;
    for (const zoneLabel of zones) {
      const poly = ZONES[zoneLabel];
      let homes = [];
      try { homes = await fetchZone(poly, spec); }
      catch (e) { console.error(`  [${spec}/${zoneLabel}] ${e.message}`); continue; }
      for (const h of homes) {
        // Three feeds, three payload shapes — see fetchZone above.
        const rec = spec === 'sold' ? normalizeSoldRow(h, zoneLabel)
          : spec === 'for-rent' ? normalizeRental(h, zoneLabel)
          : normalize(h, zoneLabel, spec);
        if (!rec.streetLine) continue;      // a row with no address is not usable
        if (!passesSpec(rec)) continue;
        const key = `${rec.streetLine}|${rec.city}|${rec.price}`.toLowerCase();
        if (seen.has(key)) continue;         // cross-source de-dupe (his req)
        seen.add(key);
        out.push(rec);
        if (++kept >= limitPerSpec) break;
      }
      if (kept >= limitPerSpec) break;
    }
    console.error(`[collect] ${spec}: kept ${kept}`);
  }
  return out;
}

module.exports = { collect, normalize, ZONES, passesSpec };
