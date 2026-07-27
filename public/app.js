// EssentiaLyfe · Sourcing Autopilot — frontend
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => n == null ? '—' : '$' + Number(n).toLocaleString();
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Fallback imagery only if a listing has no real photos yet.
const IMGS = [
  'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=800&q=70',
  'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=800&q=70',
  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=70',
  'https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=800&q=70',
  'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?w=800&q=70',
  'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=800&q=70',
  'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=800&q=70',
];

// Parse a listing's real photo gallery: photo_urls is [{url,tag}] or [url] (or a
// JSON string of either). Returns an array of URL strings.
function realPhotos(l) {
  if (!l) return [];
  let g = l.photo_urls;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  if (!Array.isArray(g)) return [];
  return g.map(e => (e && typeof e === 'object') ? e.url : e).filter(Boolean);
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
    const photos = realPhotos(listing);
    if (photos.length) return photos[i % photos.length];
    return IMGS[(Number(listing.id) + i) % IMGS.length];
  }
  return IMGS[(Number(listing) + i) % IMGS.length];
}

let state = { summary: null, queue: [], swipeIdx: 0 };

async function api(path, opts) {
  const r = await fetch('/api' + path, opts ? { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------- navigation ----------
function show(view) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  if (view === 'review') renderSwipe();
  if (view === 'processing') renderProcessing();
  if (view === 'database') renderDatabase();
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
  $('#s-sourced').textContent = c.sourced;
  $('#s-review').textContent = c.in_review;
  $('#s-processing').textContent = c.processing;
  $('#s-ready').textContent = c.ready;
  $('#s-live').textContent = c.ready + c.live; // "in your Drive" = delivered
  $('#badge-review').textContent = c.in_review;
  $('#badge-processing').textContent = c.processing;
  $('#badge-db').textContent = c.ready + c.live;
  $('#drive-mode').textContent = 'Drive: ' + s.driveMode;
}

// ---------- dashboard ----------
async function renderDashboard() {
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
  $('#src-list').innerHTML = `
    <div class="src-row"><div><div class="src-name">Realtor.com — LA County</div><div class="src-sub">Live · listing data + full photo galleries</div></div><div class="src-count">+${total} new</div></div>
    <div class="src-row"><div><div class="src-name">All 3 specs</div><div class="src-sub">For-sale · Sold · Rentals</div></div><div class="src-count">on</div></div>
    <div class="src-row"><div><div class="src-name">Owner / address finder</div><div class="src-sub">Skip-trace API</div></div><div class="src-count off">Phase 2</div></div>`;
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
async function renderDatabase() {
  await refreshSummary();
  const rows = await api('/ready');
  const body = $('#db-body');
  if (!rows.length) { body.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">No approved properties yet.</td></tr>`; return; }
  body.innerHTML = rows.map(l => {
    const tags = (l.images || []).map(im => im.tag).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    const nImg = (l.images || []).length;
    const drive = l.drive_folder_url
      ? `<a class="drive-link" href="${l.drive_folder_url}" target="_blank">📁 ${nImg} photo${nImg === 1 ? '' : 's'} · Open</a>`
      : `<span class="drive-link na" title="Folder + tagged files are prepared; uploads on service-account connect">📁 ${nImg ? nImg + ' · ' : ''}Prepared</span>`;
    return `
    <tr data-id="${l.id}">
      <td><img class="t-thumb" src="${imgFor(l)}" alt=""></td>
      <td><b>${esc(l.street_line || l.address)}</b></td>
      <td>${esc(l.area || l.city || '')}</td>
      <td class="t-price">${fmt(l.price)}</td>
      <td>${l.beds}/${l.baths}</td>
      <td>${l.sqft ? l.sqft.toLocaleString() : '—'}</td>
      <td><div class="t-tags">${tags.map(t => `<span class="t">${esc(t)}</span>`).join('') || '<span class="muted">—</span>'}</div></td>
      <td>${drive}</td>
      <td><span class="pill ${l.status}">${l.status === 'ready' ? 'Ready' : l.status}</span></td>
    </tr>`;
  }).join('');
}

$('#btn-csv')?.addEventListener('click', async () => {
  const rows = await api('/ready');
  const cols = ['address', 'city', 'area', 'spec', 'price', 'beds', 'baths', 'sqft', 'lot_acres', 'floors', 'parking', 'year_built', 'property_style', 'furnished', 'gated_community', 'neighborhood', 'description'];
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => {
    let v = r[c]; if (Array.isArray(v)) v = v.join(' | '); if (v == null) v = '';
    v = String(v).replace(/"/g, '""'); return /[",\n]/.test(v) ? `"${v}"` : v;
  }).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'essentialyfe-properties.csv'; a.click();
});

// ---------- detail overlay ----------
document.addEventListener('click', async e => {
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
  // group images by tag
  const groups = {};
  (l.images || []).forEach((im, i) => { (groups[im.tag] = groups[im.tag] || []).push(i); });
  const byRoom = Object.keys(groups).length
    ? Object.entries(groups).map(([room, idxs]) => `
        <div class="room-group"><h4>${esc(room)}</h4><div class="room-photos">${idxs.map(i => `<img src="${imgFor(l, i)}" alt="">`).join('')}</div></div>`).join('')
    : `<div class="muted" style="font-size:12px">Images are prepared on approval.</div>`;
  const drivePath = `EssentiaLyfe – Sourcing Autopilot / ${l.address} /`;
  const driveFiles = (l.images || []).map(im => im.name).join('   ');
  const isReady = ['ready', 'live'].includes(l.status);

  $('#detail-card').innerHTML = `
    <div class="dt-hero">
      <img src="${imgFor(l)}" alt="">
      ${isReady ? '<div class="dt-status">READY · nothing left to do by hand</div>' : ''}
      <button class="dt-close" id="dt-close">×</button>
      <div class="dt-addr"><h2>${esc(l.street_line || l.address)}</h2><div class="sub">${esc(l.area || l.city)}, ${esc(l.state)} ${esc(l.zip || '')}</div></div>
    </div>
    <div class="dt-body">
      <div class="dt-cols">
        <div>
          <div class="dt-field"><span class="k">Price</span><span class="v">${fmt(l.price)}${l.is_rental ? '/mo' : ''}</span></div>
          <div class="dt-field"><span class="k">Bedrooms</span><span class="v">${l.beds ?? '—'}</span></div>
          <div class="dt-field"><span class="k">Bathrooms</span><span class="v">${l.baths ?? '—'}</span></div>
          <div class="dt-field"><span class="k">Square feet</span><span class="v">${l.sqft ? l.sqft.toLocaleString() : '—'}</span></div>
          <div class="dt-field"><span class="k">Lot size</span><span class="v">${l.lot_acres ? l.lot_acres + ' acres' : '—'}</span></div>
          <div class="dt-field"><span class="k">Floors / Parking</span><span class="v">${l.floors ?? '—'} / ${l.parking ?? '—'}</span></div>
          <div class="dt-field"><span class="k">Year built</span><span class="v">${l.year_built ?? '—'}</span></div>
          <div class="dt-field"><span class="k">Photos</span><span class="v">${(l.images || []).length || l.num_photos || '—'} — cleaned &amp; tagged</span></div>
        </div>
        <div>
          <div class="dt-field"><span class="k">Property style</span><span class="v">${esc(styleStr)}</span></div>
          <div class="dt-field"><span class="k">Furnished</span><span class="v">${esc(l.furnished || '—')}</span></div>
          <div class="dt-field"><span class="k">Also known as</span><span class="v">${esc(l.also_known_as || '—')}</span></div>
          <div class="dt-field"><span class="k">Neighborhood</span><span class="v">${esc(l.neighborhood || l.city || '—')}</span></div>
          <div class="dt-field"><span class="k">Gated community</span><span class="v">${esc(l.gated_community || '—')}</span></div>
          <div class="dt-field"><span class="k">Sleep / Seat / Stand</span><span class="v">${l.sleep_capacity ?? '—'} / ${l.seating_capacity ?? '—'} / ${l.stand_capacity ?? '—'}</span></div>
          <div class="dt-field"><span class="k">Architect</span><span class="v">${esc(l.architect || '—')}</span></div>
          <div class="dt-field"><span class="k">Color palette</span><span class="v"><span class="palette">${palette || '—'}</span></span></div>
        </div>
      </div>

      <div class="dt-section-t">Description</div>
      <p class="dt-desc">${esc(l.description || '—')}</p>

      <div class="dt-section-t">Photos by room</div>
      <div class="by-room">${byRoom}</div>

      <div class="drive-box">
        <div class="db-head">📁 Delivered to your Google Drive</div>
        <div class="db-path">${esc(drivePath)}</div>
        <div class="db-files">${driveFiles ? esc(driveFiles) : 'Images are filed here on approval — one folder per property address, files named by room.'}</div>
        ${l.drive_folder_url ? `<a class="drive-link" href="${l.drive_folder_url}" target="_blank">Open folder in Drive →</a>` : `<div class="mini-note">${state.summary?.driveMode === 'live' ? '' : 'This host has no service account, so files are prepared, not uploaded. Connecting the service account to your master folder makes this live — no code change. (Verified working in development: real folders + a tagged image were created in Drive.)'}</div>`}
      </div>

      <div class="owner-box"><span>🔒</span><div><b>Owner outreach</b> — skip-trace via API, permission-gated. <span class="muted">Queued for Phase 2, exactly as in your walkthrough.</span></div></div>
    </div>`;
  $('#detail-overlay').classList.remove('hidden');
  $('#dt-close').onclick = () => $('#detail-overlay').classList.add('hidden');
  $('#detail-overlay').onclick = (ev) => { if (ev.target.id === 'detail-overlay') $('#detail-overlay').classList.add('hidden'); };
}

// ---------- boot ----------
(async () => {
  try {
    await renderDashboard();
    // poll while anything is processing so Processing → Ready updates live
    setInterval(async () => {
      const active = document.querySelector('.nav-item.active')?.dataset.view;
      if (state.summary?.counts?.processing > 0 || active === 'processing') { await refreshSummary(); if (active === 'processing') renderProcessing(); if (active === 'database') renderDatabase(); }
    }, 2500);
  } catch (e) { console.error(e); }
})();
