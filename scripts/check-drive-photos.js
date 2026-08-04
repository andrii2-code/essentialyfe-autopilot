// Can the app read the photo folders his spreadsheet links?
//
// Every row of his sheet points at a Drive folder — better coverage than looking the
// address up (29 of 29 vs 26 of 29) and his own photographs rather than the listing
// agent's. But those folders live in HIS Drive, and a folder pasted from a colleague's
// account may not be readable by the credentials the app holds. That is the one thing
// that cannot be checked from a laptop, so run this where the credentials are:
//
//   railway run --service essentialyfe-autopilot node scripts/check-drive-photos.js
//
// Needs the Drive OAuth vars. Reads only — nothing is written.
const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../src/import');
const { photosInFolder, folderIdFrom } = require('../src/drive-photos');

const FILE = path.join(__dirname, '..', 'data', 'Essentialyfe Database - testing.xlsx');
const SAMPLE = Number(process.env.SAMPLE || 10);

(async () => {
  if (!fs.existsSync(FILE)) { console.error('Test file missing:', FILE); process.exit(1); }
  const rows = parseWorkbook(fs.readFileSync(FILE), { filename: path.basename(FILE) }).rows;

  // WHICH account is the app signed in as? This is the whole question — his folders
  // are readable if it is his account and invisible if it is anything else, and every
  // "not accessible" below means the same thing until this line is known.
  try {
    const { driveClient } = require('../src/drive');
    const drive = typeof driveClient === 'function' ? driveClient() : null;
    if (!drive) {
      console.log('\nDrive is not connected — no credentials in this environment.');
    } else {
      const me = await drive.about.get({ fields: 'user(emailAddress,displayName),storageQuota(usage)' });
      const u = me.data.user || {};
      console.log(`\nSigned in to Drive as: ${u.emailAddress || '(unknown)'} ${u.displayName ? `(${u.displayName})` : ''}`);
    }
  } catch (e) {
    console.log(`\nCould not read the Drive account: ${e.message}`);
  }

  const linked = rows.filter(r => r.photos_url);
  console.log(`\n${linked.length} of ${rows.length} properties link a photo folder`);
  const ids = linked.map(r => folderIdFrom(r.photos_url)).filter(Boolean);
  console.log(`${ids.length} of those are Drive folder links we can parse an id from\n`);

  let readable = 0, empty = 0, denied = 0, totalPhotos = 0;
  for (const r of linked.slice(0, SAMPLE)) {
    const res = await photosInFolder(r.photos_url);
    totalPhotos += res.photos.length;
    if (res.photos.length) readable++;
    else if (/no images/.test(res.error || '')) empty++;
    else denied++;
    const what = res.photos.length ? `${String(res.photos.length).padStart(3)} photos` : `  — ${res.error}`;
    console.log(`  ${what}  ${(r.property_name || r.streetLine || '').slice(0, 40)}`);
  }

  const n = Math.min(SAMPLE, linked.length);
  console.log(`\nreadable ${readable}/${n} · empty ${empty} · not accessible ${denied}`);
  console.log(`${totalPhotos} photos in total\n`);

  if (readable === 0) {
    console.log('None were readable. The folders belong to his Drive, so either the app is');
    console.log('signed in as a different account or the folders are not shared with it.');
    console.log('The address lookup stays as the fallback, so imports still get photos.');
  } else if (denied) {
    console.log(`${denied} could not be opened — those fall back to the address lookup.`);
  }
})();
