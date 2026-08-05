// EssentiaLyfe · Sourcing Autopilot — frontend
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => n == null ? '—' : '$' + Number(n).toLocaleString();
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Shown when a property genuinely has no photograph — a neutral grey card that reads
// as "no photo", not a picture of somebody else's house. The stock library that used
// to sit here is gone: he opened a small white bungalow and saw a glass villa.
const PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,'
  + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
<rect width="800" height="600" fill="#e8eaed"/>
<g fill="#b3b8c0" transform="translate(400 288)">
<path d="M-46-16 0-52l46 36v50a6 6 0 0 1-6 6H-40a6 6 0 0 1-6-6z"/>
<rect x="-14" y="10" width="28" height="30" fill="#e8eaed"/>
</g>
<text x="400" y="372" font-family="Inter,system-ui,sans-serif" font-size="19"
 fill="#98a0ab" text-anchor="middle">No photo available</text></svg>`);

// Parse a listing's real photo gallery: photo_urls is [{url,tag}] or [url] (or a
// JSON string of either). Returns an array of URL strings.
// The source gallery as stored at collection time: [{url, tag}]. Each entry may be a
// bare URL string (older rows) or an object carrying realtor.com's own room label.
function sourcePhotos(l) {
  if (!l) return [];
  // The API sends both spellings: photo_urls straight off the row (a JSON string) and
  // photoUrls already parsed. Take whichever is populated rather than assuming one.
  let g = l.photo_urls ?? l.photoUrls;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  if (!Array.isArray(g)) return [];
  return g.map(e => (e && typeof e === 'object') ? { url: e.url, tag: e.tag || null } : { url: e, tag: null })
          .filter(e => e.url);
}

function realPhotos(l) {
  return sourcePhotos(l).map(e => e.url);
}

// First real photo's room tag (realtor.com per-photo label), or null.
function firstTag(l) {
  let g = l && l.photo_urls;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  if (Array.isArray(g) && g[0] && typeof g[0] === 'object') return g[0].tag || null;
  return null;
}

// The i-th image for a listing: its REAL photo when available, else a fallback
// keyed by id so it stays stable per card. Accepts a listing object or a bare id.
function imgFor(listing, i = 0) {
  if (listing && typeof listing === 'object') {
    // Prefer the CLEANED photo — watermark removed, address blurred, tagged. The raw
    // listing URL still carries the MLS logo, so showing it here meant everything he
    // looked at or downloaded in the app was the un-processed original.
    const done = (listing.images || []).filter(im => im && im.driveFileId);
    if (done.length) {
      const idx = i % done.length;
      return `/api/listing/${listing.id}/image/${(listing.images || []).indexOf(done[idx])}`;
    }
    const photos = realPhotos(listing);
    if (photos.length) return photos[i % photos.length];
    // No real photo for this property. Show a plain placeholder rather than a stock
    // house: he caught a glass villa standing in for a small white bungalow, and a
    // picture of the wrong home is worse than no picture at all.
    return PLACEHOLDER;
  }
  return PLACEHOLDER;
}

let state = { summary: null, queue: [], swipeIdx: 0, user: null };

async function api(path, opts) {
  const r = await fetch('/api' + path, opts ? { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined);
  if (r.status === 401) { showAuth(); throw new Error('not authenticated'); }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Write requests where the server's {error} message is meant for the user (permission
// rules, duplicate email, last-admin guard) — surface that text rather than raw JSON.
async function apiSend(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { showAuth(); throw new Error('not authenticated'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

// ---------- theme ----------
// The initial theme is applied by an inline script in index.html (before first paint).
// This only handles switching and remembering the choice.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('esl-theme', theme); } catch {}
  const icon = $('#theme-icon'), label = $('#theme-label');
  // Label the destination, not the current state — "Dark mode" means "switch to dark".
  if (icon) icon.textContent = theme === 'dark' ? '☀' : '☾';
  if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}
$('#theme-toggle')?.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

// ---------- navigation ----------
// Returns the render promise so callers (and tests) can await a fully painted view;
// each renderer fetches, so switching views is not instantaneous.
function show(view) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'review') return renderSwipe();
  if (view === 'processing') return renderProcessing();
  if (view === 'database') return renderDatabase();
  if (view === 'prices') return renderPrices();
  if (view === 'team') return renderTeam();
  if (view === 'settings') return renderSettings();
}

// Settings holds the automation controls (which used to be tucked under the dashboard
// sidebar) and the spreadsheet import. Both are admin-only.
async function renderSettings() {
  const isAdmin = state.user?.role === 'admin';
  $('#view-settings').querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', !isAdmin));
  if (!isAdmin) {
    $('#view-settings').innerHTML = `<div class="panel"><p class="lede">Settings are available to admins.</p></div>`;
    return;
  }
  return renderAutomation().catch(e => console.error('automation:', e.message));
}
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-view]');
  if (nav) { show(nav.dataset.view); }
});

// ---------- summary / stats ----------
async function refreshSummary() {
  const s = await api('/summary');
  state.summary = s;
  const c = s.counts;
  $('#s-sourced').textContent = c.sourced;                 // every home held
  $('#s-review').textContent = c.in_review;                // waiting on his yes/no
  $('#s-processing').textContent = c.processing;
  $('#s-ready').textContent = c.ready + c.live;            // delivered to Drive
  $('#s-live').textContent = c.live;                       // published to the site
  $('#badge-review').textContent = c.in_review;
  $('#badge-processing').textContent = c.processing;
  $('#badge-db').textContent = c.sourced; // the database page lists every property
  $('#drive-mode').textContent = 'Drive: ' + s.driveMode;
}

// ---------- dashboard ----------
async function renderDashboard() {
  // Start the secondary panels FIRST and don't await them here: the queue preview loads
  // 32 property images, and browsers cap concurrent connections per host, so anything
  // queued behind those images waits seconds before it even leaves.
  // refreshDigest also carries the price-drop count, so this is one request, not two.
  // Automation moved to Settings, so the dashboard only loads the digest summary here.
  const sidePanels = refreshDigest()
    .catch(e => console.error('digest summary:', e.message));

  await refreshSummary();
  const queue = await api('/queue');
  state.queue = queue;
  // queue preview (top 5)
  const wrap = $('#queue-preview');
  if (!queue.length) {
    wrap.innerHTML = `<div class="muted" style="padding:20px;text-align:center">Queue is empty. Run the collector to pull today's LA listings.</div>`;
  } else {
    wrap.innerHTML = queue.slice(0, 5).map(l => `
      <div class="qp-card" data-id="${l.id}">
        <img class="qp-thumb" src="${imgFor(l)}" loading="lazy" alt="">
        <div class="qp-body">
          <div class="qp-addr">${esc(l.address)}</div>
          <div class="qp-meta">${l.beds}bd · ${l.baths}ba · ${l.sqft ? l.sqft.toLocaleString() + ' sqft' : '—'} · <span style="text-transform:capitalize">${l.spec.replace('-', ' ')}</span></div>
        </div>
        <div style="text-align:right"><div class="qp-price">${fmt(l.price)}</div></div>
      </div>`).join('');
  }
  // sources
  const bySpec = {};
  for (const l of [...queue]) bySpec[l.area] = (bySpec[l.area] || 0) + 1;
  const total = queue.length;
  // He asked what the data is actually pulled from. The honest answer is now three
  // listing platforms searched together and de-duplicated, every record arriving from
  // an MLS. Rather than claiming which brokerages he gets, read them off his own
  // queue — so this row is evidence rather than a promise.
  const brokerages = [...new Set([...queue].map(l => l.brokerage).filter(Boolean))];
  const photoRows = [...queue].filter(l => (l.num_photos || 0) > 0 || (l.images || []).length).length;
  const shown = brokerages.slice(0, 4).join(' · ');
  const more = brokerages.length > 4 ? ` +${brokerages.length - 4} more` : '';

  $('#src-list').innerHTML = `
    <div class="src-row"><div><div class="src-name">MLS — LA County</div><div class="src-sub">Realtor · Redfin · Zillow searched together, duplicates merged</div></div><div class="src-count">+${total} new</div></div>
    <div class="src-row"><div><div class="src-name">Brokerages in your queue</div><div class="src-sub">${brokerages.length ? esc(shown) + esc(more) : 'Named on each property as it arrives'}</div></div><div class="src-count">${brokerages.length || '—'}</div></div>
    <div class="src-row"><div><div class="src-name">Photo galleries</div><div class="src-sub">Full listing galleries — cleaned and tagged when you like a property</div></div><div class="src-count">${photoRows}/${total || 0}</div></div>
    <div class="src-row"><div><div class="src-name">All 3 specs</div><div class="src-sub">For-sale · Sold · Rentals</div></div><div class="src-count">on</div></div>
    <div class="src-row"><div><div class="src-name">Owner / address finder</div><div class="src-sub">Skip-trace API</div></div><div class="src-count off">Phase 2</div></div>`;

  await sidePanels; // already in flight; just don't finish before they land
}

$('#btn-collect')?.addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = '⟳ Collecting real LA listings…';
  try { await api('/collect', { method: 'POST', body: { limitPerSpec: 12 } }); await renderDashboard(); }
  catch (err) { alert('Collector error: ' + err.message); }
  e.target.disabled = false; e.target.textContent = '⟳ Run collector now';
});
$('#btn-start-review')?.addEventListener('click', () => show('review'));

// ---------- review / swipe ----------
async function renderSwipe() {
  const queue = await api('/queue');
  state.queue = queue; state.swipeIdx = 0;
  drawSwipe();
}
function drawSwipe() {
  const wrap = $('#review-wrap');
  const q = state.queue;
  if (!q.length) {
    wrap.innerHTML = `<div class="review-empty"><span class="serif">All caught up.</span>No listings waiting for your yes or no. Run the collector for more.</div>`;
    return;
  }
  const l = q[0];
  const tags = (l.property_style || []).concat((l.amenities || []).slice(0, 4));
  const strip = [1, 2, 3, 4].map(i => `<img src="${imgFor(l, i)}" alt="">`).join('');
  const heroTag = firstTag(l) || 'Photo';
  wrap.innerHTML = `
    <div class="swipe-card">
      <div class="swipe-top">
        <div class="swipe-count">Property <b>${1}</b> of ${q.length} — the only one that needs you</div>
        <div class="swipe-src">Sourced from ${esc(l.source)} · ${esc(l.spec.replace('-', ' '))}</div>
      </div>
      <div class="swipe-body">
        <div class="swipe-photo">
          <img src="${imgFor(l)}" alt="">
          <div class="swipe-strip">${strip}</div>
          <div class="photo-tag">${esc(heroTag)}</div>
        </div>
        <div class="swipe-info">
          <div class="si-area">${esc(l.area || l.city || 'Los Angeles')}, CA</div>
          <div class="si-addr">${esc(l.street_line || l.address)}</div>
          <div class="si-price">${fmt(l.price)}${l.is_rental ? '<span style="font-size:13px;color:#7a8698">/mo</span>' : ''}</div>
          <div class="si-specs">
            <div class="si-spec"><b>${l.beds ?? '—'}</b><span>Beds</span></div>
            <div class="si-spec"><b>${l.baths ?? '—'}</b><span>Baths</span></div>
            <div class="si-spec"><b>${l.sqft ? l.sqft.toLocaleString() : '—'}</b><span>Sq Ft</span></div>
            <div class="si-spec"><b>${l.lot_acres ?? '—'}</b><span>Acres</span></div>
          </div>
          <div class="si-desc">${esc(l.description || 'No description provided by source.')}</div>
          <div class="si-tags">${tags.slice(0, 6).map(t => `<span class="t">${esc(t)}</span>`).join('')}</div>
          <div class="swipe-actions">
            <button class="act pass" id="act-pass">✕ Pass</button>
            <button class="act like" id="act-like">♡ Like</button>
          </div>
        </div>
      </div>
    </div>`;
  $('#act-pass').onclick = () => swipe(l.id, 'pass');
  $('#act-like').onclick = () => swipe(l.id, 'approve');
}
async function swipe(id, action) {
  const card = $('.swipe-card');
  if (card) { card.style.transition = 'transform .25s, opacity .25s'; card.style.transform = action === 'approve' ? 'translateX(60px)' : 'translateX(-60px)'; card.style.opacity = '0'; }
  await api(`/listing/${id}/${action}`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 220));
  state.queue = state.queue.filter(x => x.id !== id);
  await refreshSummary();
  drawSwipe();
}

// ---------- processing ----------
async function renderProcessing() {
  await refreshSummary();
  const rows = (await api('/listings')).filter(l => ['approved', 'processing'].includes(l.status));
  const body = $('#proc-body');
  if (!rows.length) { body.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">Nothing processing. Approve a home in the review queue and it appears here, then moves to your database on its own.</td></tr>`; return; }
  body.innerHTML = rows.map(l => `
    <tr data-id="${l.id}">
      <td><img class="t-thumb" src="${imgFor(l)}" alt=""></td>
      <td><b>${esc(l.street_line || l.address)}</b><div class="muted" style="font-size:11px">${esc(l.city)}</div></td>
      <td class="t-price">${fmt(l.price)}</td>
      <td>${l.beds}bd / ${l.baths}ba</td>
      <td>${l.num_photos || '—'} photos</td>
      <td><span class="pill processing">Cleaning &amp; tagging…</span></td>
    </tr>`).join('');
}

// ---------- database ----------
// Page state. Kept in localStorage so his "show 100 per page" choice survives a reload
// rather than resetting every time he opens the page.
const dbPage = {
  index: 0,
  get perPage() {
    const v = localStorage.getItem('esl-db-per-page');
    return v === 'all' ? 'all' : (Number(v) || 50);
  },
  set perPage(v) { try { localStorage.setItem('esl-db-per-page', String(v)); } catch {} },
};
let dbRows = [];   // the full set; paging slices this rather than refetching

async function renderDatabase({ refetch = true } = {}) {
  const body = $('#db-body');
  if (!body.children.length) body.innerHTML = `<tr><td colspan="${visibleColumns().length + 2}" class="muted" style="padding:18px">Loading…</td></tr>`;
  await loadColumnCatalogue();   // the table is drawn from his chosen columns
  if (refetch) {
    await refreshSummary();
    // Every property he has, not just the approved ones. Showing only 'ready' meant the
    // database page listed 2 rows out of 60-odd, so the field editing he asked for looked
    // like it wasn't there — the fields live on the property, whatever its status.
    dbRows = await api('/listings');
  }
  populateAreaFilter(dbRows);
  await populateTierFilter();
  const all = applyFiltersAndSort(dbRows);
  if (!all.length) {
    // Distinguish "you have none" from "your filters matched none" — otherwise a
    // forgotten filter looks like lost data.
    body.innerHTML = dbRows.length
      ? `<tr><td colspan="${visibleColumns().length + 2}" class="muted" style="text-align:center;padding:30px">No properties match these filters. <a class="link" id="db-clear-inline">Clear them</a></td></tr>`
      : `<tr><td colspan="${visibleColumns().length + 2}" class="muted" style="text-align:center;padding:30px">No properties yet. Run the collector to pull today's listings.</td></tr>`;
    $('#db-clear-inline')?.addEventListener('click', clearDbFilters);
    updatePager(0, 0, 0);
    return;
  }

  const per = dbPage.perPage;
  const sel = $('#db-per-page');
  if (sel) sel.value = String(per);   // reflect the remembered choice
  const size = per === 'all' ? all.length : per;
  const pages = Math.max(1, Math.ceil(all.length / size));
  if (dbPage.index >= pages) dbPage.index = pages - 1;   // e.g. after switching to a bigger page size
  if (dbPage.index < 0) dbPage.index = 0;
  const start = dbPage.index * size;
  const rows = all.slice(start, start + size);
  updatePager(all.length, start, rows.length, pages);

  renderHead();
  const cols = visibleColumns();
  body.innerHTML = rows.map(l => `
    <tr data-id="${l.id}">
      <td><img class="t-thumb" src="${imgFor(l)}" loading="lazy" alt=""></td>
      ${cols.map(c => `<td${cellClass(c)}>${cellHtml(l, c)}</td>`).join('')}
      <td><button class="row-edit" data-edit="${l.id}">Edit fields</button></td>
    </tr>`).join('');
}

// ---------- columns ----------
// Nothing is hardcoded: the table renders whatever columns he has chosen, drawn from
// the full catalogue of feed data and his own fields.
// Source and brokerage are in the default set because they are the answer to the
// question he actually asked — "what is it pulling from?". Leaving them available but
// hidden meant the app knew Compass listed a property and never showed him.
const DEFAULT_COLUMNS = ['property_name', 'street_line', 'area', 'price', 'tier', 'beds', 'sqft',
  'source', 'brokerage', 'status'];
let COLUMN_CATALOGUE = [];

// Columns added to DEFAULT_COLUMNS after he had already picked his own set. His choice
// is stored in localStorage, so without this he would never see them — the app would
// know which brokerage listed a property and quietly keep it to itself. Added once
// each, and only if he has not since removed them by hand.
const NEW_DEFAULTS = ['source', 'brokerage'];

// Fields he has switched off. Held on the account rather than in this browser, so the
// same form appears for his whole team. Nothing is deleted: the column keeps its data
// and turning a field back on brings its values with it.
let HIDDEN_FIELDS = new Set();
const isHidden = (key) => HIDDEN_FIELDS.has(key);
// Reflected onto window so the browser checks can drive it directly.
Object.defineProperty(window, 'HIDDEN_FIELDS', {
  get: () => HIDDEN_FIELDS,
  set: (v) => { HIDDEN_FIELDS = v instanceof Set ? v : new Set(v || []); },
});

// One row of the property card, omitted entirely when its field is switched off.
function dtRow(key, label, value) {
  if (isHidden(key)) return '';
  return `<div class="dt-field"><span class="k">${esc(label)}</span><span class="v">${value}</span></div>`;
}

async function loadHiddenFields() {
  try {
    const d = await api('/hidden-fields');
    HIDDEN_FIELDS = new Set(d.hidden || []);
  } catch { HIDDEN_FIELDS = new Set(); }
  return HIDDEN_FIELDS;
}

function chosenColumns() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('esl-db-columns') || 'null'); } catch {}
  if (!Array.isArray(saved) || !saved.length) return DEFAULT_COLUMNS;

  let seenNew = [];
  try { seenNew = JSON.parse(localStorage.getItem('esl-db-columns-seen') || '[]'); } catch {}
  const toAdd = NEW_DEFAULTS.filter(k => !saved.includes(k) && !seenNew.includes(k));
  if (!toAdd.length) return saved;

  // Slot them in before status, which reads best at the end of the row.
  const at = saved.indexOf('status');
  const merged = at > -1
    ? [...saved.slice(0, at), ...toAdd, ...saved.slice(at)]
    : [...saved, ...toAdd];
  try {
    localStorage.setItem('esl-db-columns', JSON.stringify(merged));
    localStorage.setItem('esl-db-columns-seen', JSON.stringify([...seenNew, ...toAdd]));
  } catch {}
  return merged;
}
function setChosenColumns(keys) {
  try { localStorage.setItem('esl-db-columns', JSON.stringify(keys)); } catch {}
}
// Only columns we actually know about, in his chosen order.
function visibleColumns() {
  const known = new Map(COLUMN_CATALOGUE.map(c => [c.key, c]));
  return chosenColumns().map(k => known.get(k)).filter(Boolean);
}

function cellClass(c) {
  if (c.type === 'money' || c.key === 'price') return ' class="t-price"';
  return '';
}

// How one value is drawn. The special cases are the ones worth reading at a glance:
// the property name links to its Drive folder, status is a pill, tier is a chip.
function cellHtml(l, c) {
  const v = l[c.key];

  if (c.key === 'property_name') {
    const name = v || propertyFallbackName(l);
    return l.drive_folder_url
      ? `<a class="drive-link" href="${esc(l.drive_folder_url)}" target="_blank" title="Open this property's folder in Google Drive">📁 ${esc(name)}</a>`
      : `<span title="The Drive folder is created when you approve the property">${esc(name)}</span>`;
  }
  if (c.key === 'status') return `<span class="pill ${esc(l.status)}">${esc(statusLabel(l.status))}</span>`;
  // For sale / Sold / For rent, colour-coded, because telling a rental from a sale at
  // a glance was the whole complaint.
  if (c.key === 'spec') return v ? `<span class="pill spec-${esc(v)}">${esc(specLabel(v))}</span>` : '<span class="muted">—</span>';
  if (c.key === 'tier') return v ? `<div class="t-tags"><span class="t">${esc(v)}</span></div>` : '<span class="muted">—</span>';
  // "MLS · Realtor.com" reads better split: the fact that it came from an MLS, then
  // which platform found it. He asked for the brokerage to be as legible as the MLS.
  if (c.key === 'source') {
    if (!v) return '<span class="muted">—</span>';
    const m = String(v).match(/^MLS\s*·\s*(.+)$/);
    return m
      ? `<span class="src-tag mls">MLS</span> <span class="src-plat">${esc(m[1])}</span>`
      : `<span class="src-plat">${esc(v)}</span>`;
  }
  if (c.key === 'brokerage') {
    return v ? `<span class="src-tag broker">${esc(v)}</span>` : '<span class="muted">—</span>';
  }
  if (c.key === 'street_line') return `<b>${esc(v || l.address || '—')}</b>`;
  if (c.key === 'area') return esc(v || l.city || '—');

  if (v == null || v === '') return '<span class="muted">—</span>';
  // His sheet's links live behind cells that just read "Link". Render them as real
  // links so one click opens the Airbnb page, the photo folder or the website.
  if (c.type === 'url') {
    const href = String(v).trim();
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return esc(href);
    return `<a class="ext-link" href="${esc(href)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(href)}">${esc(linkLabel(href))}</a>`;
  }
  if (c.type === 'money') return fmt(v);
  if (c.type === 'datetime' || /_at$/.test(c.key)) {
    const d = new Date(v);
    return esc(d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }
  if (c.type === 'date') return esc(new Date(v).toLocaleDateString());
  if (Array.isArray(v)) return esc(v.slice(0, 3).join(', '));
  if (c.type === 'number' && typeof v === 'number') return esc(v.toLocaleString());
  return esc(String(v));
}

// A link inside the detail card, or an em-dash when there isn't one.
function detailLink(href) {
  if (!href || !/^https?:\/\//i.test(String(href))) return '—';
  return `<a class="ext-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(linkLabel(href))} ↗</a>`;
}

// Name a link by where it goes. His sheet says "Link" for all of them, which tells
// him nothing; "airbnb.com" tells him whether it is worth clicking.
function linkLabel(href) {
  if (/^mailto:/i.test(href)) return href.replace(/^mailto:/i, '');
  try {
    const h = new URL(href).hostname.replace(/^www\./, '');
    return { 'drive.google.com': 'Google Drive', 'dropbox.com': 'Dropbox',
             'www.dropbox.com': 'Dropbox' }[h] || h;
  } catch { return 'Link'; }
}

// If he hasn't named a property yet, show what Drive would call it.
function propertyFallbackName(l) {
  const street = (l.street_line || '').replace(/^\d+\s+/, '').trim();
  return street ? `The ${street}` : (l.address || 'Property');
}

function renderHead() {
  const head = $('#db-head');
  if (!head) return;
  const f = dbFilters.get();
  const [sortKey, sortDir] = (f.sort || 'price:desc').split(':');
  head.innerHTML = `<th></th>` + visibleColumns().map(c => {
    const on = c.key === sortKey;
    return `<th class="sortable${on ? ' sorted' : ''}" data-sort="${c.key}" data-dir="${on ? sortDir : ''}">${esc(c.label)}</th>`;
  }).join('') + `<th></th>`;
  // Headers are rebuilt on every render, so the click handler is bound here.
  head.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const cur = (dbFilters.get().sort || 'price:desc').split(':');
      onFilterChange({ sort: `${key}:${cur[0] === key && cur[1] === 'asc' ? 'desc' : 'asc'}` });
    });
  });
}

async function loadColumnCatalogue() {
  if (COLUMN_CATALOGUE.length) return COLUMN_CATALOGUE;
  try {
    const d = await api('/columns');
    COLUMN_CATALOGUE = d.columns || [];
    // Remember every label we have seen. A hidden field drops out of the catalogue,
    // so without this the "switched off" list could only show its raw key.
    for (const c of COLUMN_CATALOGUE) FIELD_LABELS[c.key] = c.label;
    if (Array.isArray(d.hidden)) HIDDEN_FIELDS = new Set(d.hidden);
  } catch { COLUMN_CATALOGUE = []; }
  return COLUMN_CATALOGUE;
}

// The picker itself: every available column, grouped, with a tick for the ones showing.
function renderColumnPicker() {
  const box = $('#col-picker-body');
  if (!box) return;
  const chosen = new Set(chosenColumns());
  const groups = [...new Set(COLUMN_CATALOGUE.map(c => c.group))];
  box.innerHTML = groups.map(g => `
    <div class="col-group">
      <div class="col-group-t">${esc(g)}</div>
      ${COLUMN_CATALOGUE.filter(c => c.group === g).map(c => `
        <label class="col-opt">
          <input type="checkbox" data-col="${c.key}"${chosen.has(c.key) ? ' checked' : ''}>
          <span>${esc(c.label)}</span>
          ${c.custom
            ? `<button class="col-del" data-del="${esc(c.key)}" data-label="${esc(c.label)}" title="Delete this field">×</button>`
            : NEVER_HIDE.has(c.key)
              ? (c.editable ? '<em class="col-tag">yours</em>' : '')
              : `<button class="col-hide" data-hide="${esc(c.key)}" data-label="${esc(c.label)}"
                   title="Switch this field off everywhere. Nothing is deleted, and turning it back on brings its values with it.">×</button>`}
        </label>`).join('')}
    </div>`).join('');

  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();   // the button sits inside a <label>
      deleteCustomField(btn.dataset.del, btn.dataset.label);
    });
  });

  box.querySelectorAll('[data-hide]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      hideField(btn.dataset.hide, btn.dataset.label);
    });
  });

  renderHiddenFields();

  box.querySelectorAll('input[data-col]').forEach(chk => {
    chk.addEventListener('change', () => {
      const key = chk.dataset.col;
      // Keep his ordering: appending a newly ticked column puts it on the right.
      const next = chk.checked
        ? [...chosenColumns().filter(k => k !== key), key]
        : chosenColumns().filter(k => k !== key);
      setChosenColumns(next);
      renderDatabase({ refetch: false });
    });
  });
}

// ---- fields he creates himself ----
// A custom field behaves like any other: a column he can show, and an editable field
// on every property. Only an admin can create one.
$('#cf-type')?.addEventListener('change', e => {
  $('#cf-options')?.classList.toggle('hidden', e.target.value !== 'select');
});

$('#cf-add')?.addEventListener('click', async () => {
  const msg = (t, cls = '') => { const el = $('#cf-msg'); el.className = 'digest-msg ' + cls; el.textContent = t; };
  const label = $('#cf-label').value.trim();
  const type = $('#cf-type').value;
  const options = $('#cf-options').value;
  const sensitive = $('#cf-sensitive').checked;
  if (!label) return msg('Give the field a name first.', 'err');
  $('#cf-add').disabled = true;
  msg('Adding…');
  try {
    const r = await apiSend('POST', '/custom-fields', { label, type, options, sensitive });
    $('#cf-label').value = ''; $('#cf-options').value = ''; $('#cf-sensitive').checked = false;
    // Show it straight away — he just made it, he expects to see it.
    COLUMN_CATALOGUE = [];
    await loadColumnCatalogue();
    setChosenColumns([...chosenColumns(), r.field.key]);
    FIELD_DEFS = null;                      // the edit form must pick it up too
    renderColumnPicker();
    await renderDatabase({ refetch: false });
    msg(`"${r.field.label}" added — it's now a column and a field on every property.`, 'ok');
  } catch (e) { msg(e.message, 'err'); }
  finally { $('#cf-add').disabled = false; }
});

async function deleteCustomField(key, label) {
  if (!confirm(`Delete the field "${label}"?\n\nThis also deletes what you've entered in it on every property.`)) return;
  try {
    await apiSend('DELETE', '/custom-fields/' + encodeURIComponent(key));
    COLUMN_CATALOGUE = [];
    await loadColumnCatalogue();
    setChosenColumns(chosenColumns().filter(k => k !== key));
    FIELD_DEFS = null;
    renderColumnPicker();
    await renderDatabase({ refetch: false });
  } catch (e) { alert(e.message); }
}

// The few fields that cannot be switched off. A property with no address, or one that
// will not say where it came from, is not something he can act on. Mirrors the server,
// which refuses them regardless of what the browser sends.
const NEVER_HIDE = new Set(['street_line', 'address', 'city', 'price', 'status', 'spec',
  'source', 'brokerage', 'mls_id', 'property_name']);

// Switch a built-in field off. Deliberately not a delete: the column keeps its data,
// so this is reversible and an import never loses a column he happens to have hidden.
async function hideField(key, label) {
  if (!confirm(`Hide "${label}" from the table and the property card?\n\nNothing is deleted. You can switch it back on from the list below.`)) return;
  try {
    const next = [...HIDDEN_FIELDS, key];
    const r = await apiSend('PUT', '/hidden-fields', { hidden: next });
    HIDDEN_FIELDS = new Set(r.hidden || []);
    setChosenColumns(chosenColumns().filter(k => k !== key));
    COLUMN_CATALOGUE = [];
    await loadColumnCatalogue();
    FIELD_DEFS = null;
    renderColumnPicker();
    await renderDatabase({ refetch: false });
  } catch (e) { alert(e.message); }
}

async function unhideField(key) {
  try {
    const r = await apiSend('PUT', '/hidden-fields', { hidden: [...HIDDEN_FIELDS].filter(k => k !== key) });
    HIDDEN_FIELDS = new Set(r.hidden || []);
    COLUMN_CATALOGUE = [];
    await loadColumnCatalogue();
    FIELD_DEFS = null;
    renderColumnPicker();
    await renderDatabase({ refetch: false });
  } catch (e) { alert(e.message); }
}

// Hidden fields are listed under the picker so switching one off is visibly undoable
// rather than something he has to remember he did.
function renderHiddenFields() {
  const box = $('#col-hidden');
  if (!box) return;
  if (!HIDDEN_FIELDS.size) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const label = (k) => (FIELD_LABELS[k] || k.replace(/_/g, ' '));
  box.classList.remove('hidden');
  box.innerHTML = `<div class="col-group-t">Switched off</div>`
    + [...HIDDEN_FIELDS].map(k =>
        `<button class="col-unhide" data-unhide="${esc(k)}">${esc(label(k))} <span>+ turn back on</span></button>`).join('');
  box.querySelectorAll('[data-unhide]').forEach(b =>
    b.addEventListener('click', () => unhideField(b.dataset.unhide)));
}

// Labels for fields that are hidden, and so no longer in the catalogue to look up.
let FIELD_LABELS = {};

$('#db-columns')?.addEventListener('click', async () => {
  await loadColumnCatalogue();
  renderColumnPicker();
  $('#col-new')?.classList.toggle('hidden', state.user?.role !== 'admin');
  $('#col-picker')?.classList.toggle('hidden');
});
$('#col-done')?.addEventListener('click', () => $('#col-picker')?.classList.add('hidden'));
$('#col-reset')?.addEventListener('click', () => {
  setChosenColumns(DEFAULT_COLUMNS);
  renderColumnPicker();
  renderDatabase({ refetch: false });
});

// ---------- filtering + sorting ----------
// Filters are remembered per browser, so coming back to the page keeps the view he set
// up rather than resetting to everything.
const dbFilters = {
  get() {
    try { return JSON.parse(localStorage.getItem('esl-db-filters') || '{}'); } catch { return {}; }
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    try { localStorage.setItem('esl-db-filters', JSON.stringify(next)); } catch {}
    return next;
  },
};

// Tier options come from the field definition, so the filter cannot drift away from
// the values the app stores. It offered A-D long after Tier became 1-7, which meant
// every choice in it matched nothing at all.
async function populateTierFilter() {
  const sel = $('#db-f-tier');
  if (!sel) return;
  let opts = [];
  try {
    const defs = await loadFieldDefs();
    opts = (defs.fields.find(f => f.key === 'tier')?.options || []).filter(Boolean);
  } catch {}
  // Rebuild whenever the grades change rather than once at startup. Building once is
  // what let A-D survive the move to 1-7 in the first place.
  const sig = opts.join(',');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  // Switching Tier off takes its filter away too, instead of leaving a dropdown that
  // offers nothing to choose.
  sel.classList.toggle('hidden', !opts.length);
  if (!opts.length) { sel.innerHTML = ''; return; }
  sel.innerHTML = `<option value="">All tiers</option>`
    + opts.map(o => `<option value="${esc(o)}">Tier ${esc(o)}</option>`).join('')
    + `<option value="__none">No tier set</option>`;
}

// The area list comes from his actual data, not a hardcoded list.
function populateAreaFilter(rows) {
  const sel = $('#db-f-area');
  if (!sel || sel.options.length > 1) return;   // build once
  const areas = [...new Set(rows.map(r => r.area || r.city).filter(Boolean))].sort();
  sel.insertAdjacentHTML('beforeend',
    areas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join(''));
}

function applyFiltersAndSort(rows) {
  const f = dbFilters.get();
  // reflect the stored values in the controls
  const search = $('#db-search'), status = $('#db-f-status'), area = $('#db-f-area'),
        tier = $('#db-f-tier'), spec = $('#db-f-spec'), sort = $('#db-sort');
  if (search && document.activeElement !== search) search.value = f.q || '';
  if (status) status.value = f.status || '';
  if (area) area.value = f.area || '';
  if (tier) tier.value = f.tier || '';
  if (spec) spec.value = f.spec || '';
  if (sort) sort.value = f.sort || 'price:desc';

  const q = (f.q || '').toLowerCase().trim();
  let out = rows.filter(r => {
    if (f.status && r.status !== f.status) return false;
    if (f.area && (r.area || r.city) !== f.area) return false;
    // Tier is stored as text but compared loosely: an imported "5" and a typed 5 are
    // the same grade, and String() on both sides is what makes them match.
    if (f.tier === '__none') { if (r.tier) return false; }
    else if (f.tier && String(r.tier ?? '') !== String(f.tier)) return false;
    if (f.spec && r.spec !== f.spec) return false;
    if (q) {
      const hay = `${r.street_line || ''} ${r.address || ''} ${r.area || ''} ${r.city || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const [key, dir] = (f.sort || 'price:desc').split(':');
  const sign = dir === 'asc' ? 1 : -1;
  // Nulls always sort last, whichever direction — an unpriced property at the top of a
  // "highest price" list would be nonsense.
  // Sort on what the column actually DISPLAYS. The address cell falls back to the full
  // address when street_line is empty, so sorting the raw street_line put those rows in
  // a position that didn't match what he could see.
  const valueOf = (r) => key === 'street_line' ? (r.street_line || r.address)
    : key === 'area' ? (r.area || r.city)
    : r[key];

  out = out.slice().sort((a, b) => {
    const av = valueOf(a), bv = valueOf(b);
    const aNull = av == null || av === '', bNull = bv == null || bv === '';
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof av === 'number' || typeof bv === 'number' || /^\d+$/.test(String(av))) {
      return (Number(av) - Number(bv)) * sign;
    }
    return String(av).localeCompare(String(bv)) * sign;
  });

  // Show the "clear" button only when something is actually filtering.
  const active = !!(f.q || f.status || f.area || f.tier || f.spec);
  $('#db-clear')?.classList.toggle('hidden', !active);
  return out;   // renderHead() paints the sort arrow on the right header
}

function clearDbFilters() {
  try { localStorage.removeItem('esl-db-filters'); } catch {}
  dbPage.index = 0;
  renderDatabase({ refetch: false });
}

const onFilterChange = (patch) => {
  dbFilters.set(patch);
  dbPage.index = 0;      // a changed filter means starting from the first page again
  renderDatabase({ refetch: false });
};

$('#db-f-status')?.addEventListener('change', e => onFilterChange({ status: e.target.value }));
$('#db-f-area')?.addEventListener('change', e => onFilterChange({ area: e.target.value }));
$('#db-f-tier')?.addEventListener('change', e => onFilterChange({ tier: e.target.value }));
$('#db-f-spec')?.addEventListener('change', e => onFilterChange({ spec: e.target.value }));
$('#db-sort')?.addEventListener('change', e => onFilterChange({ sort: e.target.value }));
$('#db-clear')?.addEventListener('click', clearDbFilters);

// Debounced so it filters as he types without re-rendering on every keystroke.
let searchTimer = null;
$('#db-search')?.addEventListener('input', e => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => onFilterChange({ q: v }), 200);
});

// Header click-to-sort is bound in renderHead(), because the headers are rebuilt
// whenever his column choice changes.

// Pager readout + button state. Says "1–50 of 75" rather than just a page number, so
// he can see how much there is without counting.
function updatePager(total, start, shown, pages = 1) {
  const count = $('#db-count'), page = $('#db-page');
  const prev = $('#db-prev'), next = $('#db-next');
  if (!count) return;
  count.textContent = total
    ? `${start + 1}–${start + shown} of ${total}`
    : 'No properties';
  page.textContent = pages > 1 ? `Page ${dbPage.index + 1} of ${pages}` : '';
  const onlyOne = pages <= 1;
  // Hide the arrows entirely when everything fits — dead controls are just noise.
  prev.classList.toggle('hidden', onlyOne);
  next.classList.toggle('hidden', onlyOne);
  prev.disabled = dbPage.index === 0;
  next.disabled = dbPage.index >= pages - 1;
}

$('#db-per-page')?.addEventListener('change', (e) => {
  dbPage.perPage = e.target.value;
  dbPage.index = 0;                      // a new page size means starting from the top
  renderDatabase({ refetch: false });    // already have the rows; just re-slice
});
$('#db-prev')?.addEventListener('click', () => {
  if (dbPage.index > 0) { dbPage.index--; renderDatabase({ refetch: false }); scrollTableTop(); }
});
$('#db-next')?.addEventListener('click', () => {
  dbPage.index++; renderDatabase({ refetch: false }); scrollTableTop();
});
// Changing page should put him at the top of the table, not partway down the previous
// scroll position.
function scrollTableTop() {
  $('#view-database')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// The status values are internal; show him words instead.
// Every status the app actually writes. `imported` was missing, so his own properties
// showed a raw lowercase "imported" pill and could not be filtered for at all — and
// after a full import they are the largest group in the database.
function statusLabel(s) {
  return { in_review: 'In review', approved: 'Approved', processing: 'Processing',
           ready: 'Ready', live: 'In Drive', passed: 'Passed',
           imported: 'Yours' }[s] || s;
}

// Which of his three searches a property came from. The raw values are hyphenated
// slugs; he should see the words he used when he described the specs.
function specLabel(s) {
  return { 'for-sale': 'For sale', 'sold': 'Sold', 'for-rent': 'For rent' }[s] || s || '—';
}

$('#btn-csv')?.addEventListener('click', async () => {
  // Export exactly what the table is showing him — every page of it, with his filters
  // and sort applied, rather than the raw unfiltered set.
  const rows = dbRows.length ? applyFiltersAndSort(dbRows) : await api('/listings');
  // Feed/AI columns first, then his own fields — restricted ones only if he may see
  // them (the API already omits those values otherwise, so this keeps headers honest).
  const defs = await loadFieldDefs();
  // `spec` is the listing type (for sale / sold / rent) and `source` names the MLS or
  // brokerage the row came from — both are things he asked to be able to see, so they
  // belong in the file he hands round as much as on screen.
  // For a sold comp, last_updated holds the sale date (that is the only "when" that
  // matters on a past sale), so it is exported under a name that says so.
  const cols = ['address', 'city', 'area', 'spec', 'status', 'source', 'mls_id', 'last_updated',
    'price', 'beds', 'baths', 'sqft', 'lot_acres', 'floors', 'parking', 'year_built',
    'property_style', 'furnished', 'gated_community', 'neighborhood', 'description']
    .concat(defs.fields.map(f => f.key));
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => {
    let v = r[c]; if (Array.isArray(v)) v = v.join(' | '); if (v == null) v = '';
    v = String(v).replace(/"/g, '""'); return /[",\n]/.test(v) ? `"${v}"` : v;
  }).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'essentialyfe-properties.csv'; a.click();
});

// ---------- detail overlay ----------
// The explicit "Edit fields" button — same overlay as clicking the row, but visible,
// because he looked for field editing and didn't find it.
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  e.stopPropagation();
  const l = await api('/listing/' + btn.dataset.edit);
  openDetail(l);
  // jump straight to his columns rather than making him scroll past the feed data
  setTimeout(() => $('#dt-editable')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
});

document.addEventListener('click', async e => {
  if (e.target.closest('[data-edit]')) return; // handled above
  const row = e.target.closest('[data-id]');
  if (!row) return;
  if (e.target.closest('.act') || e.target.closest('a')) return;
  const id = row.dataset.id;
  const l = await api('/listing/' + id);
  openDetail(l);
});
function openDetail(l) {
  const palette = (l.color_palette || []).map(c => `<span style="background:${esc(c)}"></span>`).join('');
  const styleStr = (l.property_style || []).join(' · ') || '—';
  // The gallery at the top shows every photo and names the room on each one, and the
  // filenames in Drive carry the same tags — so neither needs repeating in full here.
  // What is worth one line is the coverage: how many photos, and which rooms.
  // Tags come from the cleaned set once it exists, and from the source gallery before
  // that — realtor.com labels each photo, so the rooms are known at collection time.
  const tagged = (l.images || []).length ? (l.images || []) : sourcePhotos(l);
  const photoCount = tagged.length;
  const roomCounts = {};
  tagged.forEach(im => { if (im && im.tag) roomCounts[im.tag] = (roomCounts[im.tag] || 0) + 1; });
  const roomsCovered = Object.entries(roomCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([room, n]) => `${esc(room)}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ');
  const drivePath = `EssentiaLyfe – Sourcing Autopilot / ${l.address} /`;
  const isReady = ['ready', 'live'].includes(l.status);

  // The gallery, laid out like his own site (essentialyfe.com): one big photo with a
  // strip of smaller ones beside it, and a "View all photos" button when there are
  // more than the strip can hold. He asked for exactly this on the call — the point
  // is that a property should look familiar the moment it opens, rather than needing
  // to be re-read each time.
  // How many photos there are to show. `images` only exists once a property has been
  // approved and run through the cleaning pipeline; before that — and for anything he
  // passed on — the real gallery still sits in photo_urls from collection time. Using
  // only `images` meant a listing with 65 real photos showed a single placeholder.
  // Cap on what imgFor can actually resolve: num_photos is the source's own count and
  // can exceed the URLs we hold, which would make the gallery repeat images.
  const shotCount = (l.images || []).length || realPhotos(l).length;
  const shots = shotCount ? Array.from({ length: shotCount }, (_, i) => i) : [0];
  const THUMBS = 4;                       // beside the main image
  const strip = shots.slice(1, 1 + THUMBS);
  const moreCount = Math.max(0, shots.length - (1 + THUMBS));
  // Photos only go through the cleaning pipeline when he likes a property, so anything
  // he has not approved is the raw listing image — MLS corner logo still on it. Say so
  // on the photo itself rather than letting him wonder why this one looks different.
  // Photos read out of HIS OWN Drive folder are already the finished article — he
  // cleaned and filed them himself. They are served through /api/drive-image, which is
  // what identifies them. Nothing about them needs the approval pipeline.
  const fromHisDrive = sourcePhotos(l).some(p => /^\/api\/drive-image\//.test(p.url || ''));
  const cleaned = (l.images || []).length > 0 || fromHisDrive;
  // No real photos at all: the card falls back to library images so it is not blank,
  // but they are NOT this house. Say so plainly — he spotted this on 664 Radcliffe,
  // where the card showed a glass villa and the listing is a small white bungalow.
  const standIn = !cleaned && shotCount === 0;
  // A property imported from his spreadsheet has no per-image URLs — his sheet links a
  // Drive or Dropbox FOLDER, not individual photos. So the gallery has nothing to draw
  // and the honest thing is to point at the folder he already keeps them in.
  const ownFolder = standIn && l.photos_url ? l.photos_url : null;
  // Order matters: a folder we were refused is a MORE specific fact than "there is a
  // folder", and it is the one he can act on, so it is tested first.
  const rawBadge = fromHisDrive
    ? `<span class="dt-gal-raw own" title="Read from the photo folder your spreadsheet links for this property.">📁 Your own photos</span>`
    : l.photos_folder_denied
      ? `<span class="dt-gal-raw stand-in" title="Your spreadsheet links a photo folder for this property, but this app's Google account cannot open it. Share the folder with it and the photos come straight in.">⚠ Your photo folder is not shared with this app</span>`
      : ownFolder
        ? `<span class="dt-gal-raw stand-in" title="Imported from your spreadsheet, which links a photo folder rather than individual images.">⚠ No photos yet — yours are in the linked folder</span>`
        : standIn
          ? `<span class="dt-gal-raw stand-in" title="Neither your folder nor the listing data has a photograph of this property.">⚠ No photo available for this property</span>`
          : (!cleaned && shotCount)
            ? `<span class="dt-gal-raw" title="Photos are cleaned, tagged and filed in your Drive when you like a property.">Original listing photo — not cleaned yet</span>`
            : '';
  const gallery = `
    <div class="dt-gal">
      <button class="dt-gal-main" data-photo="0">
        <img src="${imgFor(l, shots[0])}" alt="">
        ${isReady ? '<span class="dt-status">READY</span>' : ''}
        ${rawBadge}
      </button>
      ${strip.length ? `<div class="dt-gal-side">
        ${strip.map((i, n) => `
          <button class="dt-gal-thumb" data-photo="${i}">
            <img src="${imgFor(l, i)}" alt="">
            ${(n === strip.length - 1 && moreCount) ? `<span class="dt-gal-more">+${moreCount}</span>` : ''}
          </button>`).join('')}
      </div>` : ''}
      ${ownFolder
        ? `<a class="dt-gal-all" href="${esc(ownFolder)}" target="_blank" rel="noopener">📁 Open your photo folder</a>`
        : (shots.length > 1 ? `<button class="dt-gal-all" id="dt-view-all">▦ View all ${shots.length} photos</button>` : '')}
      <button class="dt-close" id="dt-close" title="Close">×</button>
    </div>`;

  $('#detail-card').innerHTML = `
    ${gallery}
    <div class="dt-top">
      <div class="dt-hero hidden">
        <img src="${imgFor(l)}" alt="">
      </div>
      <div class="dt-headline">
        <h2>${esc(l.street_line || l.address)}</h2>
        <div class="sub">${esc(l.area || l.city)}, ${esc(l.state)} ${esc(l.zip || '')}</div>
        <div class="dt-quick">
          <span class="pill spec-${esc(l.spec || '')}">${esc(specLabel(l.spec))}</span>
          <span class="pill ${esc(l.status)}">${esc(statusLabel(l.status))}</span>
          ${l.tier ? `<span class="t">Tier ${esc(l.tier)}</span>` : ''}
        </div>
        <div class="dt-headline-facts">
          <div><b>${fmt(l.price)}${l.is_rental ? '/mo' : ''}</b><span>Price</span></div>
          <div><b>${l.beds ?? '—'}</b><span>Beds</span></div>
          <div><b>${l.baths ?? '—'}</b><span>Baths</span></div>
          <div><b>${l.sqft ? l.sqft.toLocaleString() : '—'}</b><span>Sq. ft.</span></div>
        </div>
      </div>
    </div>
    <div class="dt-body">
      <!-- Review from here too, so he can decide straight from the database rather than
           having to find the property again in the review queue. -->
      ${fromHisDrive ? `
      <!-- Already his: the photos came out of his own Drive folder, cleaned and filed
           by him. There is nothing to approve, so the bar links the folder instead of
           offering Like and Pass. -->
      <div class="dt-decide own">
        <div class="dt-decide-now">Already yours. These photos are from your own Drive folder.</div>
        ${l.photos_url ? `<a class="act own-folder" href="${esc(l.photos_url)}" target="_blank" rel="noopener">📁 Open the folder</a>` : ''}
      </div>` : `
      <div class="dt-decide" id="dt-decide">
        <div class="dt-decide-now" id="dt-decide-now">${decisionText(l.status)}</div>
        <div class="dt-decide-acts">
          <button class="act pass" id="dt-pass">✕ Pass</button>
          <button class="act like" id="dt-like">♡ Like</button>
        </div>
      </div>`}

      <div class="dt-cols">
        <div>
          ${dtRow('lot_acres', 'Lot size', l.lot_acres ? l.lot_acres + ' acres' : '—')}
          ${dtRow('floors', 'Floors / Parking', `${l.floors ?? '—'} / ${l.parking ?? '—'}`)}
          ${dtRow('year_built', 'Year built', l.year_built ?? '—')}
          ${dtRow('county', 'County', esc(l.county || '—'))}
          <div class="dt-field"><span class="k">Where it came from</span><span class="v">${esc(l.source || '—')}</span></div>
          <div class="dt-field"><span class="k">Brokerage</span><span class="v">${esc(l.brokerage || '—')}</span></div>
          <div class="dt-field"><span class="k">MLS #</span><span class="v">${esc(l.mls_id || '—')}</span></div>
          <!-- source_url is where WE fetched the record; listing_url is the link from
               his own spreadsheet, which is usually Zillow. Preferring his link made
               the table say "Realtor" while this row opened Zillow. Show the source
               we actually used here, and keep his own link on its own line. -->
          <div class="dt-field"><span class="k">Listing page</span><span class="v">${detailLink(l.source_url || l.listing_url)}</span></div>
          ${l.listing_url && l.source_url && l.listing_url !== l.source_url
            ? `<div class="dt-field"><span class="k">Your saved link</span><span class="v">${detailLink(l.listing_url)}</span></div>` : ''}
          <div class="dt-field"><span class="k">Photos</span><span class="v">${standIn
            ? `<span class="warn">none for this listing</span>`
            : `${photoCount || l.num_photos || '—'}${
                fromHisDrive ? ' — from your own folder'
                : (l.images || []).length ? ' — cleaned &amp; tagged'
                : ' — from the listing'}`}</span></div>
        </div>
        <div>
          ${dtRow('property_style', 'Property style', esc(styleStr))}
          ${dtRow('furnished', 'Furnished', esc(l.furnished || '—'))}
          ${dtRow('also_known_as', 'Also known as', esc(l.also_known_as || '—'))}
          ${dtRow('neighborhood', 'Neighborhood', esc(l.neighborhood || l.city || '—'))}
          ${dtRow('gated_community', 'Gated community', esc(l.gated_community || '—'))}
          ${dtRow('sleep_capacity', 'Sleep / Seat / Stand',
              `${l.sleep_capacity ?? '—'} / ${l.seating_capacity ?? '—'} / ${l.stand_capacity ?? '—'}`)}
          ${dtRow('architect', 'Architect', esc(l.architect || '—'))}
          ${dtRow('amenities', 'Color palette', `<span class="palette">${palette || '—'}</span>`)}
        </div>
      </div>

      ${isHidden('description') ? '' : `
      <div class="dt-section-t">Description</div>
      <p class="dt-desc">${esc(l.description || '—')}</p>`}

      <div class="drive-row">
        <span class="dr-ic">📁</span>
        <div class="dr-text">
          <b>${fromHisDrive
            ? `${photoCount} photo${photoCount === 1 ? '' : 's'} in your own folder`
            : (l.images || []).length
              ? `${photoCount} photo${photoCount === 1 ? '' : 's'} in your Drive`
              : 'Not in your Drive yet'}</b>
          ${fromHisDrive
            ? `<span class="dr-sub">Already cleaned and filed by you, so nothing to approve.</span>`
            : (l.images || []).length
              ? `<span class="dr-sub">${roomsCovered || 'Cleaned and filed by room.'}</span>`
              : `<span class="dr-sub">Like this property and the photos are cleaned, tagged and filed here.</span>`}
        </div>
        ${fromHisDrive && l.photos_url
          ? `<a class="dr-open" href="${esc(l.photos_url)}" target="_blank" rel="noopener">Open folder →</a>`
          : l.drive_folder_url
            ? `<a class="dr-open" href="${l.drive_folder_url}" target="_blank" title="${esc(drivePath)}">Open folder →</a>`
            : (state.summary?.driveMode === 'live' ? '' : `<span class="dr-pending" title="Connecting the service account to your master folder makes this live — no code change.">Prepared, not yet uploaded</span>`)}
      </div>

      <div class="dt-section-t">Your fields <span class="muted" style="font-weight:400;font-size:12px">— editable, saved to this property</span></div>
      <div id="dt-editable"></div>

      <div class="owner-box"><span>🔒</span><div><b>Owner outreach</b> — skip-trace via API, permission-gated. <span class="muted">Queued for Phase 2, exactly as in your walkthrough.</span></div></div>
    </div>`;
  $('#detail-overlay').classList.remove('hidden');
  $('#dt-close').onclick = () => $('#detail-overlay').classList.add('hidden');
  $('#detail-overlay').onclick = (ev) => { if (ev.target.id === 'detail-overlay') $('#detail-overlay').classList.add('hidden'); };
  wireGallery(l, shots);
  wireDecision(l);
  mountEditableFields(l);
}

// Clicking any photo — or "View all" — opens the full set. Arrow keys and Escape work,
// because this is the one screen he will page through repeatedly.
function wireGallery(l, shots) {
  const open = (start = 0) => {
    let at = start;
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `
      <button class="lb-close" title="Close">×</button>
      <button class="lb-nav prev" title="Previous">‹</button>
      <img class="lb-img" src="${imgFor(l, shots[at])}" alt="">
      <button class="lb-nav next" title="Next">›</button>
      <div class="lb-count"></div>
      <div class="lb-strip">${shots.map((i, n) =>
        `<img data-n="${n}" src="${imgFor(l, i)}" alt="">`).join('')}</div>`;
    document.body.appendChild(box);

    const img = box.querySelector('.lb-img');
    const count = box.querySelector('.lb-count');
    const paint = () => {
      img.src = imgFor(l, shots[at]);
      // Same fallback as the gallery: cleaned set if it exists, source gallery if not.
      const tagged = (l.images || []).length ? (l.images || []) : sourcePhotos(l);
      const tag = tagged[shots[at]]?.tag;
      // The MLS corner logo is still on these until the property is liked, so the
      // counter says which kind of photo he is looking at.
      const raw = (l.images || []).length ? '' : ' · original listing photo';
      count.textContent = `${at + 1} / ${shots.length}${tag ? ' · ' + tag : ''}${raw}`;
      box.querySelectorAll('.lb-strip img').forEach(t =>
        t.classList.toggle('on', +t.dataset.n === at));
      box.querySelector('.lb-strip img.on')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    };
    const step = (d) => { at = (at + d + shots.length) % shots.length; paint(); };
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    }

    box.querySelector('.lb-close').onclick = close;
    box.querySelector('.prev').onclick = () => step(-1);
    box.querySelector('.next').onclick = () => step(1);
    box.onclick = (e) => { if (e.target === box) close(); };
    box.querySelectorAll('.lb-strip img').forEach(t =>
      t.onclick = () => { at = +t.dataset.n; paint(); });
    document.addEventListener('keydown', onKey);
    paint();
  };

  $('#dt-view-all')?.addEventListener('click', () => open(0));
  document.querySelectorAll('#detail-card [data-photo]').forEach(btn =>
    btn.addEventListener('click', () => open(shots.indexOf(+btn.dataset.photo))));
}

// What the decision bar says about where this property currently stands.
function decisionText(status) {
  if (status === 'passed') return 'You passed on this one.';
  if (['approved', 'processing'].includes(status)) return 'Liked — images are being processed.';
  if (['ready', 'live'].includes(status)) return 'Liked — cleaned images are in your Drive.';
  return 'Not reviewed yet.';
}

// Pass / Like from the detail overlay. Same endpoints the review queue uses, but it
// stays on the property instead of advancing to the next card, because here he opened
// this one deliberately.
function wireDecision(l) {
  const bar = $('#dt-decide');
  if (!bar) return;
  const now = $('#dt-decide-now');
  const pass = $('#dt-pass'), like = $('#dt-like');

  const paint = (status) => {
    const liked = ['approved', 'processing', 'ready', 'live'].includes(status);
    now.textContent = decisionText(status);
    // Grey out the choice he's already on, so the current state is obvious.
    pass.classList.toggle('chosen', status === 'passed');
    like.classList.toggle('chosen', liked);
    // Once it's approved, Like is genuinely unavailable: pressing it again would
    // re-run the image pipeline and duplicate the photos in his Drive.
    like.disabled = liked;
    like.title = liked ? 'Already approved — the images are in your Drive' : '';
  };
  paint(l.status);

  const decide = async (action) => {
    pass.disabled = like.disabled = true;
    now.textContent = action === 'approve' ? 'Liking…' : 'Passing…';
    try {
      await api(`/listing/${l.id}/${action}`, { method: 'POST' });
      l.status = action === 'approve' ? 'approved' : 'passed';
      paint(l.status);
      await refreshSummary();
      // Refresh the table underneath without losing his page, filters or sort.
      if (document.querySelector('.nav-item.active')?.dataset.view === 'database') {
        const keep = dbPage.index;
        const row = dbRows.find(r => String(r.id) === String(l.id));
        if (row) row.status = l.status;          // update in place — no refetch needed
        dbPage.index = keep;
        renderDatabase({ refetch: false });
      }
      state.queue = state.queue.filter(x => String(x.id) !== String(l.id));
    } catch (e) {
      now.textContent = e.message;
      pass.disabled = like.disabled = false;
    } finally {
      // Re-enable via paint(), not blindly — otherwise Like would become clickable
      // again on an approved property and duplicate the Drive folder.
      pass.disabled = false;
      paint(l.status);
    }
  };
  pass.onclick = () => decide('pass');
  like.onclick = () => decide('approve');
}

// ---------- his own fields: the editable half of a property ----------
// Everything above in the detail card comes from the listing feed and the AI and is
// read-only. This section is his: rates, tier, contacts, access notes — the values no
// feed can supply. The form is generated from /api/fields, so adding a field server-side
// makes it appear here with no frontend change.
let FIELD_DEFS = null;

async function loadFieldDefs() {
  if (FIELD_DEFS) return FIELD_DEFS;
  try {
    FIELD_DEFS = await api('/fields');
    // Fields he created himself are editable on the property too, in their own group.
    const custom = await api('/custom-fields').catch(() => []);
    if (custom.length) {
      FIELD_DEFS = {
        ...FIELD_DEFS,
        fields: [...FIELD_DEFS.fields, ...custom.map(f => ({ ...f, group: 'Your own fields' }))],
        groups: [...FIELD_DEFS.groups, 'Your own fields'],
      };
    }
  } catch { FIELD_DEFS = { fields: [], groups: [], canViewSensitive: false }; }
  return FIELD_DEFS;
}

function fieldInput(f, value) {
  const v = value == null ? '' : String(value);
  const common = `id="fld-${f.key}" data-key="${f.key}" class="fld-input"`;
  if (f.type === 'textarea') return `<textarea ${common} rows="2">${esc(v)}</textarea>`;
  if (f.type === 'select') {
    return `<select ${common}>${(f.options || []).map(o =>
      `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${o === '' ? '—' : esc(o)}</option>`).join('')}</select>`;
  }
  if (f.type === 'date') return `<input ${common} type="date" value="${esc(v)}">`;
  if (f.type === 'money' || f.type === 'number') {
    return `<input ${common} type="text" inputmode="numeric" value="${esc(v)}" placeholder="—">`;
  }
  // A URL stays editable, but gets an "open" arrow beside it when there is something
  // to open — so a link from his sheet is one click away rather than copy-paste.
  if (f.type === 'url') {
    const openable = /^https?:\/\//i.test(v) || /^mailto:/i.test(v);
    return `<span class="fld-url">
      <input ${common} type="text" value="${esc(v)}" placeholder="https://…">
      ${openable ? `<a class="fld-open" href="${esc(v)}" target="_blank" rel="noopener" title="Open ${esc(v)}">↗</a>` : ''}
    </span>`;
  }
  return `<input ${common} type="text" value="${esc(v)}" placeholder="—">`;
}

async function mountEditableFields(listing) {
  const host = $('#dt-editable');
  if (!host) return;
  const defs = await loadFieldDefs();
  if (!defs.fields.length) { host.innerHTML = `<div class="muted" style="font-size:12px">No editable fields configured.</div>`; return; }

  const groups = defs.groups.map(g => {
    const inGroup = defs.fields.filter(f => f.group === g);
    if (!inGroup.length) return '';
    const isPrivate = inGroup.some(f => f.sensitive);
    return `
      <div class="fld-group">
        <div class="fld-group-t">${esc(g)}${isPrivate ? ' <span class="fld-lock" title="Only people you give access to can see these">🔒 restricted</span>' : ''}</div>
        <div class="fld-grid">
          ${inGroup.map(f => `
            <label class="fld">
              <span class="fld-l">${esc(f.label)}${f.type === 'money' ? ' <span class="muted">(USD)</span>' : ''}</span>
              ${fieldInput(f, listing[f.key])}
            </label>`).join('')}
        </div>
      </div>`;
  }).join('');

  host.innerHTML = `
    ${groups}
    ${defs.canViewSensitive ? '' : `<div class="fld-note">🔒 Contacts and private notes are restricted — ask an admin for access.</div>`}
    <div class="fld-actions">
      <button class="btn-primary" id="fld-save">Save changes</button>
      <span class="fld-status" id="fld-status"></span>
    </div>`;

  const status = (msg, cls = '') => { const el = $('#fld-status'); el.className = 'fld-status ' + cls; el.textContent = msg; };

  // Track what actually changed so a save only sends real edits.
  const initial = {};
  host.querySelectorAll('.fld-input').forEach(el => { initial[el.dataset.key] = el.value; });
  host.querySelectorAll('.fld-input').forEach(el => {
    el.addEventListener('input', () => status(''));
  });

  $('#fld-save').onclick = async () => {
    const patch = {};
    host.querySelectorAll('.fld-input').forEach(el => {
      if (el.value !== initial[el.dataset.key]) patch[el.dataset.key] = el.value;
    });
    if (!Object.keys(patch).length) return status('Nothing changed.');
    $('#fld-save').disabled = true;
    status('Saving…');
    try {
      const r = await fetch('/api/listing/' + listing.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      // Re-render from what the server stored, so he sees the normalized value
      // ("$15,000/mo" coming back as 15000) rather than what he typed.
      Object.assign(listing, d.listing || {});
      host.querySelectorAll('.fld-input').forEach(el => {
        const v = listing[el.dataset.key];
        el.value = v == null ? '' : String(v);
        initial[el.dataset.key] = el.value;
      });
      status(`Saved ${d.updated} field${d.updated === 1 ? '' : 's'}.`, 'ok');
      // Refresh the table but keep him on the page he was editing from.
      if (document.querySelector('.nav-item.active')?.dataset.view === 'database') {
        const keep = dbPage.index;
        renderDatabase().then(() => { dbPage.index = keep; renderDatabase({ refetch: false }); });
      }
    } catch (e) {
      status(e.message, 'err');
    } finally {
      $('#fld-save').disabled = false;
    }
  };
}

// ---------- automation (all-day collector + daily email schedule) ----------
// The collector ships paused because every pass costs real API calls; this panel is
// where he turns it on once the data subscription is live.
function whenText(iso) {
  if (!iso) return 'never';
  if (iso === 'due now') return 'due now';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const mins = Math.round((d - Date.now()) / 60000);
  const stamp = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (mins > 0) return `${stamp} (in ${mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h'})`;
  const ago = -mins;
  return `${stamp} (${ago < 60 ? ago + 'm' : Math.round(ago / 60) + 'h'} ago)`;
}

async function renderAutomation() {
  // Guard on a control that actually exists. This used to look for #auto-box, an
  // element that went away when Settings was rebuilt — so the function returned
  // early and the hour dropdown below was never filled in, leaving it blank.
  if (!$('#auto-hour')) return;
  let s;
  try { s = await api('/automation'); } catch (e) { $('#auto-msg').textContent = e.message; return; }

  $('#auto-collector').checked = !!s.collector.enabled;
  $('#auto-interval').value = String(s.collector.intervalMin);
  $('#auto-collector-state').textContent = s.collector.enabled ? 'on' : 'paused';
  $('#auto-collector-state').className = 'auto-state ' + (s.collector.enabled ? 'on' : 'off');
  $('#auto-collector-sub').innerHTML = s.collector.enabled
    ? `Last run ${esc(whenText(s.collector.lastRunAt))} · next ${esc(whenText(s.collector.nextRunAt))}`
    : `Paused — it won't pull new listings or use any of your data allowance.`;

  // hour picker
  const hourSel = $('#auto-hour');
  if (!hourSel.options.length) {
    // 12-hour labels, because that's how he'd say the time — and the value is his
    // local hour, so there is no timezone maths for him to do.
    hourSel.innerHTML = Array.from({ length: 24 }, (_, h) => {
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `<option value="${h}">${h12}:00 ${h < 12 ? 'am' : 'pm'}</option>`;
    }).join('');
  }
  hourSel.value = String(s.digest.hourPT);
  $('#auto-digest').checked = !!s.digest.enabled;
  $('#auto-digest-state').textContent = s.digest.enabled ? 'on' : 'off';
  $('#auto-digest-state').className = 'auto-state ' + (s.digest.enabled ? 'on' : 'off');
  // The hour is already his own time, so no conversion to show.
  $('#auto-digest-sub').innerHTML = s.digest.enabled
    ? `Next ${esc(whenText(s.digest.nextDigestAt))}`
    : `Off — no daily email will be sent.`;

  if (s.mailMode === 'log') {
    $('#auto-digest-sub').innerHTML += ` <span class="muted">No email sender connected.</span>`;
  }
  if (s.lastError) {
    $('#auto-msg').className = 'digest-msg err';
    $('#auto-msg').textContent = `Last run failed: ${s.lastError.message}`;
  } else {
    $('#auto-msg').textContent = '';
  }
}

async function saveAutomation(patch, note) {
  const msg = (t, cls = '') => { const el = $('#auto-msg'); el.className = 'digest-msg ' + cls; el.textContent = t; };
  msg('Saving…');
  try {
    await apiSend('PATCH', '/automation', patch);
    msg(note || 'Saved.', 'ok');
    await renderAutomation();
  } catch (e) { msg(e.message, 'err'); await renderAutomation(); }
}

$('#auto-collector')?.addEventListener('change', e =>
  saveAutomation({ collectorEnabled: e.target.checked },
    e.target.checked ? 'All-day collector is on.' : 'Collector paused.'));
$('#auto-interval')?.addEventListener('change', e =>
  saveAutomation({ intervalMin: +e.target.value }));
$('#auto-digest')?.addEventListener('change', e =>
  saveAutomation({ digestEnabled: e.target.checked },
    e.target.checked ? 'Daily email is on.' : 'Daily email off.'));
$('#auto-hour')?.addEventListener('change', e =>
  saveAutomation({ hourPT: +e.target.value }));

// ---------- price changes ----------
async function renderPrices() {
  const body = $('#prices-body');
  if (!body.children.length) body.innerHTML = `<tr><td colspan="8" class="muted" style="padding:18px">Loading…</td></tr>`;
  const days = $('#prices-days')?.value || 30;
  const dropsOnly = $('#prices-drops-only')?.checked;
  let rows = [];
  try {
    rows = await api(`/price-changes?days=${days}${dropsOnly ? '&drops=1' : ''}`);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="muted">${esc(e.message)}</td></tr>`;
    return;
  }
  const badge = $('#badge-prices'); if (badge) badge.textContent = rows.length;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">
      No ${dropsOnly ? 'price drops' : 'price changes'} in this period. Every property the collector
      re-sees at the same price is left alone.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(l => {
    const down = l.drop > 0;
    const when = l.price_changed_at ? new Date(l.price_changed_at).toLocaleDateString() : '—';
    return `
    <tr data-id="${l.id}">
      <td><img class="t-thumb" src="${imgFor(l)}" alt=""></td>
      <td><b>${esc(l.street_line || l.address)}</b></td>
      <td>${esc(l.area || l.city || '')}</td>
      <td class="muted">${fmt(l.previous_price)}</td>
      <td class="t-price">${fmt(l.price)}</td>
      <td><span class="delta ${down ? 'down' : 'up'}">${down ? '▼' : '▲'} ${fmt(Math.abs(l.drop))}${
        l.dropPct != null ? ` <span class="muted">${Math.abs(l.dropPct)}%</span>` : ''}</span></td>
      <td class="muted">${esc(when)}</td>
      <td><span class="pill ${l.status}">${l.status === 'in_review' ? 'In review' : l.status === 'ready' ? 'Ready' : l.status}</span></td>
    </tr>`;
  }).join('');
}
$('#prices-days')?.addEventListener('change', renderPrices);
$('#prices-drops-only')?.addEventListener('change', renderPrices);

// ---------- daily email ----------
// Shows what the next email would say, and lets him send it to himself to check.
async function refreshDigest() {
  const sum = $('#digest-sum');
  if (!sum) return;
  try {
    const d = await api('/digest/preview?days=1');
    // Same payload feeds the sidebar badge — no second request for a number we have.
    const badge = $('#badge-prices');
    if (badge) badge.textContent = d.priceChangeCount ?? 0;
    const bits = [];
    if (d.newCount) bits.push(`${d.newCount} new propert${d.newCount === 1 ? 'y' : 'ies'}`);
    if (d.priceChangeCount) bits.push(`${d.priceChangeCount} price change${d.priceChangeCount === 1 ? '' : 's'}`);
    sum.innerHTML = bits.length
      ? `Next email: <b>${bits.join('</b>, <b>')}</b>.`
      : `Nothing new to report since the last email.`;
    if (d.mailMode === 'log') {
      sum.innerHTML += ` <span class="muted">No email sender is connected yet, so it would only be logged.</span>`;
    }
  } catch (e) {
    // Don't silently blank it — a summary stuck on "—" is indistinguishable from a
    // real "nothing to report", which cost time to diagnose once already.
    console.error('digest preview failed:', e.message);
    sum.innerHTML = `<span class="muted">Couldn't load the summary.</span>`;
  }
}

// Wiping the database is irreversible and the button sits in the same panel stack as
// everyday settings, so it asks twice — once for intent, once for the count it is
// about to destroy — rather than relying on the label alone.
$('#btn-reset')?.addEventListener('click', async () => {
  const msg = (t, cls = '') => { const el = $('#reset-msg'); el.className = 'digest-msg ' + cls; el.textContent = t; };
  const btn = $('#btn-reset');
  const n = state.summary?.counts?.sourced ?? 0;
  if (!confirm(`Delete all ${n} properties?\n\nThis cannot be undone. Your account, your team and anything already in your Google Drive are not affected.`)) return;
  if (!confirm('Last check — every property will be removed. Continue?')) return;
  btn.disabled = true;
  msg('Deleting…');
  try {
    await apiSend('POST', '/reset', {});
    msg(`Deleted ${n} properties. Run the collector to start filling it again.`, 'ok');
    await renderDashboard();
    if (typeof renderDatabase === 'function') await renderDatabase();
  } catch (e) { msg(e.message, 'err'); }
  btn.disabled = false;
});

// Photos for imported properties. Reports what it found in his terms — how many now
// have pictures, and how many the data source simply has none for — because a bare
// "25 checked" would not tell him whether it worked.
$('#btn-imp-photos')?.addEventListener('click', async () => {
  const msg = (t, cls = '') => { const el = $('#imp-photos-msg'); el.className = 'digest-msg ' + cls; el.textContent = t; };
  const btn = $('#btn-imp-photos');
  const limit = +($('#imp-photos-n')?.value || 25);
  btn.disabled = true;
  msg(`Looking up ${limit} properties… this takes a moment.`);
  try {
    const r = await apiSend('POST', '/import/photos', { limit });
    if (!r.checked) {
      msg('Every property already has photos.', 'ok');
    } else {
      const bits = [`${r.updated} of ${r.checked} now have their real photos`];
      const where = [r.fromDrive ? `${r.fromDrive} from your Drive folders` : null,
                     r.fromListing ? `${r.fromListing} from the listing data` : null].filter(Boolean);
      if (where.length) bits.push(where.join(', '));
      if (r.noneAvailable) bits.push(`${r.noneAvailable} had none available`);
      if (r.remaining) bits.push(`${r.remaining} still to do`);
      msg(bits.join(' · '), 'ok');
      await renderDatabase();
    }
  } catch (e) { msg(e.message, 'err'); }
  btn.disabled = false;
});

$('#btn-digest-send')?.addEventListener('click', async () => {
  const msg = (t, cls = '') => { const el = $('#digest-msg'); el.className = 'digest-msg ' + cls; el.textContent = t; };
  const btn = $('#btn-digest-send');
  btn.disabled = true;
  msg('Sending…');
  try {
    const r = await apiSend('POST', '/digest/send', { days: 1, toMe: true, force: true });
    if (r.sent) {
      const who = r.recipients?.map(x => x.to).join(', ') || 'you';
      msg(`Sent to ${who}. Check your inbox.`, 'ok');
    } else {
      msg(r.reason === 'nothing to report'
        ? 'Nothing to report right now.'
        : `Not sent: ${r.recipients?.[0]?.error || r.reason || 'no email sender configured'}`, 'err');
    }
  } catch (e) { msg(e.message, 'err'); }
  finally { btn.disabled = false; }
});

// ---------- team & permissions (admin only) ----------
// The restricted fields (contacts, owner temper, wifi, access) are gated per person.
// Gating happens on the SERVER — those columns are stripped from the API response for
// anyone without access, so this screen grants real access, not just a hidden UI.
async function renderTeam() {
  const body = $('#team-body');
  const msg = (t, cls = '') => { const el = $('#team-msg'); el.className = 'team-msg ' + cls; el.textContent = t; };
  let users = [];
  // Say "loading" rather than showing an empty table for the length of the fetch.
  body.innerHTML = `<tr><td colspan="5" class="muted" style="padding:18px">Loading team…</td></tr>`;
  try { users = await api('/auth/users'); } catch (e) { body.innerHTML = `<tr><td colspan="5" class="muted">${esc(e.message)}</td></tr>`; return; }

  const meId = String(state.user?.id || '');
  const admins = users.filter(u => u.role === 'admin').length;

  body.innerHTML = users.map(u => {
    const isMe = String(u.id) === meId;
    const isAdmin = u.role === 'admin';
    // An admin sees everything by definition, so the checkbox is on and locked.
    return `
    <tr data-uid="${u.id}">
      <td><b>${esc(u.name || '—')}</b>${isMe ? '<span class="team-you">you</span>' : ''}</td>
      <td>${esc(u.email)}</td>
      <td>
        <select class="role-sel" data-uid="${u.id}"${isMe && admins <= 1 ? ' disabled title="You are the only admin"' : ''}>
          <option value="member"${!isAdmin ? ' selected' : ''}>Member</option>
          <option value="admin"${isAdmin ? ' selected' : ''}>Admin</option>
        </select>
      </td>
      <td>
        <label class="team-chk">
          <input type="checkbox" class="sens-chk" data-uid="${u.id}"
                 ${isAdmin || u.can_view_sensitive ? 'checked' : ''}
                 ${isAdmin ? 'disabled title="Admins always see every field"' : ''}>
          ${isAdmin ? '<span class="muted">always</span>' : '<span>allowed</span>'}
        </label>
      </td>
      <td>
        <button class="act-danger" data-remove="${u.id}"${isMe ? ' disabled title="You cannot remove your own account"' : ''}>Remove</button>
      </td>
    </tr>`;
  }).join('');

  // role change
  body.querySelectorAll('.role-sel').forEach(sel => {
    sel.onchange = async () => {
      msg('Saving…');
      try {
        await apiSend('PATCH', '/auth/users/' + sel.dataset.uid, { role: sel.value });
        msg('Updated.', 'ok');
        renderTeam();
      } catch (e) { msg(e.message, 'err'); renderTeam(); }
    };
  });

  // restricted-field access toggle
  body.querySelectorAll('.sens-chk').forEach(chk => {
    chk.onchange = async () => {
      msg('Saving…');
      try {
        await apiSend('PATCH', '/auth/users/' + chk.dataset.uid, { canViewSensitive: chk.checked });
        msg(chk.checked ? 'Access granted.' : 'Access removed.', 'ok');
      } catch (e) { msg(e.message, 'err'); renderTeam(); }
    };
  });

  // remove
  body.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = async () => {
      const row = btn.closest('tr');
      const who = row.querySelector('td')?.textContent.trim() || 'this person';
      if (!confirm(`Remove ${who}? They lose access immediately.`)) return;
      msg('Removing…');
      try {
        await apiSend('DELETE', '/auth/users/' + btn.dataset.remove);
        msg('Removed.', 'ok');
        renderTeam();
      } catch (e) { msg(e.message, 'err'); }
    };
  });
}

$('#btn-add-user')?.addEventListener('click', async () => {
  const msg = (t, cls = '') => { const el = $('#team-msg'); el.className = 'team-msg ' + cls; el.textContent = t; };
  const name = $('#new-name').value.trim();
  const email = $('#new-email').value.trim();
  const password = $('#new-pass').value;
  const role = $('#new-role').value;
  const canViewSensitive = $('#new-sensitive').checked;
  if (!email || !password) return msg('Email and a temporary password are required.', 'err');
  if (password.length < 6) return msg('The temporary password must be at least 6 characters.', 'err');
  $('#btn-add-user').disabled = true;
  msg('Adding…');
  try {
    const r = await apiSend('POST', '/auth/register', { name, email, password, role, canViewSensitive });
    $('#new-name').value = $('#new-email').value = $('#new-pass').value = '';
    $('#new-sensitive').checked = false;
    // A visible confirmation, not just a line of text he might miss — and it says
    // plainly whether the invite actually reached them.
    const sent = r.invited?.emailed;
    alert(sent
      ? `${email} has been added and emailed their sign-in details.`
      : `${email} has been added, but the invite email could not be sent`
        + `${r.invited?.error ? ` (${r.invited.error})` : ''}.\n\n`
        + `Give them these details yourself:\n  ${email}\n  ${password}`);
    msg(sent ? `Invite emailed to ${email}.` : `${email} added — send them the password yourself.`,
        sent ? 'ok' : 'err');
    renderTeam();
  } catch (e) { msg(e.message, 'err'); }
  finally { $('#btn-add-user').disabled = false; }
});

// ---------- auth gate ----------
// Renders a full-screen login (or first-run "create owner account") over the app.
// Called on boot and whenever any API call returns 401.
let authShown = false;
function showAuth(needsSetup = false) {
  if (authShown) return;
  authShown = true;
  const wrap = document.createElement('div');
  wrap.id = 'auth-overlay';
  wrap.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">EssentiaLyfe</div>
      <div class="auth-title">${needsSetup ? 'Create your owner account' : 'Sign in'}</div>
      <div class="auth-err" id="auth-err"></div>
      ${needsSetup ? '<input id="auth-name" class="auth-input" placeholder="Your name" autocomplete="name">' : ''}
      <input id="auth-email" class="auth-input" type="email" placeholder="Email" autocomplete="username">
      <input id="auth-pass" class="auth-input" type="password" placeholder="Password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
      <button id="auth-submit" class="auth-btn">${needsSetup ? 'Create account' : 'Sign in'}</button>
      ${needsSetup ? '' : '<a class="auth-link" id="auth-forgot">Forgot password?</a>'}
    </div>`;
  document.body.appendChild(wrap);
  const err = (m) => { $('#auth-err').textContent = m || ''; };
  const forgot = $('#auth-forgot');
  if (forgot) forgot.onclick = () => { wrap.remove(); authShown = false; showForgot($('#auth-email')?.value.trim()); };
  const submit = async () => {
    err('');
    const email = $('#auth-email').value.trim();
    const password = $('#auth-pass').value;
    const name = needsSetup ? ($('#auth-name').value.trim()) : undefined;
    if (!email || !password) return err('Email and password are required.');
    $('#auth-submit').disabled = true;
    try {
      const path = needsSetup ? '/auth/register' : '/auth/login';
      const r = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, name }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Sign in failed'); }
      wrap.remove(); authShown = false;
      await startApp();
    } catch (e) { err(e.message); $('#auth-submit').disabled = false; }
  };
  $('#auth-submit').onclick = submit;
  wrap.querySelectorAll('.auth-input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
  $('#auth-email').focus();
}

// "Forgot password?" — ask for the email, then show the confirmation. If the server
// has no email sender configured yet it hands back the link directly (owner recovery
// key), so being locked out is never a dead end.
function showForgot(prefillEmail = '') {
  const wrap = document.createElement('div');
  wrap.id = 'auth-overlay';
  wrap.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">EssentiaLyfe</div>
      <div class="auth-title">Reset your password</div>
      <div class="auth-err" id="fg-err"></div>
      <div class="auth-note">Enter the email you sign in with and we'll send a reset link.</div>
      <input id="fg-email" class="auth-input" type="email" placeholder="Email" autocomplete="username" value="${prefillEmail || ''}">
      <button id="fg-submit" class="auth-btn">Send reset link</button>
      <a class="auth-link" id="fg-back">Back to sign in</a>
    </div>`;
  document.body.appendChild(wrap);
  const err = (m) => { $('#fg-err').textContent = m || ''; };
  $('#fg-back').onclick = () => { wrap.remove(); showAuth(false); };
  const submit = async () => {
    err('');
    const email = $('#fg-email').value.trim();
    if (!email) return err('Enter your email.');
    $('#fg-submit').disabled = true;
    try {
      const r = await fetch('/api/auth/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not start the reset');
      wrap.querySelector('.auth-card').innerHTML = `
        <div class="auth-brand">EssentiaLyfe</div>
        <div class="auth-title">Check your email</div>
        <div class="auth-note">${d.message || 'If that email has an account, a reset link is on its way.'}
          ${d.emailed === false ? '<br><br>If you don\'t receive it, ask your developer to send you the link — email delivery may not be switched on yet.' : ''}</div>
        <a class="auth-link" id="fg-done">Back to sign in</a>`;
      $('#fg-done').onclick = () => { wrap.remove(); showAuth(false); };
    } catch (e) { err(e.message); $('#fg-submit').disabled = false; }
  };
  $('#fg-submit').onclick = submit;
  $('#fg-email').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $('#fg-email').focus();
}

// Landing on /?reset=TOKEN — validate the token, then take a new password.
async function showResetForm(token) {
  // Claim the auth overlay so a stray 401 elsewhere can't stack a sign-in card
  // on top of the reset form mid-flow.
  authShown = true;
  const wrap = document.createElement('div');
  wrap.id = 'auth-overlay';
  document.body.appendChild(wrap);
  const card = (inner) => { wrap.innerHTML = `<div class="auth-card">${inner}</div>`; };

  card(`<div class="auth-brand">EssentiaLyfe</div><div class="auth-note">Checking your link…</div>`);
  let check = { valid: false };
  try { check = await (await fetch('/api/auth/reset/check?token=' + encodeURIComponent(token))).json(); } catch {}

  const clean = () => history.replaceState(null, '', location.pathname);
  if (!check.valid) {
    card(`
      <div class="auth-brand">EssentiaLyfe</div>
      <div class="auth-title">Link expired</div>
      <div class="auth-note">This reset link is no longer valid — they last one hour and work once. Request a new one.</div>
      <a class="auth-link" id="rs-again">Back to sign in</a>`);
    $('#rs-again').onclick = () => { clean(); wrap.remove(); authShown = false; showAuth(false); };
    return;
  }

  card(`
    <div class="auth-brand">EssentiaLyfe</div>
    <div class="auth-title">Choose a new password</div>
    <div class="auth-err" id="rs-err"></div>
    <div class="auth-note">for ${check.email}</div>
    <input id="rs-new" class="auth-input" type="password" placeholder="New password (min 6)" autocomplete="new-password">
    <input id="rs-new2" class="auth-input" type="password" placeholder="Confirm new password" autocomplete="new-password">
    <button id="rs-save" class="auth-btn">Set password and sign in</button>`);
  const err = (m) => { $('#rs-err').textContent = m || ''; };
  const save = async () => {
    err('');
    const newPassword = $('#rs-new').value, confirm = $('#rs-new2').value;
    if (newPassword.length < 6) return err('Password must be at least 6 characters.');
    if (newPassword !== confirm) return err('Passwords do not match.');
    $('#rs-save').disabled = true;
    try {
      const r = await fetch('/api/auth/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not set the password');
      clean();
      wrap.remove();
      authShown = false;
      await startApp();
    } catch (e) { err(e.message); $('#rs-save').disabled = false; }
  };
  $('#rs-save').onclick = save;
  wrap.querySelectorAll('.auth-input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
  $('#rs-new').focus();
}

async function logout() {
  hideApp(); // cover the shell before the reload so it can't flash on the way out
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.reload();
}

// ---------- account (name display, change password, sign out) ----------
function mountAccount(user) {
  if (!user) return;
  // Greet whoever is actually signed in — the markup ships a neutral "Welcome back."
  // so no name is ever baked into the page, and team members don't get greeted as
  // the owner.
  const greet = $('#dash-greeting');
  if (greet) {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const first = (user.name || '').trim().split(/\s+/)[0];
    greet.textContent = first ? `${part}, ${first}.` : `${part}.`;
  }
  const nameEl = $('#acct-name'), roleEl = $('#acct-role');
  if (nameEl) nameEl.textContent = user.name || user.email;
  if (roleEl) roleEl.textContent = user.role === 'admin' ? 'Admin' : 'Member';
  const lo = $('#acct-logout'); if (lo) lo.onclick = logout;
  const pw = $('#acct-pw'); if (pw) pw.onclick = changePasswordDialog;
}

function changePasswordDialog() {
  if ($('#pw-overlay')) return;
  const wrap = document.createElement('div');
  wrap.id = 'pw-overlay';
  wrap.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">Change password</div>
      <div class="auth-err" id="pw-err"></div>
      <input id="pw-cur" class="auth-input" type="password" placeholder="Current password" autocomplete="current-password">
      <input id="pw-new" class="auth-input" type="password" placeholder="New password (min 6)" autocomplete="new-password">
      <input id="pw-new2" class="auth-input" type="password" placeholder="Confirm new password" autocomplete="new-password">
      <button id="pw-save" class="auth-btn">Update password</button>
      <a class="auth-link" id="pw-cancel">Cancel</a>
    </div>`;
  document.body.appendChild(wrap);
  const err = (m) => { $('#pw-err').textContent = m || ''; };
  const close = () => wrap.remove();
  $('#pw-cancel').onclick = close;
  wrap.onclick = (e) => { if (e.target.id === 'pw-overlay') close(); };
  const save = async () => {
    err('');
    const currentPassword = $('#pw-cur').value, newPassword = $('#pw-new').value, confirm = $('#pw-new2').value;
    if (!currentPassword || !newPassword) return err('Fill in every field.');
    if (newPassword.length < 6) return err('New password must be at least 6 characters.');
    if (newPassword !== confirm) return err('New passwords do not match.');
    $('#pw-save').disabled = true;
    try {
      const r = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Could not update password'); }
      close();
      alert('Password updated. Other devices have been signed out.');
    } catch (e) { err(e.message); $('#pw-save').disabled = false; }
  };
  $('#pw-save').onclick = save;
  wrap.querySelectorAll('.auth-input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
  $('#pw-cur').focus();
}

// ---------- boot ----------
// Every authenticated entry point (boot, sign-in, finished reset) lands here, so
// this is the one place that reveals the shell. Until it runs, #app is hidden by
// the inline style in index.html — that's what stops the dashboard flashing behind
// the login screen while /api/auth/me is still in flight.
function revealApp() { document.documentElement.classList.add('auth-ready'); }
function hideApp() { document.documentElement.classList.remove('auth-ready'); }

async function startApp() {
  let me = null;
  try { me = await (await fetch('/api/auth/me')).json(); } catch {}
  // Don't unveil on a failed/expired check — fall back to the login screen instead.
  if (!me || !me.user) { hideApp(); return showAuth(!!me?.needsSetup); }
  state.user = me.user;
  applyTheme(currentTheme()); // sync the toggle's icon/label with the theme already applied
  // "Team & permissions" is admin-only — he asked where the permissions live, and this
  // is the answer, but only the owner/admins should see the door.
  $('#nav-team')?.classList.toggle('hidden', me.user.role !== 'admin');
  FIELD_DEFS = null; // re-fetch per session: what he may edit depends on his access
  await loadHiddenFields();   // the property card omits whatever he has switched off
  mountAccount(me.user);
  revealApp();
  await renderDashboard();
  // poll while anything is processing so Processing → Ready updates live
  if (!window._eslPoll) {
    window._eslPoll = setInterval(async () => {
      const active = document.querySelector('.nav-item.active')?.dataset.view;
      if (state.summary?.counts?.processing > 0 || active === 'processing') { await refreshSummary(); if (active === 'processing') renderProcessing(); if (active === 'database') renderDatabase(); }
    }, 2500);
  }
}

// ---------- importing his own spreadsheet ----------
// Two steps, deliberately: choose a file and see what it WOULD do, then commit. The
// preview is the whole point — 6,789 rows is not something to accept on faith.
let importToken = null;

function impMsg(text, cls = '') {
  const el = $('#imp-msg');
  if (el) { el.className = 'digest-msg ' + cls; el.textContent = text; }
}

$('#imp-drop')?.addEventListener('click', () => $('#imp-file')?.click());
$('#imp-drop')?.addEventListener('dragover', e => { e.preventDefault(); $('#imp-drop').classList.add('over'); });
$('#imp-drop')?.addEventListener('dragleave', () => $('#imp-drop').classList.remove('over'));
$('#imp-drop')?.addEventListener('drop', e => {
  e.preventDefault();
  $('#imp-drop').classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) previewImport(f);
});
$('#imp-file')?.addEventListener('change', e => {
  const f = e.target.files?.[0];
  if (f) previewImport(f);
});

async function previewImport(file) {
  const panel = $('#imp-preview');
  panel?.classList.add('hidden');
  impMsg(`Reading ${file.name}…`);
  try {
    const r = await fetch('/api/import/preview?filename=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not read that file');
    importToken = d.token;
    renderImportPreview(d);
    impMsg('');
  } catch (e) {
    impMsg(e.message, 'err');
  }
}

function renderImportPreview(d) {
  const s = d.summary;
  const panel = $('#imp-preview');
  if (!panel) return;

  const mapRows = d.mapped.map(m =>
    `<tr><td class="src">${esc(m.source)}</td><td class="arr">→</td><td class="dst">${esc(m.label)}</td>
     <td class="src">${s.fill[m.key] ? s.fill[m.key].toLocaleString() + ' filled' : '<span class="skip">empty</span>'}</td></tr>`).join('');

  const skipped = d.unmapped.length
    ? `<div style="margin-top:12px;font-size:12.5px" class="muted">Not brought in: ${d.unmapped.map(esc).join(', ')}</div>` : '';

  const dupes = d.duplicates?.length
    ? `<div style="margin-top:10px;font-size:12.5px" class="muted">Two columns meant the same thing: ${
        d.duplicates.map(x => `kept <b>${esc(x.kept)}</b>, ignored <b>${esc(x.source)}</b>`).join('; ')}</div>` : '';

  const warn = s.warnings?.length
    ? `<details style="margin-top:12px"><summary class="muted" style="font-size:12.5px;cursor:pointer">${s.warnings.length} note${s.warnings.length === 1 ? '' : 's'} about individual cells</summary>
       <div class="muted" style="font-size:12px;margin-top:6px;line-height:1.7">${s.warnings.map(esc).join('<br>')}</div></details>` : '';

  const hosts = s.photoHosts?.length
    ? `<div style="margin-top:10px;font-size:12.5px" class="muted">Photo folders: ${
        s.photoHosts.map(([h, n]) => `${esc(h)} (${n.toLocaleString()})`).join(', ')}</div>` : '';

  // Two rows naming one address. Worth showing rather than quietly merging: some are
  // genuine repeats, some are two units at the same address that he may want to split.
  const collided = d.collided?.length
    ? `<details style="margin-top:12px"><summary class="muted" style="font-size:12.5px;cursor:pointer">
         ${d.collided.length} address${d.collided.length === 1 ? '' : 'es'} appear more than once in your sheet — the app keeps one row per address
       </summary>
       <div class="muted" style="font-size:12px;margin-top:6px;line-height:1.8">${
         d.collided.slice(0, 60).map(c =>
           `${esc(c.address)} — kept <b>${esc(c.kept)}</b>, merged <b>${esc(c.dropped)}</b>`).join('<br>')}</div></details>` : '';

  panel.innerHTML = `
    <div class="imp-stat">
      <div><b>${s.importable.toLocaleString()}</b><span>Properties</span></div>
      <div><b>${d.mapped.length}</b><span>Columns understood</span></div>
      <div><b>${s.links.toLocaleString()}</b><span>Links kept</span></div>
      ${s.skippedNoAddress ? `<div><b>${s.skippedNoAddress.toLocaleString()}</b><span>Skipped, no address</span></div>` : ''}
    </div>
    <div class="imp-map"><table><tbody>${mapRows}</tbody></table></div>
    ${skipped}${dupes}${hosts}${collided}${warn}
    <div class="imp-acts">
      <button class="btn-primary" id="imp-go">Import ${s.importable.toLocaleString()} properties</button>
      <button class="btn-ghost" id="imp-cancel">Cancel</button>
      <span class="fld-status" id="imp-progress"></span>
    </div>
    <div class="muted" style="font-size:12px;margin-top:10px">
      Properties you already have are matched on address and updated — an empty cell in your
      sheet never wipes something already in the app. These arrive as your existing inventory,
      not in the review queue.
    </div>`;
  panel.classList.remove('hidden');

  $('#imp-cancel').addEventListener('click', () => {
    panel.classList.add('hidden');
    importToken = null;
    $('#imp-file').value = '';
  });

  $('#imp-go').addEventListener('click', async () => {
    const btn = $('#imp-go');
    btn.disabled = true;
    $('#imp-progress').textContent = 'Importing… this takes a minute for a file this size.';
    try {
      const r = await apiSend('POST', '/import/commit', { token: importToken });
      $('#imp-progress').className = 'fld-status ok';
      // Say what happened to the photos too — an import that silently left them as
      // stand-ins looked like the feature had simply not worked.
      // Name both sources: his own Drive folders come first and are his photographs,
      // the listing lookup fills whatever is left. Seeing the split tells him at a
      // glance whether his folders are readable by the app.
      const p = r.photos;
      const photoNote = p
        ? ` · photos for ${p.updated} of ${p.checked}`
          + (p.fromDrive || p.fromListing
              ? ` (${[p.fromDrive ? `${p.fromDrive} from your Drive` : null,
                      p.fromListing ? `${p.fromListing} from the listing` : null]
                    .filter(Boolean).join(', ')})` : '')
          + (p.folderDenied ? ` · ${p.folderDenied} folder${p.folderDenied === 1 ? '' : 's'} not shared with this app` : '')
          + (p.noneAvailable > (p.folderDenied || 0)
              ? ` · ${p.noneAvailable - (p.folderDenied || 0)} had none` : '')
          + (p.remaining ? ` · ${p.remaining.toLocaleString()} still to fetch below` : '')
        : '';
      $('#imp-progress').textContent =
        `${r.inserted.toLocaleString()} added, ${r.updated.toLocaleString()} updated` +
        (r.failed ? `, ${r.failed} could not be read` : '') + photoNote;

      // Say WHICH ones failed and why. The reasons were already being collected and
      // then dropped into the console, so a partial import looked like an unexplained
      // "7 could not be read" with no way to act on it.
      const box = $('#imp-errors');
      if (box) {
        if (r.errors?.length) {
          box.classList.remove('hidden');
          box.innerHTML = `<div class="imp-err-t">${r.failed} could not be read</div>`
            + r.errors.map(e => `<div class="imp-err-row">${esc(e)}</div>`).join('')
            + (r.failed > r.errors.length
                ? `<div class="imp-err-row muted">…and ${r.failed - r.errors.length} more</div>` : '');
        } else {
          box.classList.add('hidden');
          box.innerHTML = '';
        }
      }
      importToken = null;
      $('#imp-file').value = '';
      await refreshSummary();
      if (r.errors?.length) console.warn('import errors:', r.errors);
    } catch (e) {
      $('#imp-progress').className = 'fld-status err';
      $('#imp-progress').textContent = e.message;
      btn.disabled = false;
    }
  });
}

(async () => {
  try {
    // A reset link wins over everything else — he arrives here signed out.
    const resetToken = new URLSearchParams(location.search).get('reset');
    if (resetToken) return showResetForm(resetToken);

    const me = await (await fetch('/api/auth/me')).json();
    if (me.needsSetup) return showAuth(true);   // first run → create owner
    if (!me.user) return showAuth(false);        // not logged in → sign in
    await startApp();                            // logged in → run the app
  } catch (e) { console.error(e); showAuth(false); }
})();
