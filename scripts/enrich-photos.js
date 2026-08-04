// Give imported properties real photos.
//
// His spreadsheet rows arrive with an address and a link to a Drive/Dropbox folder,
// never individual image URLs — so they show library stand-ins instead of the house.
// Zillow's /propimages takes an address, which every one of his rows has.
//
// Run it deliberately rather than during the import, because credits are finite
// (250/month free, 20,000 on Pro) and 6,789 rows would burn a plan in one pass.
//
//   node scripts/enrich-photos.js --limit 50
//   node scripts/enrich-photos.js --limit 500 --spec imported
//
// Needs DATABASE_URL and REALTYAPI_KEY.
const { pool, q } = require('../src/db');
const { backfill } = require('../src/photo-enrich');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

(async () => {
  if (!process.env.REALTYAPI_KEY) {
    console.error('REALTYAPI_KEY is not set.');
    process.exit(1);
  }
  const limit = Number(arg('limit', '25'));
  const dryRun = process.argv.includes('--dry-run');

  // Only rows that have no gallery. Imported rows are the target, but a collected row
  // that somehow arrived without photos is worth fixing too, so the query asks about
  // the gallery rather than about where the row came from.
  const { rows } = await pool.query(`
    SELECT id, address, street_line, city, state, zip, photo_urls, property_name
      FROM listings
     WHERE (photo_urls IS NULL OR photo_urls = '' OR photo_urls = '[]')
       AND (address IS NOT NULL OR street_line IS NOT NULL)
     ORDER BY id
  `);
  console.log(`${rows.length} properties have no photos; looking up at most ${limit}.\n`);
  if (!rows.length) { await pool.end(); return; }

  const res = await backfill(rows, {
    limit,
    onProgress: ({ used, limit, address, found, streetViewOnly, creditsLeft }) => {
      const what = found ? `${String(found).padStart(3)} photos`
        : streetViewOnly ? '  street view only' : '  none found';
      console.log(`  [${String(used).padStart(3)}/${limit}] ${what}  credits ${creditsLeft ?? '?'}  ${address.slice(0, 56)}`);
    },
  });

  console.log(`\nlooked up ${res.used} · with photos ${res.withPhotos} · street-view only ${res.streetViewOnly} · not found ${res.notFound}`);

  if (dryRun) { console.log('\n--dry-run: nothing written.'); await pool.end(); return; }

  let written = 0;
  for (const u of res.updates) {
    await pool.query(
      `UPDATE listings
          SET photo_urls = $2,
              num_photos = $3,
              source_url = COALESCE(source_url, $4)
        WHERE id = $1`,
      [u.id, JSON.stringify(u.photos), u.photos.length, u.propertyUrl]);
    written++;
  }
  console.log(`wrote galleries to ${written} properties.`);
  await pool.end();
})();
