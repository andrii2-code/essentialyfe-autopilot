// Photos from HIS OWN Drive folders.
//
// Every row of his spreadsheet links a photo folder — 28 of 29 on Drive, one on
// tinyurl — which is better coverage than looking listings up by address (26 of 29),
// and they are his own photographs rather than the agent's listing shots. So where a
// folder is readable it is the better source; the address lookup stays as the fallback
// for rows whose folder is empty, unshared, or not a Drive link at all.
//
// The app already holds Drive credentials (it writes cleaned images into his account),
// so no new access is needed — but a folder he pasted from someone else's account may
// not be readable, which is why every failure here is reported rather than thrown.

const { driveClient } = require('./drive');

// A Drive folder URL carries the id in one of a few shapes:
//   /drive/folders/<id>?usp=sharing      the usual one in his sheet
//   /folderview?id=<id>                  older links
//   /open?id=<id>                        shared-link form
function folderIdFrom(url) {
  if (!url) return null;
  const s = String(url);
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/)
    || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

// Some rows link a shortener rather than Drive directly. Following the redirect turns
// tinyurl.com/The-Hillside-Five into the real folder id, so those properties are not
// written off as "not a Drive link" when they are one.
const SHORTENER = /^https?:\/\/(tinyurl\.com|bit\.ly|goo\.gl|t\.co|rebrand\.ly|is\.gd)\//i;

async function resolveFolderId(url) {
  const direct = folderIdFrom(url);
  if (direct) return direct;
  if (!url || !SHORTENER.test(String(url))) return null;
  try {
    // HEAD is enough: we want the final URL, not the page. An unauthenticated request
    // usually ends at Google's sign-in page rather than the folder — but the folder URL
    // is carried in its `continue` parameter, so decoding the final URL finds the id
    // either way.
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return folderIdFrom(res.url) || folderIdFrom(decodeURIComponent(res.url)) || null;
  } catch { return null; }
}

const IMAGE_MIME = /^image\/(jpe?g|png|webp|heic|heif)$/i;

// List the images in one folder. Returns { photos, error } — never throws, because a
// backfill over thousands of properties must not stop at the first unshared folder.
async function photosInFolder(url, { max = 80 } = {}) {
  const id = await resolveFolderId(url);
  if (!id) return { photos: [], error: 'not a Drive folder link' };

  // Defensive: if drive.js ever stops exporting this, every folder should report
  // "Drive is not connected" and fall through to the address lookup — not throw
  // "driveClient is not a function" at him from the middle of an import.
  if (typeof driveClient !== 'function') return { photos: [], error: 'Drive is not connected' };
  const drive = driveClient();
  if (!drive) return { photos: [], error: 'Drive is not connected' };

  try {
    const res = await drive.files.list({
      q: `'${id}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: 'files(id,name,mimeType,imageMediaMetadata(width,height))',
      pageSize: Math.min(max, 100),
      orderBy: 'name_natural',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = (res.data.files || []).filter(f => IMAGE_MIME.test(f.mimeType || ''));
    if (!files.length) return { photos: [], error: 'folder has no images' };

    // Serve through our own endpoint rather than a Drive URL: Drive's direct links
    // require the viewer to be signed in and shared on the folder, so an <img> tag
    // pointed at one shows a broken image for anyone else. The app already proxies
    // Drive files this way for cleaned photos.
    return {
      photos: files.slice(0, max).map(f => ({
        url: `/api/drive-image/${f.id}`,
        tag: null,
        driveFileId: f.id,
        name: f.name,
      })),
      error: null,
    };
  } catch (e) {
    const msg = e?.errors?.[0]?.reason || e?.message || 'unreadable';
    // "We cannot open your folder" and "this property has no photograph" are different
    // facts and he needs to tell them apart: the first he can fix by sharing the
    // folder, the second he cannot fix at all.
    const denied = /notFound|forbidden|permission/i.test(msg);
    return {
      photos: [], denied,
      error: denied ? 'folder not shared with this account' : msg,
    };
  }
}

// Backfill from Drive across a batch of rows. Same shape as photo-enrich.backfill so
// the two can be used interchangeably by the caller.
async function backfill(rows, { limit = 50, onProgress = () => {} } = {}) {
  const updates = [];
  const denied = [];          // folders that exist but this account cannot open
  let used = 0, withPhotos = 0, noFolder = 0, unreadable = 0;

  for (const row of rows) {
    if (used >= limit) break;
    const folder = row.photos_url;
    if (!folder) { noFolder++; continue; }

    const r = await photosInFolder(folder);
    used++;
    if (r.photos.length) { withPhotos++; updates.push({ id: row.id, photos: r.photos }); }
    else { unreadable++; if (r.denied) denied.push(row.id); }
    onProgress({
      used, limit, found: r.photos.length, error: r.error, denied: !!r.denied,
      address: row.address || row.street_line || '',
    });
  }
  return { updates, denied, used, withPhotos, noFolder, unreadable };
}

module.exports = { photosInFolder, folderIdFrom, backfill };
