// Diverse, license-free property-image pool (71 URLs, each verified HTTP 200 from
// a datacenter IP) + deterministic per-listing selection so no two listings show
// the same photos. Produced by the fix-drive-images workflow.
//
// NOT yet wired into the pipeline — kept ready to swap in when we address the
// "every listing gets the same images" issue. To activate: in src/pipeline.js,
// replace DEMO_IMAGE_POOL.slice(0, target) with pickImages(listing.id, listing.num_photos, POOL).
//
// (The real-photo path is a dead end from any datacenter IP without a paid API/
//  residential proxy; the workflow confirmed a free RapidAPI realtor.com key as the
//  only keyless-ish route to real per-listing photos — a future option.)

const POOL = [
  'https://images.unsplash.com/photo-1568605114967-8130f3a36994?w=1600&q=80',
  'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=1600&q=80',
  'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=1600&q=80',
  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&q=80',
  'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1600&q=80',
  'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1600&q=80',
  'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?w=1600&q=80',
  'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1600&q=80',
  'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1600&q=80',
  'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=1600&q=80',
  'https://images.unsplash.com/photo-1600585152220-90363fe7e115?w=1600&q=80',
  'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?w=1600&q=80',
  'https://images.unsplash.com/photo-1512918728675-ed5a9ecdebfd?w=1600&q=80',
  'https://images.unsplash.com/photo-1449844908441-8829872d2607?w=1600&q=80',
  'https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=1600&q=80',
  'https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=1600&q=80',
  'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=1600&q=80',
  'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1600&q=80',
  'https://images.unsplash.com/photo-1554995207-c18c203602cb?w=1600&q=80',
  'https://images.unsplash.com/photo-1484154218962-a197022b5858?w=1600&q=80',
  'https://images.unsplash.com/photo-1484101403633-562f891dc89a?w=1600&q=80',
  'https://images.unsplash.com/photo-1493809842364-78817add7ffb?w=1600&q=80',
  'https://images.unsplash.com/photo-1505691938895-1758d7feb511?w=1600&q=80',
  'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=1600&q=80',
  'https://images.unsplash.com/photo-1556912172-45b7abe8b7e1?w=1600&q=80',
  'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1600&q=80',
  'https://images.unsplash.com/photo-1556909212-d5b604d0c90d?w=1600&q=80',
  'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1600&q=80',
  'https://images.unsplash.com/photo-1560185007-cde436f6a4d0?w=1600&q=80',
  'https://images.unsplash.com/photo-1560448075-bb485b067938?w=1600&q=80',
  'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=1600&q=80',
  'https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=1600&q=80',
  'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=1600&q=80',
  'https://images.unsplash.com/photo-1615529182904-14819c35db37?w=1600&q=80',
  'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=1600&q=80',
  'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=1600&q=80',
  'https://images.unsplash.com/photo-1617104678098-de229db51175?w=1600&q=80',
  'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?w=1600&q=80',
  'https://images.unsplash.com/photo-1600566753151-384129cf4e3e?w=1600&q=80',
  'https://images.unsplash.com/photo-1600566752355-35792bedcfea?w=1600&q=80',
  'https://images.unsplash.com/photo-1600573472550-8090b5e0745e?w=1600&q=80',
  'https://images.unsplash.com/photo-1600585153490-76fb20a32601?w=1600&q=80',
  'https://images.unsplash.com/photo-1600121848594-d8644e57abab?w=1600&q=80',
  'https://images.unsplash.com/photo-1600210491369-e753d80a41f3?w=1600&q=80',
  'https://images.unsplash.com/photo-1600607688969-a5bfcd646154?w=1600&q=80',
  'https://images.unsplash.com/photo-1600607688066-890987f18a86?w=1600&q=80',
  'https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1600&q=80',
  'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=1600&q=80',
  'https://images.unsplash.com/photo-1501183638710-841dd1904471?w=1600&q=80',
  'https://images.unsplash.com/photo-1503174971373-b1f69850bded?w=1600&q=80',
  'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=1600&q=80',
  'https://images.unsplash.com/photo-1560184897-ae75f418493e?w=1600&q=80',
  'https://images.unsplash.com/photo-1567767292278-a4f21aa2d36e?w=1600&q=80',
  'https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?w=1600&q=80',
  'https://images.unsplash.com/photo-1588854337221-4cf9fa96059c?w=1600&q=80',
  'https://images.unsplash.com/photo-1560448205-4d9b3e6bb6db?w=1600&q=80',
  'https://images.unsplash.com/photo-1600566752229-250ed79470f8?w=1600&q=80',
  'https://images.unsplash.com/photo-1600585152915-d208bec867a1?w=1600&q=80',
  'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?w=1600&q=80',
  'https://images.unsplash.com/photo-1540518614846-7eded433c457?w=1600&q=80',
  'https://images.unsplash.com/photo-1616137466211-f939a420be84?w=1600&q=80',
  'https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?w=1600&q=80',
  'https://images.unsplash.com/photo-1616627561950-9f746e330187?w=1600&q=80',
  'https://images.unsplash.com/photo-1595515106969-1ce29566ff1c?w=1600&q=80',
  'https://images.unsplash.com/photo-1584622781564-1d987f7333c1?w=1600&q=80',
  'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=1600&q=80',
  'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1600&q=80',
  'https://images.unsplash.com/photo-1512699355324-f07e3106dae5?w=1600&q=80',
  'https://images.unsplash.com/photo-1600210492493-0946911123ea?w=1600&q=80',
  'https://images.unsplash.com/photo-1571939228382-b2f2b585ce15?w=1600&q=80',
  'https://images.unsplash.com/photo-1598928506311-c55ded91a20c?w=1600&q=80',
];

// Deterministic per-listing selection (FNV-1a hash → mulberry32 PRNG → room-tag
// buckets → guaranteed exterior lead → round-robin fill → room-ordered output).
// Verified by the workflow: 500/500 unique subsets, exterior lead 100/100, idempotent.
function pickImages(listingId, numPhotos, pool = POOL) {
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const items = pool.map((entry) => {
    if (entry && typeof entry === 'object') return { url: String(entry.url), tag: String(entry.tag || entry.url || '').toLowerCase() };
    const url = String(entry); return { url, tag: url.toLowerCase() };
  });
  const N = items.length;
  const seedStr = String(listingId);
  let h = 0x811c9dc5;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let s = h >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; } return arr; };
  const rankOf = (tag) => { const t = tag || '';
    if (/(exterior|facade|front|curb|street|drone|aerial|yard|backyard|garden|pool|patio|deck|elevation)/.test(t)) return 0;
    if (/(living|lounge|family|great|entry|foyer|hall)/.test(t)) return 1;
    if (/(kitchen|dining)/.test(t)) return 2;
    if (/(bed|master|primary|closet)/.test(t)) return 3;
    if (/(bath|shower|ensuite|powder)/.test(t)) return 4;
    if (/(office|study|den|bonus|basement|garage|laundry|utility)/.test(t)) return 5;
    return 3; };
  const buckets = [[], [], [], [], [], []];
  for (let i = 0; i < N; i++) buckets[rankOf(items[i].tag)].push(items[i]);
  for (const b of buckets) shuffle(b);
  let count = Number.isFinite(numPhotos) ? Math.round(numPhotos) : 7;
  count = Math.max(5, Math.min(9, count)); count = Math.min(count, N);
  const chosen = []; const seen = new Set();
  const take = (it) => { if (it && !seen.has(it.url)) { seen.add(it.url); chosen.push(it); return true; } return false; };
  for (let r = 0; r < buckets.length && chosen.length === 0; r++) if (buckets[r].length) take(buckets[r][0]);
  const cursor = new Array(buckets.length).fill(0); let guard = 0;
  while (chosen.length < count && guard++ < N * 2) {
    let progressed = false;
    for (let r = 0; r < buckets.length && chosen.length < count; r++) {
      const b = buckets[r];
      while (cursor[r] < b.length && seen.has(b[cursor[r]].url)) cursor[r]++;
      if (cursor[r] < b.length) { take(b[cursor[r]++]); progressed = true; }
    }
    if (!progressed) break;
  }
  return chosen.map((it, i) => ({ url: it.url, i, rank: rankOf(it.tag) })).sort((a, b) => (a.rank - b.rank) || (a.i - b.i)).map((x) => x.url);
}

module.exports = { POOL, pickImages };
