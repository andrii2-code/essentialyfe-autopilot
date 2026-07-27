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

async function deliverToDrive(listing, processedImages) {
  const folderName = listing.address || listing.title;
  const manifest = processedImages.map((im, i) => ({
    name: `${String(i + 1).padStart(2, '0')}_${(im.tag || 'photo').toLowerCase().replace(/\W+/g, '-')}.jpg`,
    tag: im.tag, bytes: im.bytes,
    steps: im.steps,
  }));

  const drive = driveClient();
  if (drive && MASTER_ID) {
    const folder = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [MASTER_ID] },
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    const folderId = folder.data.id;
    for (let i = 0; i < processedImages.length; i++) {
      const im = processedImages[i];
      await drive.files.create({
        requestBody: { name: manifest[i].name, parents: [folderId] },
        media: { mimeType: 'image/jpeg', body: require('stream').Readable.from(im.buf) },
        fields: 'id',
        supportsAllDrives: true,
      });
    }
    return { mode: 'live', folderId, folderUrl: folder.data.webViewLink, folderName, manifest };
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

module.exports = { deliverToDrive, driveMode };
