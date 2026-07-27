// Per-listing photo sourcing.
//
// PRIMARY (real photos): Redfin-brokered listings (isRedfin:true, ~22% of LA) carry
// their media id in gis as alternatePhotosInfo.groupCode. The real photos live at
//   https://ssl.cdn-redfin.com/system_files/media/{groupCode}/item_{N}.jpg
// with N drawn from positionSpec (display order). This CDN is NOT IP-gated, so the
// REAL listing photos download from any server, no API key. Verified end to end.
//
// FALLBACK (no real photos): for isRedfin:false listings gis exposes no media id
// reachable from a datacenter IP (confirmed exhaustively). Those get a deterministic,
// per-listing-distinct subset of a large license-free pool so no two listings match.

const { POOL, pickImages } = require('./image-pool');

const CDN = 'https://ssl.cdn-redfin.com/system_files/media';

// Build real Redfin photo URLs for a listing, or null if not available.
function realRedfinPhotos(listing, max = 9) {
  const gc = listing.photoGroupCode;
  if (!gc) return null;
  // positionSpec holds the display order of item numbers; fall back to 1..numPhotos.
  let positions = Array.isArray(listing.photoPositions) && listing.photoPositions.length
    ? listing.photoPositions.slice()
    : Array.from({ length: Math.max(1, listing.num_photos || listing.numPhotos || 7) }, (_, i) => i + 1);
  positions = positions.slice(0, max);
  return positions.map((n) => `${CDN}/${gc}/item_${n}.jpg`);
}

// Parse a stored photo_urls value (JSON string from DB, or array in-memory).
// Each entry is either a URL string (legacy) or { url, tag } (realtor.com, tag =
// the real per-photo room label). Returns [{ url, tag }].
function galleryUrls(listing) {
  let g = listing.photo_urls ?? listing.photoUrls ?? null;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  if (!Array.isArray(g)) return null;
  return g.map((e) => (e && typeof e === 'object') ? { url: e.url, tag: e.tag || null } : { url: e, tag: null })
          .filter((e) => e.url);
}

// Returns { source, items:[{url, tag}] } for a listing. Priority:
//  1) realtor.com FULL gallery with REAL per-photo room tags
//  2) real Redfin photos via groupCode (no per-photo tag → tag null)
//  3) diverse license-free pool (per-listing-distinct) as a last resort
function photosFor(listing, max = 12) {
  const gallery = galleryUrls(listing);
  if (gallery && gallery.length) return { source: 'realtor-real', items: gallery.slice(0, max) };

  const real = realRedfinPhotos(listing);
  if (real && real.length) return { source: 'redfin-real', items: real.map((url) => ({ url, tag: null })) };

  const id = listing.id ?? listing.listing_id ?? listing.listingId ?? listing.address ?? '0';
  const n = listing.num_photos || listing.numPhotos || 7;
  return { source: 'pool', items: pickImages(id, n, POOL).map((url) => ({ url, tag: null })) };
}

module.exports = { photosFor, realRedfinPhotos };
