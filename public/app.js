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
  if (view === 'team') return renderTeam();
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
  const body = $('#db-body');
  if (!body.children.length) body.innerHTML = `<tr><td colspan="10" class="muted" style="padding:18px">Loading…</td></tr>`;
  await refreshSummary();
  const rows = await api('/ready');
  if (!rows.length) { body.innerHTML = `<tr><td colspan="10" class="muted" style="text-align:center;padding:30px">No approved properties yet.</td></tr>`; return; }
  body.innerHTML = rows.map(l => {
    const nImg = (l.images || []).length;
    // His own fields, surfaced in the table so the manual data is visible at a glance.
    const tier = l.tier ? `<span class="t">${esc(l.tier)}</span>` : '<span class="muted">—</span>';
    const rate = l.rate1_monthly ? fmt(l.rate1_monthly) + '/mo'
      : l.rate1_nightly ? fmt(l.rate1_nightly) + '/night'
      : l.rate1_event ? fmt(l.rate1_event) + '/event'
      : l.rate1_film ? fmt(l.rate1_film) + '/film'
      : '<span class="muted">—</span>';
    const drive = l.drive_folder_url
      ? `<a class="drive-link" href="${l.drive_folder_url}" target="_blank">📁 ${nImg} photo${nImg === 1 ? '' : 's'} · Open</a>`
      : `<span class="drive-link na" title="Folder + tagged files are prepared; uploads on service-account connect">📁 ${nImg ? nImg + ' · ' : ''}Prepared</span>`;
    return `
    <tr data-id="${l.id}">
      <td><img class="t-thumb" src="${imgFor(l)}" alt=""></td>
      <td><b>${esc(l.street_line || l.address)}</b></td>
      <td>${esc(l.area || l.city || '')}</td>
      <td class="t-price">${fmt(l.price)}</td>
      <td><div class="t-tags">${tier}</div></td>
      <td>${rate}</td>
      <td>${l.beds}/${l.baths}</td>
      <td>${l.sqft ? l.sqft.toLocaleString() : '—'}</td>
      <td>${drive}</td>
      <td><span class="pill ${l.status}">${l.status === 'ready' ? 'Ready' : l.status}</span></td>
    </tr>`;
  }).join('');
}

$('#btn-csv')?.addEventListener('click', async () => {
  const rows = await api('/ready');
  // Feed/AI columns first, then his own fields — restricted ones only if he may see
  // them (the API already omits those values otherwise, so this keeps headers honest).
  const defs = await loadFieldDefs();
  const cols = ['address', 'city', 'area', 'spec', 'price', 'beds', 'baths', 'sqft', 'lot_acres', 'floors', 'parking', 'year_built', 'property_style', 'furnished', 'gated_community', 'neighborhood', 'description']
    .concat(defs.fields.map(f => f.key));
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

      <div class="dt-section-t">Your fields <span class="muted" style="font-weight:400;font-size:12px">— editable, saved to this property</span></div>
      <div id="dt-editable"></div>

      <div class="owner-box"><span>🔒</span><div><b>Owner outreach</b> — skip-trace via API, permission-gated. <span class="muted">Queued for Phase 2, exactly as in your walkthrough.</span></div></div>
    </div>`;
  $('#detail-overlay').classList.remove('hidden');
  $('#dt-close').onclick = () => $('#detail-overlay').classList.add('hidden');
  $('#detail-overlay').onclick = (ev) => { if (ev.target.id === 'detail-overlay') $('#detail-overlay').classList.add('hidden'); };
  mountEditableFields(l);
}

// ---------- his own fields: the editable half of a property ----------
// Everything above in the detail card comes from the listing feed and the AI and is
// read-only. This section is his: rates, tier, contacts, access notes — the values no
// feed can supply. The form is generated from /api/fields, so adding a field server-side
// makes it appear here with no frontend change.
let FIELD_DEFS = null;

async function loadFieldDefs() {
  if (FIELD_DEFS) return FIELD_DEFS;
  try { FIELD_DEFS = await api('/fields'); } catch { FIELD_DEFS = { fields: [], groups: [], canViewSensitive: false }; }
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
      if (document.querySelector('.nav-item.active')?.dataset.view === 'database') renderDatabase();
    } catch (e) {
      status(e.message, 'err');
    } finally {
      $('#fld-save').disabled = false;
    }
  };
}

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
    await apiSend('POST', '/auth/register', { name, email, password, role, canViewSensitive });
    $('#new-name').value = $('#new-email').value = $('#new-pass').value = '';
    $('#new-sensitive').checked = false;
    msg(`${email} can now sign in with that temporary password — they can change it under their name in the sidebar.`, 'ok');
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
  // "Team & permissions" is admin-only — he asked where the permissions live, and this
  // is the answer, but only the owner/admins should see the door.
  $('#nav-team')?.classList.toggle('hidden', me.user.role !== 'admin');
  FIELD_DEFS = null; // re-fetch per session: what he may edit depends on his access
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
