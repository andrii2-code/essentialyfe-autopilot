// Real photos for properties that came from HIS spreadsheet.
//
// His 6,789 rows carry an address and a link to a Drive/Dropbox FOLDER — never
// individual image URLs — so an imported property has nothing for the gallery to draw
// and falls back to library images that are not the house. Zillow's /propimages takes
// an ADDRESS, which is the one thing every one of his rows has, so the gap is
// closable without him doing anything.
//
// Measured on five real addresses from his sheet: 5/5 returned something, every URL
// downloaded as JPEG from this machine. But two of those five were a Google Street
// View frame rather than listing photography — a picture of the street, not the
// property — so `streetViewOnly` is reported separately and never counted as a
// gallery. Passing that off as his photos would be exactly the stock-image problem
// he already caught once.

const HOST = 'zillow.realtyapi.io';

// One URL per photo. Each entry in originalPhotos carries the same shot at several
// widths under mixedSources.jpeg; take the widest. Walking the payload naively counts
// every size variant and reports 1,681 photos for a 210-photo listing.
function widestJpegs(payload) {
  const out = [];
  for (const p of (payload?.originalPhotos || [])) {
    const jpegs = p?.mixedSources?.jpeg || [];
    if (!jpegs.length) { if (p?.url) out.push(p.url); continue; }
    const best = jpegs.reduce((a, b) => (b.width || 0) > (a.width || 0) ? b : a);
    if (best?.url) out.push(best.url);
  }
  return out;
}

const isStreetView = (u) => /maps\.googleapis\.com\/maps\/api\/streetview/i.test(u || '');

// Look up one address. Returns { photos:[{url,tag}], streetViewOnly, propertyUrl }.
// Never throws: an address that Zillow does not know is a normal outcome across
// thousands of rows, not an error worth aborting a backfill for.
async function photosForAddress(address, { key = process.env.REALTYAPI_KEY } = {}) {
  const empty = { photos: [], streetViewOnly: false, propertyUrl: null, creditsLeft: null };
  if (!key || !address) return empty;

  let res;
  try {
    res = await fetch(`https://${HOST}/propimages?byaddress=${encodeURIComponent(address)}`,
      { headers: { 'x-realtyapi-key': key, accept: 'application/json' } });
  } catch { return empty; }
  if (!res.ok) return { ...empty, creditsLeft: res.headers.get('x-credits-remaining') };

  const body = await res.json().catch(() => null);
  const creditsLeft = res.headers.get('x-credits-remaining');
  if (!body) return { ...empty, creditsLeft };

  let urls = widestJpegs(body);
  // Fall back to the single hero image only when there is no gallery at all.
  if (!urls.length && body.hiResImageLink) urls = [body.hiResImageLink];

  const real = urls.filter(u => !isStreetView(u));
  // Nothing but a street-view frame means Zillow has no photography for this address.
  // Report it rather than dressing it up as a gallery.
  if (!real.length) {
    return { photos: [], streetViewOnly: urls.length > 0, propertyUrl: body.propertyURL || null, creditsLeft };
  }
  return {
    photos: real.map(u => ({ url: u, tag: null })),
    streetViewOnly: false,
    propertyUrl: body.propertyURL || null,
    creditsLeft,
  };
}

// Backfill a batch of listings. `rows` are DB rows; only those with an address and no
// gallery are looked up, so re-running it costs nothing for rows already done.
//
// Credits are finite (250/month on the free tier), so `limit` is a hard stop and the
// caller decides how much of his 6,789 to spend on. onProgress reports every row so a
// long run is observable rather than silent.
async function backfill(rows, { key = process.env.REALTYAPI_KEY, limit = 50, onProgress = () => {} } = {}) {
  const out = [];
  let used = 0, withPhotos = 0, streetViewOnly = 0, notFound = 0;

  for (const row of rows) {
    if (used >= limit) break;
    const already = Array.isArray(row.photo_urls) ? row.photo_urls.length
      : (typeof row.photo_urls === 'string' && row.photo_urls.length > 4);
    if (already) continue;
    const address = row.address || [row.street_line, row.city, row.state, row.zip].filter(Boolean).join(', ');
    if (!address) continue;

    const r = await photosForAddress(address, { key });
    used++;
    if (r.photos.length) { withPhotos++; out.push({ id: row.id, address, photos: r.photos, propertyUrl: r.propertyUrl }); }
    else if (r.streetViewOnly) streetViewOnly++;
    else notFound++;
    onProgress({ used, limit, address, found: r.photos.length, streetViewOnly: r.streetViewOnly, creditsLeft: r.creditsLeft });
  }
  return { updates: out, used, withPhotos, streetViewOnly, notFound };
}

module.exports = { photosForAddress, backfill, widestJpegs, isStreetView };
