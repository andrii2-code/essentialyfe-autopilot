// Orchestration: the "all-day collector" + the on-approval processing pipeline.
const { collect: collectRedfin } = require('./redfin');
const { collect: collectRealtor } = require('./realtor');
const { collect: collectRealtyApi } = require('./realtyapi');
const { enrich } = require('./enrich');
const { processImage, TARGET } = require('./images');
const { deliverToDrive } = require('./drive');
const { photosFor } = require('./photos');
const { upsertListing, q } = require('./db');

// Source selection: Realtor.com (RapidAPI) is primary — it carries the FULL real
// photo gallery per listing. Falls back to the Redfin gis feed if RAPIDAPI_KEY is
// absent or the realtor call yields nothing (so the app still runs either way).
async function collectListings(opts) {
  // RealtyAPI first: it is the only source that carries real photos on HIS spec.
  // Measured 2026-08-04 — the free Redfin gis feed below has photos on 3 of 201
  // listings at 3bd+/$3.9M+ (0 of 132 in Malibu), because Redfin only publishes
  // photos for listings it brokered and LA luxury is brokered by Compass, Sotheby's
  // and Coldwell Banker. Through RealtyAPI the same search returns 100% coverage at
  // ~51 photos per listing, across Realtor, Redfin and Zillow together.
  if (process.env.REALTYAPI_KEY) {
    try {
      const recs = await collectRealtyApi(opts);
      if (recs.length) return recs;
    } catch (e) { console.error('[collect] realtyapi:', e.message); }
  }
  if (process.env.RAPIDAPI_KEY) {
    try {
      const recs = await collectRealtor(opts);
      if (recs.length) return recs;
    } catch (e) { /* fall through to redfin */ }
  }
  return collectRedfin(opts);
}

// ---- collector: pull real listings, enrich, store in review queue ----
// Reports three things, because a re-list at a new price is neither "new" nor nothing:
// how many properties he had never seen, and how many known ones moved price.
async function runCollector({ limitPerSpec = 12 } = {}) {
  const recs = await collectListings({ limitPerSpec });

  // Which of these do we already hold? One query up front, so a property he already has
  // is recognised BEFORE any work is done on it. Previously every listing went through
  // enrich() — an AI call — even when it was about to be discarded as a duplicate.
  const known = await q.knownProperties(
    recs.map(r => ({ streetLine: r.streetLine, city: r.city })));
  const keyOf = (r) => `${(r.streetLine || '').toLowerCase().trim()}|${(r.city || '').toLowerCase().trim()}`;

  let kept = 0, skipped = 0;
  const priceChanges = [];

  for (const r of recs) {
    const seen = known.get(keyOf(r));

    if (seen) {
      // Already his. The only thing still worth recording is a price move, and that
      // needs no enrichment — just the new price against the stored one.
      if (r.price != null && Number(r.price) !== Number(seen.price)) {
        const res = await upsertListing(r);
        if (res.priceChanged) {
          priceChanges.push({ id: res.id, address: r.streetLine || r.address, from: res.from, to: res.to });
        }
      } else {
        skipped++;   // identical to what he has: don't download, don't enrich, don't store
      }
      continue;
    }

    const enriched = await enrich(r);
    const res = await upsertListing(enriched);
    if (res.inserted) kept++;
    else if (res.priceChanged) {
      priceChanges.push({ id: res.id, address: enriched.streetLine || enriched.address, from: res.from, to: res.to });
    }
  }

  const note = `collector: ${kept} new of ${recs.length}`
    + (skipped ? `, ${skipped} already yours (skipped)` : '')
    + (priceChanges.length ? `, ${priceChanges.length} price change${priceChanges.length === 1 ? '' : 's'}` : '');
  await q.newRun(recs.length, kept, note);
  return { sourced: recs.length, kept, skipped, priceChanges };
}

// ---- on approval: run the image pipeline for real, then hand to Drive ----
async function processApproved(id, onProgress = () => {}) {
  const listing = await q.get(id);
  if (!listing) throw new Error('listing not found');
  await q.setStatus(id, 'processing');
  onProgress({ stage: 'start', id });

  const amenities = listing.amenities || [];
  const seenHashes = [];
  const processed = [];
  // Real per-listing photos with their REAL room tags when available (realtor.com);
  // otherwise Redfin real photos, else the per-listing-distinct pool. Each item is
  // { url, tag } — a non-null tag is the source's own room label for that photo.
  const { source: photoSource, items } = photosFor(listing);
  onProgress({ stage: 'photos', source: photoSource, count: items.length });

  for (let i = 0; i < items.length; i++) {
    try {
      const res = await processImage(items[i].url, i, amenities, seenHashes, items[i].tag);
      if (res.skipped) { onProgress({ stage: 'skip', i, reason: res.reason }); continue; }
      processed.push(res);
      onProgress({ stage: 'image', i, tag: res.tag, bytes: res.bytes });
    } catch (e) { onProgress({ stage: 'error', i, error: e.message }); }
  }

  const delivery = await deliverToDrive(listing, processed);
  const ready_at = new Date().toISOString();

  // strip heavy buffers before persisting
  const imageRecords = processed.map((p, i) => ({
    name: delivery.manifest[i]?.name,
    // The Drive file id lets the app show the CLEANED image instead of the original
    // source photo, which still carries the MLS watermark.
    driveFileId: delivery.manifest[i]?.driveFileId || null,
    tag: p.tag, bytes: p.bytes, jpegQuality: p.jpegQuality,
    steps: p.steps, quality: p.quality,
  }));

  await q.setStatus(id, 'ready', {
    ready_at,
    drive_folder_id: delivery.folderId,
    drive_folder_url: delivery.folderUrl,
    images: imageRecords,
  });
  onProgress({ stage: 'done', id, count: processed.length, drive: delivery.mode });
  return { id, processed: processed.length, delivery, images: imageRecords };
}

module.exports = { runCollector, processApproved, TARGET };
