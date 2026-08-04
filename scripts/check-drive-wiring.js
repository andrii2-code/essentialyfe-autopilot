// The wiring between drive.js and drive-photos.js.
//
// Catches the class of bug that reached him as "driveClient is not a function" during
// an import: drive.js defines driveClient but was not exporting it, so the require in
// drive-photos.js resolved to undefined and every folder lookup threw. Nothing here
// touches the network or needs credentials, so it runs anywhere.
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};

(async () => {
  const drive = require('../src/drive');
  const drivePhotos = require('../src/drive-photos');

  console.log('\ndrive.js exports what the rest of the app requires from it');
  for (const fn of ['driveClient', 'deliverToDrive', 'driveMode', 'fetchDriveFile']) {
    ok(`${fn} is exported as a function`, typeof drive[fn] === 'function',
      typeof drive[fn]);
  }

  console.log('\nFolder ids are read out of the shapes his sheet actually uses');
  const cases = [
    ['https://drive.google.com/drive/folders/1iJ4ElxfisQu8NTY7EnJTB0ycdkFoSMYk?usp=drive_link', '1iJ4ElxfisQu8NTY7EnJTB0ycdkFoSMYk'],
    ['https://drive.google.com/drive/folders/1-6xEV206KNud8kudL3hv4V6jnUGRuvOs?usp=sharing', '1-6xEV206KNud8kudL3hv4V6jnUGRuvOs'],
    ['https://drive.google.com/open?id=1abcDEFghij1234567', '1abcDEFghij1234567'],
    ['https://tinyurl.com/abc123', null],
    ['', null],
    [null, null],
  ];
  for (const [url, want] of cases) {
    const got = drivePhotos.folderIdFrom(url);
    ok(`${String(url).slice(0, 46) || '(empty)'}`, got === want, `→ ${got}`);
  }

  console.log('\nA shortened link is followed to the real folder');
  // One of his 29 rows links tinyurl.com/The-Hillside-Five rather than Drive directly.
  // Without following the redirect that property is written off as "not a Drive link"
  // when it is one.
  const short = await drivePhotos.photosInFolder('https://tinyurl.com/The-Hillside-Five');
  ok('tinyurl is recognised as a Drive folder, not rejected outright',
    short.error !== 'not a Drive folder link', short.error || '');

  console.log('\nAn unusable folder reports a reason instead of throwing');
  // No credentials here, so this exercises the "Drive is not connected" path — which
  // is exactly what must happen rather than an exception escaping into the import.
  const r = await drivePhotos.photosInFolder('https://drive.google.com/drive/folders/1iJ4ElxfisQu8NTY7EnJTB0ycdkFoSMYk');
  ok('it returns a result object', r && Array.isArray(r.photos), JSON.stringify(r?.error || '').slice(0, 60));
  ok('with no photos and an explanation', r.photos.length === 0 && !!r.error, r.error || '');

  const bad = await drivePhotos.photosInFolder('https://tinyurl.com/xyz');
  ok('a non-Drive link is named as such', bad.error === 'not a Drive folder link', bad.error);

  console.log('\nA batch survives folders it cannot open');
  const batch = await drivePhotos.backfill([
    { id: 1, photos_url: 'https://drive.google.com/drive/folders/1iJ4ElxfisQu8NTY7EnJTB0ycdkFoSMYk', address: 'a' },
    { id: 2, photos_url: null, address: 'b' },
    { id: 3, photos_url: 'https://tinyurl.com/xyz', address: 'c' },
  ], { limit: 10 });
  ok('it completes without throwing', !!batch && Array.isArray(batch.updates));
  ok('a row with no folder is skipped, not counted as checked', batch.noFolder === 1, `noFolder=${batch.noFolder}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
