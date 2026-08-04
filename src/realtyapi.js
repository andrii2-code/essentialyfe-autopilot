// RealtyAPI.io — Redfin, Realtor.com and Zillow behind one key.
//
// This exists because of a measured failure, not a preference. The free Redfin gis
// feed we fall back to carries real photos for 3 of 201 listings on his spec (0 of 132
// in Malibu) — Redfin only publishes photos for listings it brokered, and LA luxury is
// brokered by Compass, Sotheby's and Coldwell Banker. Measured 2026-08-04; see
// _probe/FINDINGS-SUMMARY.md.
//
// Through RealtyAPI every platform returns its own gallery, verified downloadable
// from this machine:
//
//   Redfin   /search/bypolygon      19 listings · 19 with photos · ~65 each
//   Realtor  /search/bypolygon      10 listings · 10 with photos · 49 on row 0
//   Zillow   /search/bycoordinates  200 listings · 200 with photos · 130 on row 0
//
// Realtor is the richest for his purposes: every row carries `source_type: "mls"` and
// the listing brokerage by name (COMPASS, Coldwell Banker, Christie's AKG, Carolwood,
// Berkshire Hathaway…), which is what "MLS first, Compass second" actually needs.
//
// TWO TRAPS, both of which fail SILENTLY inside an HTTP 200:
//   · searchType takes underscores — For_Sale / For_Rent / Sold. "ForSale" returns
//     {"message":"404: Search Type not found", searchResults: []}.
//   · Zillow's /search/bypolygon returns "404: No results" for ANY polygon. Zillow
//     must be queried with /search/bycoordinates (lat/lng/radius) instead.

const KEY = process.env.REALTYAPI_KEY || null;

// His three specs → the platform's own vocabulary.
const SEARCH_TYPE = { 'for-sale': 'For_Sale', 'sold': 'Sold', 'for-rent': 'For_Rent' };
// Zillow uses its own status wording on /search/bycoordinates.
const ZILLOW_STATUS = { 'for-sale': 'For_Sale', 'sold': 'Recently_Sold', 'for-rent': 'For_Rent' };

// The same LA luxury zones the Redfin collector uses, so switching source does not
// silently change WHICH properties he sees. Each carries a centre + radius as well,
// because Zillow cannot take a polygon.
// Radius is 5 miles rather than 3. At 3 the Zillow searches were returning mostly
// apartment inventory and missing the estate rentals entirely — widening to 5 turned
// up 90 listings at 3bd+/$15k+ in Malibu alone, topping out at $200,000/mo.
const ZONES = {
  'Beverly Hills / Bel-Air / Holmby': {
    poly: '-118.46 34.13,-118.38 34.13,-118.38 34.05,-118.46 34.05,-118.46 34.13',
    lat: 34.09, lng: -118.42, radius: 5,
  },
  'Westside / Brentwood / Pac Palisades': {
    poly: '-118.58 34.09,-118.46 34.09,-118.46 34.02,-118.58 34.02,-118.58 34.09',
    lat: 34.045, lng: -118.53, radius: 5,
  },
  'Hollywood Hills / Sunset Strip': {
    poly: '-118.40 34.13,-118.31 34.13,-118.31 34.08,-118.40 34.08,-118.40 34.13',
    lat: 34.105, lng: -118.355, radius: 5,
  },
  'Malibu coast': {
    poly: '-118.82 34.05,-118.68 34.05,-118.68 33.99,-118.82 33.99,-118.82 34.05',
    lat: 34.02, lng: -118.75, radius: 5,
  },
};

async function call(host, path, params) {
  if (!KEY) throw new Error('REALTYAPI_KEY is not set');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://${host}.realtyapi.io/${path}?${qs}`, {
    headers: { 'x-realtyapi-key': KEY, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`RealtyAPI ${host} ${res.status}`);
  const body = await res.json();
  // Quota rides on every response, so an exhausted plan is visible in the logs rather
  // than looking like "no listings today" — the failure mode the RapidAPI tier had.
  const left = res.headers.get('x-credits-remaining');
  // A 200 can still carry an error in `message`; searchResults is then empty.
  if (Array.isArray(body?.searchResults) && !body.searchResults.length && body.message
      && !/success/i.test(body.message)) {
    throw new Error(`RealtyAPI ${host}: ${body.message}`);
  }
  return { rows: body?.searchResults || body?.results || [], creditsLeft: left };
}

// ---- helpers ----------------------------------------------------------------
const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(x) ? x : null;
};
const sqftToAcres = (s) => s ? Math.round((s / 43560) * 100) / 100 : null;

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

// Redfin's row carries its gallery as ready-made CDN URLs, but buried at a path that
// varies by response. Building them by hand from propertyId produced plausible-looking
// URLs that 404 — the media id in the URL is NOT propertyId. So harvest the real URLs
// out of the payload instead of constructing them.
function harvestPhotos(obj, max = 80) {
  const out = [];
  const seen = new Set();
  (function walk(o, depth = 0) {
    if (!o || depth > 8 || out.length >= max) return;
    if (typeof o === 'string') {
      if (/^https?:\/\/\S+\.(jpg|jpeg|png|webp)(\?|$)/i.test(o) && !seen.has(o)) {
        seen.add(o);
        out.push({ url: o.replace(/^http:/, 'https:'), tag: null });
      }
      return;
    }
    if (typeof o === 'object') for (const v of Object.values(o)) walk(v, depth + 1);
  })(obj);
  return out;
}

// ---- per-platform normalisers, all onto the one schema the app already stores ----
function fromRedfin(row, zoneLabel, spec) {
  const hd = row.homeData || {};
  const gallery = harvestPhotos(row);
  const a = hd.addressInfo || {};
  const street = a.formattedStreetLine || '';
  const price = n(hd.priceInfo?.amount ?? hd.priceInfo?.homePrice?.int64Value);
  const sashes = (hd.sashes || []).map(s => s.sashTypeName).filter(Boolean);
  const brokerSash = sashes.find(s => /compass|coldwell|century 21|corcoran|sotheby/i.test(s));
  const brokerage = brokerSash ? brokerSash.replace(/\s+coming soon$/i, '') : null;

  return {
    source: brokerage ? `${brokerage} (pre-MLS)` : 'MLS · Redfin',
    brokerage,
    sourceUrl: hd.url ? `https://www.redfin.com${hd.url}` : null,
    mlsId: hd.mlsId != null ? String(hd.mlsId) : null,
    listingId: hd.listingId != null ? String(hd.listingId) : null,
    propertyId: hd.propertyId != null ? String(hd.propertyId) : null,
    spec,
    title: street, address: [street, a.city, a.state, a.zip].filter(Boolean).join(', '),
    streetLine: street, country: 'US', state: a.state || 'CA', county: 'Los Angeles County',
    city: a.city || null, neighborhood: a.location || null,
    area: areaFromCity(a.city) || zoneLabel, zip: a.zip || null,
    lat: a.centroid?.centroid?.latitude ?? null, lng: a.centroid?.centroid?.longitude ?? null,
    gatedCommunity: null,
    beds: n(hd.beds), baths: n(hd.baths), fullBaths: n(hd.fullBaths),
    sqft: n(hd.sqftInfo?.amount), lotAcres: sqftToAcres(n(hd.lotSize?.amount)),
    floors: null, parking: null, yearBuilt: n(hd.yearBuilt?.yearBuilt),
    propertyStyle: null, architect: null, colorPalette: null,
    furnished: spec === 'for-rent' ? null : 'Unfurnished', alsoKnownAs: null,
    sleepCapacity: null, standCapacity: null, seatingCapacity: null,
    price, pricePerSqft: null, isRental: spec === 'for-rent', hoa: n(hd.hoaDues?.amount),
    amenities: sashes.slice(0, 12),
    numPhotos: gallery.length, hasVideo: false, description: null,
    isRedfin: true, photoGroupCode: null, photoPositions: null,
    photoUrls: gallery,
    lastUpdated: hd.daysOnMarket?.listingAddedDate || null,
    daysOnMarket: n(hd.daysOnMarket?.daysOnMarket),
    ownerInfo: null,
  };
}

function fromRealtor(row, zoneLabel, spec) {
  const a = row.address || {};
  const street = a.line || '';
  // A rental row is a BUILDING with a range of units, so it uses *_min/*_max instead
  // of the flat fields a sale row has: list_price_min, beds_min, sqft_min. Reading
  // only `list_price` left every rental with no price and no beds, so nothing passed
  // his filter and the for-rent spec came back empty.
  const priceMin = row.list_price ?? row.list_price_min ?? null;
  const bedsVal = row.beds ?? row.beds_min ?? null;
  const bathsVal = row.baths ?? row.baths_min ?? null;
  const sqftVal = row.sqft ?? row.sqft_min ?? null;
  // Every Realtor row states its own origin, and the listing brokerage by name. This
  // is the pairing that answers "which MLS, and who listed it".
  const office = (row.advertisers || []).map(x => x.office).filter(Boolean)[0] || null;
  const photos = (row.photos || []).map(u => ({ url: String(u).replace(/^http:/, 'https:'), tag: null }));
  if (!photos.length && row.primary_photo) photos.push({ url: row.primary_photo, tag: null });

  return {
    source: row.source_type === 'mls' ? 'MLS (live)' : (row.source_type || 'Realtor (live)'),
    brokerage: office,
    sourceUrl: row.href || row.rdc_web_url || null,
    mlsId: row.listing_id != null ? String(row.listing_id) : null,
    listingId: row.listing_id != null ? String(row.listing_id) : null,
    propertyId: row.property_id != null ? String(row.property_id) : null,
    spec,
    title: street, address: [street, a.city, a.state_code, a.postal_code].filter(Boolean).join(', '),
    streetLine: street, country: 'US', state: a.state_code || 'CA', county: 'Los Angeles County',
    city: a.city || null, neighborhood: null,
    area: areaFromCity(a.city) || zoneLabel, zip: a.postal_code || null,
    lat: n(a.latitude), lng: n(a.longitude), gatedCommunity: null,
    beds: n(bedsVal), baths: n(bathsVal), fullBaths: n(row.baths_full),
    sqft: n(sqftVal), lotAcres: sqftToAcres(n(row.lot_sqft)),
    floors: null, parking: null, yearBuilt: n(row.year_built),
    propertyStyle: row.property_type ? [String(row.property_type).replace(/_/g, ' ')] : null,
    architect: null, colorPalette: null,
    furnished: spec === 'for-rent' ? null : 'Unfurnished', alsoKnownAs: null,
    sleepCapacity: null, standCapacity: null, seatingCapacity: null,
    // A sold row reports its sale price, not an asking price.
    price: n(spec === 'sold' ? (row.last_sold_price ?? row.list_price) : priceMin),
    pricePerSqft: null, isRental: spec === 'for-rent', hoa: null,
    amenities: [], numPhotos: n(row.photo_count) || photos.length,
    hasVideo: false, description: row.description?.text || null,
    isRedfin: false, photoGroupCode: null, photoPositions: null,
    photoUrls: photos,
    lastUpdated: row.last_update_date || row.list_date || null,
    daysOnMarket: null, ownerInfo: null,
  };
}

function fromZillow(row, zoneLabel, spec) {
  const p = row.property || row;
  const a = p.address || {};
  const street = a.streetAddress || '';
  const hi = p.media?.allPropertyPhotos?.highResolution || [];
  const med = p.media?.allPropertyPhotos?.medium || [];
  const one = p.media?.propertyPhotoLinks?.highResolutionLink;
  const urls = (hi.length ? hi : med.length ? med : (one ? [one] : []));

  return {
    source: 'MLS · Zillow',
    brokerage: p.propertyDisplayRules?.mls?.brokerName || null,
    sourceUrl: p.hdpView?.hdpUrl ? `https://www.zillow.com${p.hdpView.hdpUrl}` : null,
    mlsId: null,
    listingId: p.zpid != null ? String(p.zpid) : null,
    propertyId: p.zpid != null ? String(p.zpid) : null,
    spec,
    title: street, address: [street, a.city, a.state, a.zipcode].filter(Boolean).join(', '),
    streetLine: street, country: 'US', state: a.state || 'CA', county: 'Los Angeles County',
    city: a.city || null, neighborhood: null,
    area: areaFromCity(a.city) || zoneLabel, zip: a.zipcode || null,
    lat: n(p.location?.latitude), lng: n(p.location?.longitude), gatedCommunity: null,
    beds: n(p.bedrooms), baths: n(p.bathrooms), fullBaths: null,
    sqft: n(p.livingArea ?? p.livingAreaValue),
    lotAcres: p.lotSizeWithUnit?.lotSizeUnit === 'squareFeet'
      ? sqftToAcres(n(p.lotSizeWithUnit.lotSize)) : n(p.lotSizeWithUnit?.lotSize),
    floors: null, parking: null, yearBuilt: n(p.yearBuilt),
    propertyStyle: p.propertyType ? [String(p.propertyType).replace(/_/g, ' ')] : null,
    architect: null, colorPalette: null,
    furnished: spec === 'for-rent' ? null : 'Unfurnished', alsoKnownAs: null,
    sleepCapacity: null, standCapacity: null, seatingCapacity: null,
    price: n(p.price?.value ?? p.hdpView?.price),
    pricePerSqft: n(p.price?.pricePerSquareFoot),
    isRental: spec === 'for-rent', hoa: null, amenities: [],
    numPhotos: urls.length, hasVideo: false, description: null,
    isRedfin: false, photoGroupCode: null, photoPositions: null,
    photoUrls: urls.map(u => ({ url: u, tag: null })),
    lastUpdated: null, daysOnMarket: n(p.daysOnZillow), ownerInfo: null,
  };
}

// ---- his filters, applied in code (the APIs accept some but not all) ----
function passesSpec(rec) {
  if (rec.spec === 'for-rent') {
    const rent = rec.price ?? 0;
    return (rec.beds ?? 0) >= 3 && rent >= 15000 && rent <= 150000;
  }
  return (rec.beds ?? 0) >= 3 && (rec.price ?? 0) >= 3900000;
}

// ---- collect ----------------------------------------------------------------
// Three platforms, deduped on address. Order matters: Realtor first because it is the
// only one that states the MLS and the brokerage on every row, so when the same
// property appears twice we keep the copy carrying that attribution.
const PLATFORMS = ['realtor', 'redfin', 'zillow'];

// Rentals are the exception to that order. Realtor's for-rent feed is apartment
// inventory — measured $944 to $11,750 across 40 rows, nothing near his floor — and
// Redfin returns rentals with no price at all. Zillow is the only one carrying estate
// rentals (90 at 3bd+/$15k+ in Malibu, up to $200,000/mo), so it leads for this spec.
const PLATFORM_ORDER = { 'for-rent': ['zillow', 'realtor', 'redfin'] };

async function collectPlatform(platform, zoneLabel, zone, spec, limit) {
  if (platform === 'zillow') {
    const status = ZILLOW_STATUS[spec];
    if (!status) return [];
    const { rows } = await call('zillow', 'search/bycoordinates', {
      latitude: zone.lat, longitude: zone.lng, radius: zone.radius, listingStatus: status,
    });
    return rows.slice(0, limit).map(r => fromZillow(r, zoneLabel, spec));
  }
  // Push his floor into the query rather than filtering after the fact. Without it a
  // page comes back full of $700k condos, every one is discarded by passesSpec(), and
  // the platform looks broken when it is simply being asked the wrong question.
  const params = {
    polygon: zone.poly, searchType: SEARCH_TYPE[spec], resultCount: String(Math.min(limit, 50)),
  };
  if (spec === 'for-rent') {
    if (platform === 'redfin') { params.minPrice = '15000'; params.minBeds = '3'; }
    else { params.priceRange = '15000-150000'; params.bedsRange = '3-'; }
  } else {
    if (platform === 'redfin') { params.minPrice = '3900000'; params.minBeds = '3'; }
    else { params.priceRange = '3900000-'; params.bedsRange = '3-'; }
  }
  const { rows } = await call(platform, 'search/bypolygon', params);
  return rows.map(r => platform === 'realtor'
    ? fromRealtor(r, zoneLabel, spec)
    : fromRedfin(r, zoneLabel, spec));
}

async function collect({
  specs = ['for-sale', 'sold', 'for-rent'],
  zones = Object.keys(ZONES),
  platforms = PLATFORMS,
  limitPerSpec = 40,
} = {}) {
  const out = [];
  const seen = new Set();          // address+price, across every platform
  for (const spec of specs) {
    let kept = 0;
    for (const zoneLabel of zones) {
      const zone = ZONES[zoneLabel];
      if (!zone) continue;
      const order = (PLATFORM_ORDER[spec] || platforms).filter(p => platforms.includes(p));
      for (const platform of order) {
        if (kept >= limitPerSpec) break;
        let recs = [];
        try { recs = await collectPlatform(platform, zoneLabel, zone, spec, limitPerSpec); }
        catch (e) { console.error(`  [${platform}/${spec}/${zoneLabel}] ${e.message}`); continue; }
        for (const rec of recs) {
          if (!rec.streetLine) continue;
          if (!passesSpec(rec)) continue;
          const key = `${rec.streetLine}|${rec.city}|${rec.price}`.toLowerCase();
          if (seen.has(key)) continue;      // same property from another platform
          seen.add(key);
          out.push(rec);
          if (++kept >= limitPerSpec) break;
        }
      }
      if (kept >= limitPerSpec) break;
    }
    console.error(`[realtyapi] ${spec}: kept ${kept}`);
  }
  return out;
}

module.exports = {
  collect, passesSpec, ZONES, PLATFORMS,
  fromRedfin, fromRealtor, fromZillow,
};
