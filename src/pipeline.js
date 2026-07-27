// Orchestration: the "all-day collector" + the on-approval processing pipeline.
const { collect: collectRedfin } = require('./redfin');
const { collect: collectRealtor } = require('./realtor');
const { enrich } = require('./enrich');
const { processImage, TARGET } = require('./images');
const { deliverToDrive } = require('./drive');
const { photosFor } = require('./photos');
const { upsertListing, q } = require('./db');

// Source selection: Realtor.com (RapidAPI) is primary — it carries the FULL real
// photo gallery per listing. Falls back to the Redfin gis feed if RAPIDAPI_KEY is
// absent or the realtor call yields nothing (so the app still runs either way).
async function collectListings(opts) {
  if (process.env.RAPIDAPI_KEY) {
    try {
      const recs = await collectRealtor(opts);
      if (recs.length) return recs;
    } catch (e) { /* fall through to redfin */ }
  }
  return collectRedfin(opts);
}

// ---- collector: pull real listings, enrich, store in review queue ----
async function runCollector({ limitPerSpec = 12 } = {}) {
  const recs = await collectListings({ limitPerSpec });
  let kept = 0;
  for (const r of recs) {
    const enriched = await enrich(r);
    if (upsertListing(enriched)) kept++;
  }
  q.newRun(recs.length, kept, `collector: ${kept} new of ${recs.length}`);
  return { sourced: recs.length, kept };
}

// ---- on approval: run the image pipeline for real, then hand to Drive ----
async function processApproved(id, onProgress = () => {}) {
  const listing = q.get(id);
  if (!listing) throw new Error('listing not found');
  q.setStatus(id, 'processing');
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
    tag: p.tag, bytes: p.bytes, jpegQuality: p.jpegQuality,
    steps: p.steps, quality: p.quality,
  }));

  q.setStatus(id, 'ready', {
    ready_at,
    drive_folder_id: delivery.folderId,
    drive_folder_url: delivery.folderUrl,
    images: imageRecords,
  });
  onProgress({ stage: 'done', id, count: processed.length, drive: delivery.mode });
  return { id, processed: processed.length, delivery, images: imageRecords };
}

module.exports = { runCollector, processApproved, TARGET };
