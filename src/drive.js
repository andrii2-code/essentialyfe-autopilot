// Google Drive delivery — his points 7 & 13 (address-named folder per property).
//
// Auth priority:
//  1) OAUTH (GOOGLE_OAUTH_CLIENT_ID + _SECRET + _REFRESH_TOKEN) — acts AS the user,
//     writes into the user's own My-Drive folder using the user's storage quota.
//     This is the working path for a personal Google account.
//  2) SERVICE ACCOUNT (GOOGLE_SERVICE_ACCOUNT_JSON) — only works with a Shared Drive
//     (a service account has no personal storage quota).
//  3) PREVIEW — no creds: shows the exact folder + filenames that WOULD be written.
//
// DRIVE_MASTER_FOLDER_ID = the folder everything is filed under (address subfolders).

const { google } = (() => { try { return require('googleapis'); } catch { return {}; } })();

const MASTER_ID = process.env.DRIVE_MASTER_FOLDER_ID || null;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null;
const OA_CLIENT = process.env.GOOGLE_OAUTH_CLIENT_ID || null;
const OA_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || null;
const OA_REFRESH = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || null;

function driveClient() {
  if (!google) return null;
  // 1) OAuth (preferred for personal accounts)
  if (OA_CLIENT && OA_SECRET && OA_REFRESH) {
    try {
      const o = new google.auth.OAuth2(OA_CLIENT, OA_SECRET, 'https://developers.google.com/oauthplayground');
      o.setCredentials({ refresh_token: OA_REFRESH });
      return google.drive({ version: 'v3', auth: o });
    } catch { /* fall through */ }
  }
  // 2) Service account (needs a Shared Drive)
  if (SA_JSON) {
    try {
      const creds = JSON.parse(SA_JSON);
      const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
      return google.drive({ version: 'v3', auth });
    } catch { /* fall through */ }
  }
  return null;
}

// Wrap any Drive API promise so a hung/failing call can never stall the pipeline.
// Google's client has no built-in timeout here; without this a bad/expired token
// makes files.create hang forever and the listing is stuck in "processing".
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Drive timeout after ${ms}ms (${label})`)), ms)
    ),
  ]);
}

const DRIVE_OP_TIMEOUT = +(process.env.DRIVE_OP_TIMEOUT_MS || 20000);

// Build the folder name the way the client names his properties:
//   "The {StreetName} | {beds}bd | {baths}ba | {sqft}sqft"
// e.g. "10644 Bellagio Rd" + 8bd/11ba/20000 -> "The Bellagio | 8bd | 11ba | 20,000sqft".
// The street NAME is the core word(s): drop the leading house number and only the
// TRAILING road-type suffix (Rd/Dr/Way/Ln/Blvd/Ave/…). We intentionally do NOT strip
// "Canyon" — it is part of real LA street names (Stone Canyon, Laurel Canyon), so we
// only remove a road type when it is the LAST token. Beds/baths/sqft appended when known.
const ROAD_TYPE = /^(rd|road|dr|drive|way|ln|lane|blvd|boulevard|ave|avenue|st|street|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway|trl|trail|cyn)$/i;
const DIRECTION = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west)$/i;

function streetName(listing) {
  let s = listing.street_line || listing.streetLine || listing.address || '';
  s = s.split(',')[0];                       // "10644 Bellagio Rd" (drop city/state/zip)
  s = s.replace(/^\s*\d+\s*/, '');           // drop the leading house number
  s = s.replace(/\b(apt|unit|#)\s*\S+/gi, ''); // drop unit markers
  let tokens = s.trim().split(/\s+/).filter(Boolean);
  if (tokens.length && ROAD_TYPE.test(tokens[tokens.length - 1])) tokens.pop(); // trailing road type only
  if (tokens.length > 1 && DIRECTION.test(tokens[0])) tokens.shift();           // leading N/S/E/W
  return tokens.join(' ') || null;
}

function propertyFolderName(listing) {
  // If he has named the property himself, that is the folder name — his name for it
  // should be what he sees in Drive.
  if (listing.property_name && String(listing.property_name).trim()) {
    return String(listing.property_name).trim();
  }
  const name = streetName(listing);
  if (!name) return listing.address || listing.title || 'Property';
  const parts = [`The ${name}`];
  if (listing.beds != null) parts.push(`${listing.beds}bd`);
  const ba = listing.baths ?? listing.full_baths;
  if (ba != null) parts.push(`${ba}ba`);
  if (listing.sqft != null) parts.push(`${Number(listing.sqft).toLocaleString('en-US')}sqft`);
  return parts.join(' | ');
}

async function deliverToDrive(listing, processedImages) {
  const folderName = propertyFolderName(listing);
  const manifest = processedImages.map((im, i) => ({
    name: `${String(i + 1).padStart(2, '0')}_${(im.tag || 'photo').toLowerCase().replace(/\W+/g, '-')}.jpg`,
    tag: im.tag, bytes: im.bytes,
    steps: im.steps,
  }));

  const drive = driveClient();
  if (drive && MASTER_ID) {
    try {
      // Reuse the property's existing folder if there is one. Drive happily creates
      // duplicate folders with the same name, so always creating meant a second run on
      // the same property left two folders of identical photos in his Drive.
      let folderId = null, folderUrl = null;
      try {
        const found = await withTimeout(drive.files.list({
          q: `name = '${folderName.replace(/'/g, "\\'")}'`
             + ` and '${MASTER_ID}' in parents`
             + ` and mimeType = 'application/vnd.google-apps.folder'`
             + ` and trashed = false`,
          fields: 'files(id, webViewLink)',
          pageSize: 1,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        }), DRIVE_OP_TIMEOUT, 'find folder');
        if (found.data.files && found.data.files.length) {
          folderId = found.data.files[0].id;
          folderUrl = found.data.files[0].webViewLink;
          console.log(`[drive] reusing existing folder for ${folderName}`);
        }
      } catch (e) {
        console.error('[drive] folder lookup failed, will create:', e.message);
      }

      if (!folderId) {
        const folder = await withTimeout(drive.files.create({
          requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [MASTER_ID] },
          fields: 'id, webViewLink',
          supportsAllDrives: true,
        }), DRIVE_OP_TIMEOUT, 'create folder');
        folderId = folder.data.id;
        folderUrl = folder.data.webViewLink;
      }

      // Names already in the folder, so a re-run replaces rather than duplicates.
      const existingByName = new Map();
      try {
        const listed = await withTimeout(drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'files(id, name)', pageSize: 200,
          supportsAllDrives: true, includeItemsFromAllDrives: true,
        }), DRIVE_OP_TIMEOUT, 'list folder');
        for (const f of listed.data.files || []) existingByName.set(f.name, f.id);
      } catch (e) {
        console.error('[drive] listing existing files failed:', e.message);
      }

      let uploaded = 0;
      for (let i = 0; i < processedImages.length; i++) {
        const im = processedImages[i];
        try {
          const dupeId = existingByName.get(manifest[i].name);
          let fileId;
          if (dupeId) {
            // same filename already there — update its content instead of adding a copy
            const up = await withTimeout(drive.files.update({
              fileId: dupeId,
              media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(im.buf) },
              fields: 'id',
              supportsAllDrives: true,
            }), DRIVE_OP_TIMEOUT, `update ${manifest[i].name}`);
            fileId = up.data.id;
          } else {
            const cr = await withTimeout(drive.files.create({
              requestBody: { name: manifest[i].name, parents: [folderId] },
              media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(im.buf) },
              fields: 'id',
              supportsAllDrives: true,
            }), DRIVE_OP_TIMEOUT, `upload ${manifest[i].name}`);
            fileId = cr.data.id;
          }
          // Keep the id: it is how the app serves the CLEANED image back to him. Without
          // it the app could only show the original source photo, watermark and all.
          manifest[i].driveFileId = fileId;
          uploaded++;
        } catch (e) {
          // one bad photo shouldn't sink the whole delivery
          console.error('[drive] upload failed:', manifest[i].name, e.message);
        }
      }
      return { mode: 'live', folderId, folderUrl, folderName, manifest, uploaded };
    } catch (e) {
      // Auth/expired-token/quota/network — log it and fall through to a non-blocking
      // preview result so the listing still completes (status -> ready) instead of
      // hanging forever in "processing".
      console.error('[drive] delivery failed, continuing without Drive:', e.message);
      return {
        mode: 'error',
        folderId: null,
        folderUrl: null,
        folderName,
        manifest,
        error: e.message,
        note: 'Images processed successfully, but Drive delivery failed (check GOOGLE_OAUTH_REFRESH_TOKEN / DRIVE_MASTER_FOLDER_ID). The listing is complete; re-deliver once Drive is reconnected.',
      };
    }
  }

  return {
    mode: 'preview',
    folderId: null,
    folderUrl: null,
    folderName,
    manifest,
    note: 'No Drive credentials on this host — folder + files shown are exactly what deploys to your Drive once OAuth (or a Shared Drive service account) is connected.',
  };
}

function driveMode() {
  return (driveClient() && MASTER_ID) ? 'live' : 'preview';
}

// Fetch a processed image back out of Drive, so the app can show the CLEANED photo
// rather than the original source URL (which still carries the MLS watermark).
// Returns a Buffer, or null if Drive isn't connected or the file has gone.
async function fetchDriveFile(fileId) {
  const drive = driveClient();
  if (!drive || !fileId) return null;
  try {
    const res = await withTimeout(
      drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' }),
      DRIVE_OP_TIMEOUT, 'download file');
    return Buffer.from(res.data);
  } catch (e) {
    console.error('[drive] download failed:', fileId, e.message);
    return null;
  }
}

module.exports = { deliverToDrive, driveMode, fetchDriveFile };
