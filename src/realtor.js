// Real-data source #2: Realtor.com listings via RapidAPI (apimaker "US Real Estate
// Listings", host us-real-estate-listings.p.rapidapi.com). Unlike the Redfin gis
// feed, this returns the FULL photo gallery (photo_count + photos[], 20-49 real
// rdcpix images) AND the full listing description AND amenity tags in ONE search
// call per spec — no per-listing detail call needed.
//
// Photos are real MLS listing photography on ap.rdcpix.com; we request a full-size
// render by swapping the thumbnail suffix. Needs RAPIDAPI_KEY (RapidAPI account key,
// with the "US Real Estate Listings" API subscribed).

const HOST = 'us-real-estate-listings.p.rapidapi.com';
const KEY = process.env.RAPIDAPI_KEY || null;

// his three specs → apimaker endpoints
const SPEC_ENDPOINT = {
  'for-sale': 'for-sale',
  'sold': 'sold-homes',
  'for-rent': 'for-rent',
};

// LA luxury areas to sweep (apimaker takes a free-text location).
const LOCATIONS = [
  'Beverly Hills, CA',
  'Bel Air, Los Angeles, CA',
  'Malibu, CA',
  'Pacific Palisades, Los Angeles, CA',
  'Hollywood Hills, Los Angeles, CA',
  'Brentwood, Los Angeles, CA',
];

// rdcpix thumbnails end in "...s.jpg" or "...s-w1024_h768.jpg"; force a full-size render.
function fullSize(href, w = 1024, h = 768) {
  if (!href) return href;
  let u = href.replace(/^http:/, 'https:');
  // strip any existing size suffix after the trailing "s"
  u = u.replace(/s(-w\d+_h\d+)?\.(jpg|webp)$/i, `s-w${w}_h${h}.jpg`);
  return u;
}

// realtor.com's per-photo AI label → clean, human room name (so filenames match content).
const LABEL_ROOM = {
  aerial_view: 'Aerial View', house_view: 'Exterior', exterior: 'Exterior', front_of_structure: 'Front Elevation',
  living_room: 'Living Room', family_room: 'Family Room', great_room: 'Great Room',
  kitchen: 'Kitchen', dining_room: 'Dining Room', breakfast_nook: 'Breakfast Nook',
  bedroom: 'Bedroom', primary_bedroom: 'Primary Suite', master_bedroom: 'Primary Suite',
  bathroom: 'Bathroom', primary_bathroom: 'Primary Bath',
  home_office: 'Home Office', den: 'Den', recreation_room: 'Recreation Room', gymnasium: 'Gym',
  home_theater: 'Home Theater', wine_cellar: 'Wine Cellar', laundry_room: 'Laundry',
  swimming_pool: 'Pool', pool: 'Pool', patio: 'Patio', balcony: 'Balcony', deck: 'Deck',
  yard: 'Yard', backyard: 'Backyard', garden: 'Garden', garage: 'Garage', door: 'Entry',
  closet: 'Closet', hallway: 'Hallway', staircase: 'Staircase', foyer: 'Foyer',
  other_interiors: 'Interior', other_rooms: 'Interior', condo: 'Interior', view: 'View',
};
function roomFromLabel(label) {
  if (!label) return null;
  return LABEL_ROOM[label] || label.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

// Labels that are too generic to describe the photo ("Interior" tells you nothing
// about which room). When the top label is one of these but a lower-ranked label is
// specific, we prefer the specific one so the filename actually names the room.
const VAGUE_ROOMS = new Set(['Interior', 'Exterior', 'View', 'Other', 'Unknown']);

// realtor.com gives each photo a tags[] list of {label, probability}. The list is
// NOT reliably ordered by confidence — e.g. a photo can come back as
// [door:0.75, patio:0.95, porch:0.75], where "door" is first but "patio" is the
// confident call. So we rank by probability, and among the strong candidates prefer
// a SPECIFIC room over a vague one ("Interior"). Only fall back to a vague label when
// no specific label has meaningful confidence.
function bestRoomTag(photo) {
  const tags = (Array.isArray(photo?.tags) ? photo.tags : [])
    .map((t) => ({ room: roomFromLabel(t?.label), p: t?.probability ?? 0 }))
    .filter((t) => t.room);
  if (!tags.length) return null;

  const specific = tags.filter((t) => !VAGUE_ROOMS.has(t.room)).sort((a, b) => b.p - a.p);
  const vague = tags.filter((t) => VAGUE_ROOMS.has(t.room)).sort((a, b) => b.p - a.p);

  // Take the most confident specific room if it is reasonably sure; otherwise, if the
  // vague label is far more confident, keep the vague one (the photo really is ambiguous).
  if (specific.length && (specific[0].p >= 0.5 || !vague.length || specific[0].p >= vague[0].p * 0.6)) {
    return specific[0].room;
  }
  return (vague[0] || specific[0]).room;
}

async function fetchSpec(location, spec, limit = 20) {
  if (!KEY) throw new Error('RAPIDAPI_KEY not set');
  const ep = SPEC_ENDPOINT[spec] || 'for-sale';
  const url = `https://${HOST}/${ep}?location=${encodeURIComponent(location)}&offset=0&limit=${limit}&sortBy=newest`;
  const res = await fetch(url, {
    headers: { 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST },
  });
  if (!res.ok) throw new Error(`apimaker ${res.status} for ${spec} @ ${location}`);
  const data = await res.json();
  if (data.message) throw new Error(`apimaker: ${data.message}`);
  return data.listings || [];
}

const acres = (sqft) => sqft ? Math.round((sqft / 43560) * 100) / 100 : null;

function areaFromCity(city) {
  if (!city) return null;
  const c = city.toLowerCase();
  if (/beverly hills/.test(c)) return 'Beverly Hills';
  if (/bel.?air|holmby/.test(c)) return 'Bel-Air / Holmby Hills';
  if (/malibu/.test(c)) return 'Malibu';
  if (/pacific palisades/.test(c)) return 'Pacific Palisades';
  if (/brentwood/.test(c)) return 'Brentwood';
  if (/santa monica/.test(c)) return 'Santa Monica';
  if (/hollywood/.test(c)) return 'Hollywood Hills';
  if (/los angeles/.test(c)) return 'Los Angeles';
  return city;
}

// tag slug → human amenity ("central_air" → "Central Air")
const humanizeTag = (t) => String(t).replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

function normalize(l, spec) {
  const de = l.description || {};
  const addr = l.location?.address || {};
  const beds = de.beds ?? null;
  const price = spec === 'sold' ? (de.sold_price ?? l.list_price ?? null) : (l.list_price ?? null);
  // Keep each photo's REAL per-photo AI room label so filenames match content.
  // Use the best (most specific) of the photo's ranked labels, not just the first.
  const photos = Array.isArray(l.photos)
    ? l.photos.map((p) => ({ url: fullSize(p.href), tag: bestRoomTag(p) })).filter((p) => p.url)
    : [];
  const amenities = Array.isArray(l.tags) ? l.tags.slice(0, 24).map(humanizeTag) : [];

  return {
    source: 'Realtor.com (live)',
    sourceUrl: l.href || (l.permalink ? `https://www.realtor.com/realestateandhomes-detail/${l.permalink}` : null),
    mlsId: l.source?.id || null,
    listingId: l.listing_id || null,
    propertyId: l.property_id || null,
    dataSourceId: null,
    lastUpdated: l.list_date ? 'active' : null,
    daysOnMarket: null,
    spec,
    title: addr.line || `${addr.city || ''}`.trim(),
    address: [addr.line, addr.city, addr.state_code, addr.postal_code].filter(Boolean).join(', '),
    streetLine: addr.line || null,
    country: addr.country || 'US',
    state: addr.state_code || 'CA',
    county: l.location?.county?.name ? `${l.location.county.name} County` : 'Los Angeles County',
    city: addr.city || null,
    neighborhood: (l.location?.neighborhoods && l.location.neighborhoods[0]?.name) || null,
    area: areaFromCity(addr.city),
    zip: addr.postal_code || null,
    lat: addr.coordinate?.lat ?? null,
    lng: addr.coordinate?.lon ?? null,
    gatedCommunity: (l.tags || []).includes('gated_community') ? 'Yes' : null,
    beds,
    baths: de.baths ?? null,
    fullBaths: de.baths_full ?? null,
    sqft: de.sqft ?? null,
    lotAcres: acres(de.lot_sqft),
    floors: de.stories ?? null,
    parking: de.garage ?? null,
    yearBuilt: de.year_built ?? null,
    propertyStyle: de.type ? [humanizeTag(de.type)] : null,
    architect: null,
    colorPalette: null,
    furnished: spec === 'for-rent' ? null : 'Unfurnished',
    alsoKnownAs: de.name || null,
    sleepCapacity: null, standCapacity: null, seatingCapacity: null,
    price,
    pricePerSqft: (price && de.sqft) ? Math.round(price / de.sqft) : null,
    isRental: spec === 'for-rent',
    hoa: l.hoa?.fee ?? null,
    amenities,
    numPhotos: l.photo_count || photos.length || 0,
    hasVideo: !!(l.virtual_tours?.length || (l.matterports && l.matterports.length)),
    description: de.text || null,
    // FULL real photo gallery — the whole point of this source.
    photoUrls: photos,
    isRedfin: false,
    photoGroupCode: null,
    photoPositions: null,
    ownerInfo: null,
  };
}

// His spec filters (apimaker's price/bed filter params are unreliable, so filter in code).
function passesSpec(rec) {
  const beds = rec.beds || 0;
  if (rec.spec === 'for-rent') return beds >= 3 && rec.price != null && rec.price >= 15000;
  return beds >= 3 && rec.price != null && rec.price >= 3900000;
}

async function collect({ specs = ['for-sale', 'sold', 'for-rent'], limitPerSpec = 12 } = {}) {
  const out = [];
  const seen = new Set();
  for (const spec of specs) {
    let kept = 0;
    for (const loc of LOCATIONS) {
      if (kept >= limitPerSpec) break;
      let listings = [];
      try { listings = await fetchSpec(loc, spec, 20); } catch (e) { continue; }
      for (const l of listings) {
        if (kept >= limitPerSpec) break;
        const rec = normalize(l, spec);
        if (!passesSpec(rec)) continue;
        // Identity = property (address), not price — matches the DB UNIQUE(street_line, city)
        // so a re-listed home at a new price is still recognised as the same property.
        const key = `${(rec.streetLine || '').toLowerCase().trim()}|${(rec.city || '').toLowerCase().trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
        kept++;
      }
    }
  }
  return out;
}

module.exports = { collect, normalize, fullSize, bestRoomTag, roomFromLabel };
