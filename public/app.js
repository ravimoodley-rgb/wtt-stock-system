'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtNum = n => new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 1 }).format(Number(n || 0));
const fmtQty = (n, unit) => `${fmtNum(n)} ${unit || ''}`.trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const dtNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

const state = { me: null, token: localStorage.getItem('wtt_token') || null, section: 'dashboard' };
const APP_VERSION = 'v12';
// ---------------------------------------------------------------- http
async function api(url, method = 'GET', body) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error('Cannot reach the server. Run start.bat and open http://localhost:3001 (do not open index.html directly).');
  }
  if (res.status === 401) {
    state.token = null;
    localStorage.removeItem('wtt_token');
    $('#login-screen').hidden = false;
    $('#app').hidden = true;
    throw new Error('Session expired - please sign in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------------------------------------------------------------- toast / modal
let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function openModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-overlay').hidden = false;
}
function closeModal() { $('#modal-overlay').hidden = true; }

function confirmAction(msg) { return window.confirm(msg); }

// ---------------------------------------------------------------- auth
async function doLogin(e) {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const data = await api('/login', 'POST', {
      username: $('#login-username').value.trim(),
      password: $('#login-password').value
    });
    state.token = data.token;
    localStorage.setItem('wtt_token', data.token);
    state.me = data.user;
    boot();
  } catch (errObj) {
    console.error('Login error object:', errObj);
    err.textContent = errObj?.message || 'Login failed. Please check your username and password.';
    err.hidden = false;
  }
}

function logout(reload = true) {
  state.token = null;
  localStorage.removeItem('wtt_token');
  if (reload) location.reload();
}

// ---------------------------------------------------------------- boot
let productsCache = [], tanksCache = [], suppliersCache = [], customersCache = [], transportersCache = [], driversCache = [], vehiclesCache = [];
async function loadReference() {
  [productsCache, tanksCache, suppliersCache, customersCache, transportersCache, driversCache, vehiclesCache] = await Promise.all([
    api('/products'), api('/tanks'), api('/suppliers'), api('/customers'), api('/transporters'), api('/drivers'), api('/vehicles')
  ]);
}

function canWrite() { return state.me.role !== 'Clerk'; }
function isAdmin() { return state.me.role === 'Administrator'; }

// ---------------------------------------------------------------- navigation
function bindNav() {
  $$('#nav .nav-item').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.reportTab) state.reportTab = b.dataset.reportTab;
    go(b.dataset.section);
  }));
  $$('.nav-drop-toggle').forEach(t => t.addEventListener('click', () => t.nextElementSibling.classList.toggle('open')));
  $('#btn-logout').addEventListener('click', () => logout());
  $('#btn-change-pw').addEventListener('click', showChangePassword);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
}

const titles = {
  dashboard: 'Dashboard', stock: 'Tanks & Stock', receipts: 'Stock Received',
  dispatches: 'Stock Dispatch', transfers: 'Transfers', adjustments: 'Dips & Adjustments',
  reports: 'Reports', customers: 'Customers', suppliers: 'Suppliers',
  products: 'Products', transporters: 'Transporters', drivers: 'Drivers', vehicles: 'Vehicles',
  users: 'Users', whatsapp: 'WhatsApp Alerts', audit: 'Audit Log'
};

async function go(section) {
  state.section = section;
  $$('#nav .nav-item').forEach(b => {
    const match = b.dataset.section === section &&
      (!b.dataset.reportTab || b.dataset.reportTab === state.reportTab);
    b.classList.toggle('active', match);
    const drop = b.closest('.nav-drop');
    if (match && drop) drop.classList.add('open');
  });
  $('#section-title').textContent = titles[section] || 'Dashboard';
  const content = $('#content');
  content.innerHTML = '<div class="muted">Loading…</div>';
  try {
    await loadReference();
    switch (section) {
      case 'dashboard': return await renderDashboard(content);
      case 'stock': return await renderStock(content);
      case 'receipts': return await renderReceipts(content);
      case 'dispatches': return await renderDispatches(content);
      case 'transfers': return await renderTransfers(content);
      case 'adjustments': return await renderAdjustments(content);
      case 'reports': return await renderReports(content);
      case 'customers': return await renderCustomers(content);
      case 'suppliers': return await renderSuppliers(content);
      case 'products': return await renderProducts(content);
      case 'transporters': return await renderTransporters(content);
      case 'drivers': return await renderDrivers(content);
      case 'vehicles': return await renderVehicles(content);
      case 'users': return await renderUsers(content);
      case 'whatsapp': return await renderWhatsApp(content);
      case 'audit': return await renderAudit(content);
    }
  } catch (err) {
    content.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- shared form helpers
function productOptions(sel) {
  return productsCache.map(p => `<option value="${p.id}" ${String(p.id) === String(sel) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
function tankOptions(sel, filterProduct) {
  return tanksCache
    .filter(t => !filterProduct || String(t.product_id) === String(filterProduct))
    .map(t => `<option value="${t.id}" ${String(t.id) === String(sel) ? 'selected' : ''}>${esc(t.code)} — ${esc(t.product || 'no product')} (${fmtNum(t.current_qty)})</option>`)
    .join('');
}
function supplierOptions(sel) {
  return `<option value="">— Select supplier —</option>` + suppliersCache.map(s => `<option value="${s.id}" ${String(s.id) === String(sel) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}
function customerOptions(sel) {
  return `<option value="">— Select customer —</option>` + customersCache.map(c => `<option value="${c.id}" ${String(c.id) === String(sel) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}
function transporterOptions(sel) {
  return `<option value="">— Select transporter —</option>` + transportersCache.map(t => `<option value="${t.id}" ${String(t.id) === String(sel) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}
function vehicleOptions(sel) {
  return `<option value="">— Select vehicle —</option>` + vehiclesCache.map(v => `<option value="${v.reg}" ${String(v.reg) === String(sel) ? 'selected' : ''}>${esc(v.reg)}${v.vehicle_type ? ' — ' + esc(v.vehicle_type) : ''}</option>`).join('');
}
function vehicleInfo(reg) {
  return vehiclesCache.find(v => String(v.reg) === String(reg));
}
function productSelect(filter) {
  return `<select id="f-product">${productOptions()}</select>`;
}

function bindTankProductFilter(tankSel, productSel) {
  const tankEl = typeof tankSel === 'string' ? $(tankSel) : tankSel;
  const productEl = typeof productSel === 'string' ? $(productSel) : productSel;
  if (!tankEl || !productEl) return;
  productEl.addEventListener('change', () => {
    const p = productEl.value;
    tankEl.innerHTML = tankOptions('', p);
  });
}

function setVal(sel, val) { if ($(sel)) $(sel).value = val ?? ''; }

// ---------------------------------------------------------------- dashboard
async function renderDashboard(content) {
  const d = await api('/dashboard');
  const t = d.totals;
  const rec = d.received || { docs: 0, litres: 0, today_litres: 0 };
  const dis = d.dispatched || { docs: 0, litres: 0, today_litres: 0 };

  const tankChartHtml = d.tankVolumes.length ? d.tankVolumes.map(t => {
    const available = t.capacity != null ? Math.max(0, t.capacity - t.current_qty) : null;
    return `
    <div class="tank-bar-col">
      <div class="tank-bar-track">
        <div class="tank-bar-fill ${t.level}" style="height:${Math.max(2, t.fill_pct)}%" title="${esc(t.name)} — ${fmtQty(t.current_qty, 'L')} of ${t.capacity ? fmtNum(t.capacity) + ' L' : '—'} (${t.fill_pct}%)"></div>
      </div>
      <div class="tank-bar-label">${esc(t.code)}</div>
      <div class="tank-bar-qty">Available: ${fmtNum(t.current_qty)}</div>
      <div class="tank-bar-cap">Ullage: ${available != null ? fmtNum(available) : '—'}</div>
    </div>`;
  }).join('') : '<div class="muted">No tanks yet.</div>';

  const recRows = d.recent.filter(r => r.type === 'receipt');
  const receivedHtml = recRows.length ? recRows.map(r => {
    const when = new Date(r.ts + (r.ts.length === 10 ? 'T00:00' : '')).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="recent-line">
      <b>${esc(r.doc || '—')}</b>
      <span>${fmtQty(r.qty, r.unit)}</span>
      <span class="muted">${when}</span>
    </div>`;
  }).join('') : '<div class="muted">No receipts yet.</div>';

  const disRows = d.recent.filter(r => r.type === 'dispatch');
  const dispatchedHtml = disRows.length ? disRows.map(r => {
    const when = new Date(r.ts + (r.ts.length === 10 ? 'T00:00' : '')).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="recent-line">
      <b>${esc(r.doc || '—')}</b>
      <span>${fmtQty(r.qty, r.unit)}</span>
      <span class="muted">${when}</span>
    </div>`;
  }).join('') : '<div class="muted">No dispatches yet.</div>';

  content.innerHTML = `
    <div class="grid cards">
      <div class="stat-card tint-pink"><div class="stat-label">Storage tanks</div><div class="stat-value">${t.tank_count}</div><div class="stat-sub stat-active">(Active)</div></div>
      <div class="stat-card tint-blue"><div class="stat-label">Product in storage</div><div class="stat-value">${fmtNum(t.total_qty)} L</div><div class="stat-sub">(All active tanks)</div></div>
      <div class="stat-card tint-amber"><div class="stat-label">Movements today</div><div class="stat-value">${d.movementsToday}</div><div class="stat-sub">(Received + Dispatch)</div></div>
      <div class="stat-card tint-green"><div class="stat-label">Net stock movement</div><div class="stat-value">${fmtNum(rec.today_litres - dis.today_litres)} L</div><div class="stat-sub">(Overall)</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="content-head">
        <div class="card-title" style="margin:0">Tank Volume Levels</div>
      </div>
      <div class="tank-chart">${tankChartHtml}</div>
    </div>
    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <div class="card-title">Stock Received Alerts</div>
        <div class="recent-list">${receivedHtml}</div>
      </div>
      <div class="card">
        <div class="card-title">Stock Dispatch Alerts</div>
        <div class="recent-list">${dispatchedHtml}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- stock / tanks
async function renderStock(content) {
  const tanks = await api('/tanks');
  const rows = tanks.map(t => {
    const pct = t.capacity ? Math.round((t.current_qty / t.capacity) * 100) : 0;
    const cls = t.current_qty < (t.min_level || 0) ? 'crit' : (t.max_level != null && t.current_qty > t.max_level ? 'warn' : '');
    const statusTag = t.status === 'active' ? `<span class="tag tag-ok">Active</span>`
      : `<span class="tag tag-maintenance">${esc(t.status)}</span>`;
    return `<tr>
      <td><b>${esc(t.code)}</b></td>
      <td>${esc(t.name || '')}</td>
      <td>${esc(t.product || '<span class="muted">none</span>')}</td>
      <td class="text-right"><b class="num">${fmtQty(t.current_qty, t.product_unit || 'L')}</b></td>
      <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div><span>${pct}%</span></div></td>
      <td class="text-right">${t.capacity ? fmtNum(t.capacity) : '—'}</td>
      <td class="text-right">${t.min_level != null ? fmtNum(t.min_level) : '—'} / ${t.max_level != null ? fmtNum(t.max_level) : '—'}</td>
      <td>${statusTag}</td>
      <td>${canWrite() ? `
        <div class="flex" style="flex-wrap:nowrap">
          <button class="btn btn-sm btn-outline" onclick="dipModal(${t.id})">Dip</button>
          <button class="btn btn-sm btn-outline" onclick="tankModal(${t.id})">Edit</button>
          ${isAdmin() ? `<button class="btn btn-sm btn-danger" onclick="deleteTank(${t.id})">Del</button>` : ''}
        </div>` : ''}</td>
    </tr>`;
  }).join('');

  content.innerHTML = `
    <div class="content-head">
      <div class="muted">Live tank inventory — levels update automatically with every transaction.</div>
      ${canWrite() ? `<button class="btn btn-transport" onclick="tankModal()">+ Add tank</button>` : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr>
        <th>Code</th><th>Name</th><th>Product</th><th>Current stock</th><th>Fill</th>
        <th>Capacity</th><th>Min / Max</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows || '<tr class="empty-row"><td colspan="9">No tanks yet.</td></tr>'}</tbody>
    </table></div>`;
}

function tankModal(id) {
  const t = tanksCache.find(x => x.id === id) || {};
  openModal(id ? `Edit tank ${t.code}` : 'Add tank', `
    <form class="form-grid" id="tank-form">
      <label>Code <input name="code" value="${esc(t.code || '')}" placeholder="T-101" required></label>
      <label>Name <input name="name" value="${esc(t.name || '')}" placeholder="Diesel Tank 1"></label>
      <label>Product
        <select name="product_id">${productOptions(t.product_id)}</select>
      </label>
      <label>Status
        <select name="status">
          ${['active','inactive','maintenance','offline'].map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label>
      <label>Capacity (litres) <input name="capacity" type="number" step="any" min="0" value="${t.capacity ?? ''}"></label>
      <label>Opening stock (litres) <input name="current_qty" type="number" step="any" min="0" value="${t.current_qty ?? ''}" ${id ? 'disabled' : ''}><span class="hint">Only set when creating a tank.</span></label>
      <label>Min level <input name="min_level" type="number" step="any" min="0" value="${t.min_level ?? ''}"></label>
      <label>Max level <input name="max_level" type="number" step="any" min="0" value="${t.max_level ?? ''}"></label>
      <label class="full">Notes <textarea name="notes">${esc(t.notes || '')}</textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save tank</button>
      </div>
    </form>`);
  $('#tank-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    if (body.capacity) body.capacity = Number(body.capacity);
    body.min_level = body.min_level === '' ? 0 : Number(body.min_level);
    body.max_level = body.max_level === '' ? null : Number(body.max_level);
    body.current_qty = body.current_qty === '' ? 0 : Number(body.current_qty);
    if (id) { await api('/tanks/' + id, 'PUT', body); toast('Tank updated'); }
    else { await api('/tanks', 'POST', body); toast('Tank added'); }
    closeModal(); await loadReference(); go('stock');
  });
}

async function deleteTank(id) {
  const t = tanksCache.find(x => x.id === id);
  if (!confirmAction(`Delete tank ${t.code}?`)) return;
  try { await api('/tanks/' + id, 'DELETE'); toast('Tank deleted'); await loadReference(); go('stock'); }
  catch (err) { toast(err.message, 'error'); }
}

function dipModal(tankId) {
  const t = tanksCache.find(x => x.id === tankId);
  if (!t) return;
  openModal(`Record dip reading — ${t.code}`, `
    <form class="form-grid" id="dip-form">
      <label class="full">Tank <input value="${esc(t.code)} — ${esc(t.product || '')}" disabled></label>
      <label class="full">Dipped stock level (litres) <input name="qty" type="number" step="any" min="0" required><span class="hint">Actual level read from the dip tape. The system adjusts tank stock to this figure.</span></label>
      <label>Date <input name="adjusted_date" type="date" value="${dtNow().slice(0, 10)}"></label>
      <label>Time <input name="adjusted_time" type="time" value="${dtNow().slice(11)}"></label>
      <label>Dip before <input name="dip_before" type="number" step="any" min="0" value="${t.current_qty}"></label>
      <label>Dip after <input name="dip_after" type="number" step="any" min="0"></label>
      <label class="full">Notes <textarea name="notes"></textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Record dip</button>
      </div>
    </form>`);
  $('#dip-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { tank_id: tankId, adj_type: 'dip_reading', unit: 'litres' };
    for (const [k, v] of f.entries()) {
      if (k === 'adjusted_date' || k === 'adjusted_time') continue;
      if (v !== '') body[k] = Number(v);
    }
    body.adjusted_at = (f.get('adjusted_date') || dtNow().slice(0, 10)) + 'T' + (f.get('adjusted_time') || '00:00');
    try {
      const r = await api('/adjustments', 'POST', body);
      toast('Dip recorded');
      closeModal(); await loadReference(); go('stock');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- receipts
async function renderReceipts(content) {
  content.innerHTML = `
    <div class="card">
      <div class="content-head">
        <h3>${canWrite() ? 'Stock Received' : 'Stock received register'}</h3>
      </div>
      ${canWrite() ? `
      <form class="form-grid" id="quick-receipt">
        <label>Date <input name="received_date" type="date" value="${dtNow().slice(0, 10)}"></label>
        <label>Time <input name="received_time" type="time" value="${dtNow().slice(11)}"></label>
        <label>Supplier Name <select name="supplier_id">${supplierOptions()}</select></label>
        <label>Bill of Lading No. <input name="waybill_no"></label>
        <label>Product <select name="product_id"><option value="">— Select product —</option>${productOptions()}</select></label>
        <label>Loaded litres (BOL) <input name="loaded_litres" type="number" step="any" min="0" placeholder="Per bill of lading"></label>
        <label>Tank <select name="tank_id"><option value="">— Select tank —</option>${tankOptions()}</select></label>
        <label>Meter Opening Reading <input name="meter_opening" id="meter_opening" type="number" step="any" min="0"></label>
        <label>Meter Closing Reading <input name="meter_closing" id="meter_closing" type="number" step="any" min="0"></label>
        <label>Received Quantity (L) <input name="recv_qty" id="recv-qty" type="number" step="any" min="0" readonly></label>
        <label>Transporter Name <select name="transporter_id">${transporterOptions()}</select></label>
        <label>Vehicle <select name="vehicle_reg" id="rec-vehicle">${vehicleOptions()}</select></label>
        <label>Driver Name <input name="driver_name" id="rec-driver" placeholder="Driver name"></label>
        <label class="full">📷 Document photo
          <input type="file" accept="image/*" class="photo-file">
          <input type="hidden" name="photo">
          <img class="photo-preview" hidden alt="document photo">
          <button type="button" class="photo-clear btn btn-ghost btn-sm" hidden>Remove photo</button>
        </label>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save Delivery</button></div>
      </form>` : ''}
    </div>`;
  if (canWrite()) {
    const prodSel = $('#quick-receipt select[name=product_id]');
    const tankSel = $('#quick-receipt select[name=tank_id]');
    bindTankProductFilter(tankSel, prodSel);
    const updRecv = () => {
      const op = parseFloat($('#meter_opening').value) || 0;
      const cl = parseFloat($('#meter_closing').value) || 0;
      $('#recv-qty').value = cl >= op ? cl - op : 0;
    };
    $('#meter_opening').addEventListener('input', updRecv);
    $('#meter_closing').addEventListener('input', updRecv);
    bindVehicleAutofill('#quick-receipt', 'rec-vehicle');
    attachPhotoCapture($('#quick-receipt'));
    $('#quick-receipt').addEventListener('submit', submitReceipt);
  }
}

function bindVehicleAutofill(formSel, vehicleId) {
  const form = $(formSel);
  const veh = $(formSel + ' #' + vehicleId);
  if (!form || !veh) return;
  veh.addEventListener('change', () => {
    const v = vehicleInfo(veh.value);
    const trans = form.querySelector('select[name=transporter_id]');
    if (!v) { if (trans) trans.value = ''; return; }
    if (trans && v.transporter_id) trans.value = v.transporter_id;
  });
}

function receiptsTable(rows) {
  if (!rows.length) return '<table class="data"><tr class="empty-row"><td>No receipts found.</td></tr></table>';
  return `<table class="data" id="export-table-receipts">
    <thead><tr><th>Receipt no</th><th>Date</th><th>Product</th><th>Tank</th><th>Supplier</th><th>Transporter</th><th>Qty</th><th>Vehicle</th><th>Driver</th><th>Waybill</th><th>Doc</th><th>Operator</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.receipt_no)}</b></td>
      <td>${esc(String(r.received_at).slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(r.product)}</td>
      <td>${esc(r.tank)}</td>
      <td>${esc(r.supplier || '—')}</td>
      <td>${esc(r.transporter || '—')}</td>
      <td><b class="num">${fmtQty(r.qty, r.unit)}</b></td>
      <td>${esc(r.vehicle_reg || '—')}</td>
      <td>${esc(r.driver_name || '—')}</td>
      <td>${esc(r.waybill_no || '—')}</td>
      <td>${r.photo ? `<button class="photo-link" data-kind="receipts" data-id="${r.id}">📷</button>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${esc(r.operator || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function submitReceipt(e) {
  e.preventDefault();
  const f = new FormData(e.target.closest('form'));
  const body = Object.fromEntries(f.entries());
  const op = parseFloat(body.meter_opening);
  const cl = parseFloat(body.meter_closing);
  let qty = cl - op;
  if (!(qty > 0)) qty = Number(body.loaded_litres || 0);
  body.qty = qty;
  delete body.recv_qty;
  body.received_at = (body.received_date || dtNow().slice(0, 10)) + 'T' + (body.received_time || '00:00');
  delete body.received_date;
  delete body.received_time;
  try {
    const r = await api('/receipts', 'POST', body);
    toast(`Receipt ${r.receipt_no} saved - received ${fmtQty(qty, 'L')}` + (r.warning ? ' — ' + r.warning : ''), r.warning ? 'warn' : 'success');
    closeModal(); await loadReference(); go('receipts');
  } catch (err) { toast(err.message, 'error'); }
}

// ---------------------------------------------------------------- dispatches
async function renderDispatches(content) {
  content.innerHTML = `
    <div class="card">
      <div class="content-head">
        <h3>${canWrite() ? 'Stock Dispatch - Customer Deliveries' : 'Stock dispatched register'}</h3>
      </div>
      ${canWrite() ? `
      <form class="form-grid" id="quick-dispatch">
        <label>Date <input name="dispatched_date" type="date" value="${dtNow().slice(0, 10)}"></label>
        <label>Time <input name="dispatched_time" type="time" value="${dtNow().slice(11)}"></label>
        <label>Customer Name <select name="customer_id">${customerOptions()}</select></label>
        <label>Delivery Address <input name="destination" placeholder="Site / area"></label>
        <label>Customer Order No. <input name="order_no"></label>
        <label>Loading Bill No. <input name="delivery_no"></label>
        <label>Product <select name="product_id"><option value="">— Select product —</option>${productOptions()}</select></label>
        <label>Tank <select name="tank_id"><option value="">— Select tank —</option>${tankOptions()}</select></label>
        <label>Meter Opening Reading <input name="meter_opening" id="d-meter-opening" type="number" step="any" min="0"></label>
        <label>Meter Closing Reading <input name="meter_closing" id="d-meter-closing" type="number" step="any" min="0"></label>
        <label>Loaded Quantity <input name="qty" id="d-qty" type="number" step="any" min="0" readonly></label>
        <label>Transporter <select name="transporter_id">${transporterOptions()}</select></label>
        <label>Vehicle <select name="vehicle_reg" id="d-vehicle">${vehicleOptions()}</select></label>
        <label>Driver Name <input name="driver_name" id="d-driver" placeholder="Driver name"></label>
        <label class="full">📷 Document photo
          <input type="file" accept="image/*" class="photo-file">
          <input type="hidden" name="photo">
          <img class="photo-preview" hidden alt="document photo">
          <button type="button" class="photo-clear btn btn-ghost btn-sm" hidden>Remove photo</button>
        </label>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save Delivery</button></div>
      </form>` : ''}
    </div>`;
  if (canWrite()) {
    bindTankProductFilter($('#quick-dispatch select[name=tank_id]'), $('#quick-dispatch select[name=product_id]'));
    $('#quick-dispatch').addEventListener('submit', submitDispatch);
    const updD = () => {
      const op = parseFloat($('#d-meter-opening').value) || 0;
      const cl = parseFloat($('#d-meter-closing').value) || 0;
      $('#d-qty').value = cl >= op ? cl - op : 0;
    };
    $('#d-meter-opening').addEventListener('input', updD);
    $('#d-meter-closing').addEventListener('input', updD);
    bindVehicleAutofill('#quick-dispatch', 'd-vehicle');
    attachPhotoCapture($('#quick-dispatch'));
  }
}

function dispatchesTable(rows) {
  if (!rows.length) return '<table class="data"><tr class="empty-row"><td>No dispatches found.</td></tr></table>';
  return `<table class="data" id="export-table-dispatches">
    <thead><tr><th>Dispatch no</th><th>Date</th><th>Product</th><th>Tank</th><th>Customer</th><th>Transporter</th><th>Qty</th><th>Vehicle</th><th>Driver</th><th>Delivery no</th><th>Doc</th><th>Operator</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.dispatch_no)}</b></td>
      <td>${esc(String(r.dispatched_at).slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(r.product)}</td>
      <td>${esc(r.tank)}</td>
      <td>${esc(r.customer || '—')}</td>
      <td>${esc(r.transporter || '—')}</td>
      <td><b class="num">${fmtQty(r.qty, r.unit)}</b></td>
      <td>${esc(r.vehicle_reg || '—')}</td>
      <td>${esc(r.driver_name || '—')}</td>
      <td>${esc(r.delivery_no || '—')}</td>
      <td>${r.photo ? `<button class="photo-link" data-kind="dispatches" data-id="${r.id}">📷</button>` : '<span class="muted">—</span>'}</td>
      <td class="muted">${esc(r.operator || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function openPhoto(kind, id) {
  try {
    const res = await fetch(`/api/${kind}/${id}/photo`, { headers: { Authorization: 'Bearer ' + state.token } });
    if (!res.ok) { toast('No photo available', 'error'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    openModal('Document photo', `<img src="${url}" style="max-width:100%;max-height:70vh;border-radius:8px" alt="captured document">`);
  } catch (_) { toast('Could not load photo', 'error'); }
}

document.addEventListener('click', e => {
  const link = e.target.closest('.photo-link');
  if (link) openPhoto(link.dataset.kind, link.dataset.id);
});

function downscaleImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('invalid image'));
    img.src = URL.createObjectURL(file);
  });
}

function attachPhotoCapture(formEl) {
  const file = formEl.querySelector('.photo-file');
  if (!file) return;
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const dataUrl = await downscaleImage(f);
      formEl.querySelector('input[name=photo]').value = dataUrl;
      const preview = formEl.querySelector('.photo-preview');
      preview.src = dataUrl;
      preview.hidden = false;
      formEl.querySelector('.photo-clear').hidden = false;
    } catch (_) { toast('Could not read image', 'error'); }
  });
  const clear = formEl.querySelector('.photo-clear');
  if (clear) clear.addEventListener('click', () => {
    file.value = '';
    formEl.querySelector('input[name=photo]').value = '';
    formEl.querySelector('.photo-preview').hidden = true;
    clear.hidden = true;
  });
}

async function submitDispatch(e) {
  e.preventDefault();
  const f = new FormData(e.target.closest('form'));
  const body = Object.fromEntries(f.entries());
  body.meter_opening = body.meter_opening || null;
  body.meter_closing = body.meter_closing || null;
  body.qty = (body.meter_opening && body.meter_closing) ? Number(body.meter_closing) - Number(body.meter_opening) : Number(body.qty) || 0;
  body.dispatched_at = (body.dispatched_date || dtNow().slice(0, 10)) + 'T' + (body.dispatched_time || '00:00');
  delete body.dispatched_date;
  delete body.dispatched_time;
  try {
    const r = await api('/dispatches', 'POST', body);
    toast(`Dispatch ${r.dispatch_no} saved`, 'success');
    closeModal(); await loadReference(); go('dispatches');
  } catch (err) { toast(err.message, 'error'); }
}

// ---------------------------------------------------------------- transfers
async function renderTransfers(content) {
  const transfers = await api('/transfers');
  const rows = transfers.map(t => `<tr>
    <td>${esc(String(t.transferred_at).slice(0, 16).replace('T', ' '))}</td>
    <td>${esc(t.product)}</td>
    <td>${esc(t.from_tank)} → ${esc(t.to_tank)}</td>
    <td><b class="num">${fmtQty(t.qty, t.unit)}</b></td>
    <td class="muted">${esc(t.notes || '')}</td>
    <td class="muted">${esc(t.operator || '')}</td>
  </tr>`).join('');

  content.innerHTML = `
    <div class="card">
      <div class="content-head">
        <h3>Transfer stock between tanks</h3>
        ${canWrite() ? '<button class="btn btn-transport" onclick="transferModal()">+ New transfer</button>' : ''}
      </div>
      ${canWrite() ? `
      <form class="form-grid" id="transfer-form">
        <label>From tank <select name="from_tank_id">${tankOptions()}</select></label>
        <label>To tank <select name="to_tank_id">${tankOptions()}</select></label>
        <label>Quantity (litres) <input name="qty" type="number" step="any" min="0.001" required></label>
        <label>Date &amp; time <input name="transferred_at" type="datetime-local" value="${dtNow()}"></label>
        <label class="full">Reason for transfer <textarea name="notes" style="min-height:40px"></textarea></label>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Transfer</button></div>
      </form>` : ''}
    </div>
    <div class="card">
      <div class="card-title">Transfer history</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Product</th><th>Transfer</th><th>Quantity</th><th>Reason for transfer</th><th>Operator</th></tr></thead>
        <tbody>${rows || '<tr class="empty-row"><td colspan="6">No transfers yet.</td></tr>'}</tbody>
      </table></div>
    </div>`;
  if (canWrite()) $('#transfer-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.qty = Number(body.qty);
    try {
      await api('/transfers', 'POST', body);
      toast('Transfer recorded', 'success');
      await loadReference(); go('transfers');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function transferModal() {
  openModal('New transfer', `
    <form class="form-grid" id="transfer-modal-form">
      <label>From tank <select name="from_tank_id">${tankOptions()}</select></label>
      <label>To tank <select name="to_tank_id">${tankOptions()}</select></label>
      <label>Quantity (litres) <input name="qty" type="number" step="any" min="0.001" required></label>
      <label>Date &amp; time <input name="transferred_at" type="datetime-local" value="${dtNow()}"></label>
      <label class="full">Reason for transfer <textarea name="notes"></textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Transfer</button>
      </div>
    </form>`);
  $('#transfer-modal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.qty = Number(body.qty);
    try {
      await api('/transfers', 'POST', body);
      toast('Transfer recorded', 'success');
      closeModal(); await loadReference(); go('transfers');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- adjustments
async function renderAdjustments(content) {
  const rows = await api('/adjustments');
  const typeTag = { gain: 'tag-in', loss: 'tag-out', correction: 'tag-move', dip_reading: 'tag-move' };
  const typeLabel = { gain: 'Gain', loss: 'Loss', correction: 'Correction', dip_reading: 'Dip reading' };
  const rowsHtml = rows.map(a => `<tr>
    <td>${esc(String(a.adjusted_at).slice(0, 16).replace('T', ' '))}</td>
    <td><b>${esc(a.tank)}</b></td>
    <td>${esc(a.product)}</td>
    <td><span class="tag ${typeTag[a.adj_type]}">${typeLabel[a.adj_type]}</span></td>
    <td><b class="num">${fmtQty(a.qty, a.unit)}</b></td>
    <td class="muted">${esc(a.reason || a.notes || '')}</td>
    <td class="muted">${esc(a.operator || '')}</td>
  </tr>`).join('');

  content.innerHTML = `
    <div class="card">
      <div class="content-head">
        <h3>Stock adjustments &amp; dip readings</h3>
        ${canWrite() ? '<button class="btn btn-transport" onclick="adjustmentModal()">+ New adjustment</button>' : ''}
      </div>
      ${canWrite() ? `
      <form class="form-grid" id="adj-form">
        <label>Tank <select name="tank_id">${tankOptions()}</select></label>
        <label>Type
          <select name="adj_type">
            <option value="dip_reading">Dip reading (set level)</option>
            <option value="gain">Gain (+ quantity)</option>
            <option value="loss">Loss (− quantity)</option>
            <option value="correction">Correction (set level)</option>
          </select>
        </label>
        <label>Quantity (litres) <input name="qty" type="number" step="any" min="0" required><span class="hint">For dip/correction enter the actual level; for gain/loss enter the amount.</span></label>
        <label>Date <input name="adjusted_date" type="date" value="${dtNow().slice(0, 10)}"></label>
        <label>Time <input name="adjusted_time" type="time" value="${dtNow().slice(11)}"></label>
        <label>Dip before <input name="dip_before" type="number" step="any" min="0"></label>
        <label>Dip after <input name="dip_after" type="number" step="any" min="0"></label>
        <label class="full">Reason / notes <textarea name="reason" style="min-height:40px" placeholder="Reason for adjustment"></textarea></label>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save adjustment</button></div>
      </form>` : ''}
    </div>
    <div class="card">
      <div class="card-title">Adjustment history</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Tank</th><th>Product</th><th>Type</th><th>Quantity</th><th>Reason</th><th>Operator</th></tr></thead>
        <tbody>${rowsHtml || '<tr class="empty-row"><td colspan="7">No adjustments yet.</td></tr>'}</tbody>
      </table></div>
    </div>`;
  if (canWrite()) $('#adj-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.qty = Number(body.qty);
    for (const k of ['dip_before', 'dip_after']) if (body[k] === '') delete body[k];
    body.adjusted_at = (body.adjusted_date || dtNow().slice(0, 10)) + 'T' + (body.adjusted_time || '00:00');
    delete body.adjusted_date;
    delete body.adjusted_time;
    try {
      await api('/adjustments', 'POST', body);
      toast('Adjustment saved', 'success');
      await loadReference(); go('adjustments');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function adjustmentModal() {
  openModal('New adjustment / dip reading', `
    <form class="form-grid" id="adj-modal-form">
      <label>Tank <select name="tank_id">${tankOptions()}</select></label>
      <label>Type
        <select name="adj_type">
          <option value="dip_reading">Dip reading (set level)</option>
          <option value="gain">Gain (+ quantity)</option>
          <option value="loss">Loss (− quantity)</option>
          <option value="correction">Correction (set level)</option>
        </select>
      </label>
      <label>Quantity (litres) <input name="qty" type="number" step="any" min="0" required></label>
      <label>Date <input name="adjusted_date" type="date" value="${dtNow().slice(0, 10)}"></label>
      <label>Time <input name="adjusted_time" type="time" value="${dtNow().slice(11)}"></label>
      <label>Dip before <input name="dip_before" type="number" step="any" min="0"></label>
      <label>Dip after <input name="dip_after" type="number" step="any" min="0"></label>
      <label class="full">Reason / notes <textarea name="reason" placeholder="Reason for adjustment"></textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#adj-modal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.qty = Number(body.qty);
    for (const k of ['dip_before', 'dip_after']) if (body[k] === '') delete body[k];
    body.adjusted_at = (body.adjusted_date || dtNow().slice(0, 10)) + 'T' + (body.adjusted_time || '00:00');
    delete body.adjusted_date;
    delete body.adjusted_time;
    try {
      await api('/adjustments', 'POST', body);
      toast('Adjustment saved', 'success');
      closeModal(); await loadReference(); go('adjustments');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- reports
async function renderReports(content) {
  const initial = state.reportTab || 'stock';
  state.reportTab = null;
  content.innerHTML = `<div id="report-body"></div>`;
  $$('#nav .nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.section === 'reports' && (b.dataset.reportTab || 'stock') === initial);
  });
  if (initial === 'stock') return reportStock($('#report-body'));
  if (initial === 'movements') return reportMovements($('#report-body'));
  return reportRegisters($('#report-body'));
}

async function reportStock(el) {
  const data = await api('/reports/stock');
  const rows = data.rows.map(r => {
    const cls = r.status === 'LOW' ? 'crit' : (r.status === 'HIGH' ? 'warn' : '');
    const tag = r.status === 'LOW' ? 'tag-low' : (r.status === 'HIGH' ? 'tag-high' : 'tag-ok');
    return `<tr>
      <td><b>${esc(r.code)}</b></td>
      <td>${esc(r.name || '')}</td>
      <td>${esc(r.product || '—')}</td>
      <td>${esc(r.unit)}</td>
      <td><b class="num">${fmtQty(r.current_qty, '')}</b></td>
      <td class="num">${r.capacity ? fmtNum(r.capacity) : '—'}</td>
      <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.min(100, r.fill_pct)}%"></div></div><span>${r.fill_pct}%</span></div></td>
      <td>${r.min_level != null ? fmtNum(r.min_level) : '—'} / ${r.max_level != null ? fmtNum(r.max_level) : '—'}</td>
      <td><span class="tag ${tag}">${r.status}</span></td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="card">
      <div class="content-head">
        <div class="card-title" style="margin:0">Current stock report — ${data.rows.length} tanks, total ${fmtNum(data.totals.litres)} L in storage</div>
        <button class="btn btn-outline btn-sm" onclick="exportExcel('stock')">Export Excel</button>
      </div>
      <div class="table-wrap"><table class="data" id="export-table-stock">
        <thead><tr><th>Tank</th><th>Name</th><th>Product</th><th>Unit</th><th>Current qty</th><th>Capacity</th><th>Fill %</th><th>Min / Max</th><th>Status</th></tr></thead>
        <tbody>${rows || '<tr class="empty-row"><td colspan="9">No tanks.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

async function reportMovements(el) {
  el.innerHTML = `
    <div class="card">
      <div class="card-title">Movement report</div>
      <div class="filter-bar">
        <label>From <input type="date" id="m-from"></label>
        <label>To <input type="date" id="m-to"></label>
        <label>Product <select id="m-product">${productOptions()}</select></label>
        <label>Tank <select id="m-tank"><option value="">All</option>${tankOptions()}</select></label>
        <label>Movement Type
          <select id="m-type">
            <option value="">All types</option>
            <option value="receipt">Received</option>
            <option value="dispatch">Dispatched</option>
            <option value="transfer_in">Transfer IN</option>
            <option value="transfer_out">Transfer OUT</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </label>
        <button class="btn btn-outline" id="m-apply">Apply</button>
        <button class="btn btn-outline" onclick="exportExcel('movements')">Export Excel</button>
      </div>
      <div id="m-list" class="table-wrap"></div>
    </div>`;
  const load = async () => {
    const p = new URLSearchParams();
    if ($('#m-from').value) p.set('from', $('#m-from').value);
    if ($('#m-to').value) p.set('to', $('#m-to').value);
    if ($('#m-product').value) p.set('product_id', $('#m-product').value);
    if ($('#m-tank').value) p.set('tank_id', $('#m-tank').value);
    if ($('#m-type').value) p.set('type', $('#m-type').value);
    const rows = await api('/reports/movements?' + p.toString());
    const totalIn = rows.filter(r => r.direction === 'IN').reduce((s, r) => s + r.qty, 0);
    const totalOut = rows.filter(r => r.direction === 'OUT').reduce((s, r) => s + r.qty, 0);
    $('#m-list').innerHTML = movementsTable(rows) +
      `<div class="mt muted"><b>Totals:</b> IN ${fmtNum(totalIn)} L &nbsp;·&nbsp; OUT ${fmtNum(totalOut)} L &nbsp;·&nbsp; ${rows.length} line items</div>`;
  };
  $('#m-apply').addEventListener('click', load);
  load();
}

function movementsTable(rows) {
  if (!rows.length) return '<table class="data"><tr class="empty-row"><td>No movements for the selected filters.</td></tr></table>';
  const dirTag = { IN: 'tag-in', OUT: 'tag-out', ADJ: 'tag-move' };
  return `<table class="data" id="export-table-movements">
    <thead><tr><th>Date</th><th>Type</th><th>Document</th><th>Product</th><th>Tank</th><th>Party</th><th>Qty</th><th>Direction</th><th>Vehicle / driver</th><th>Operator</th></tr></thead>
    <tbody>${rows.map(m => `<tr>
      <td>${esc(String(m.ts).slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(m.type)}</td>
      <td><b>${esc(m.doc_no || '—')}</b></td>
      <td>${esc(m.product)}</td>
      <td>${esc(m.tank)}</td>
      <td>${esc(m.party || '—')}</td>
      <td><b class="num">${fmtQty(m.qty, m.unit)}</b></td>
      <td><span class="tag ${dirTag[m.direction]}">${m.direction}</span></td>
      <td>${esc([m.vehicle_reg, m.driver_name].filter(Boolean).join(' / ') || '—')}</td>
      <td class="muted">${esc(m.operator || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function reportRegisters(el) {
  const [receipts, dispatches] = await Promise.all([api('/receipts'), api('/dispatches')]);
  const grvTotal = receipts.reduce((s, r) => s + r.qty, 0);
  const delTotal = dispatches.reduce((s, r) => s + r.qty, 0);
  el.innerHTML = `
    <div class="grid cols-2" style="align-items:start">
      <div class="card">
        <div class="content-head">
          <div class="card-title" style="margin:0">Received register (${receipts.length} docs, ${fmtNum(grvTotal)} L)</div>
          <button class="btn btn-outline btn-sm" onclick="exportExcel('receipts')">Excel</button>
        </div>
        <div class="table-wrap" style="max-height:500px;overflow:auto">${receiptsTable(receipts.slice(0, 300))}</div>
      </div>
      <div class="card">
        <div class="content-head">
          <div class="card-title" style="margin:0">Dispatched register (${dispatches.length} docs, ${fmtNum(delTotal)} L)</div>
          <button class="btn btn-outline btn-sm" onclick="exportExcel('dispatches')">Excel</button>
        </div>
        <div class="table-wrap" style="max-height:500px;overflow:auto">${dispatchesTable(dispatches.slice(0, 300))}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- Excel export
function xlsFromTable(tableId, name) {
  const table = $('#' + tableId);
  if (!table) return toast('No data to export', 'warn');
  const clone = table.cloneNode(true);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${name}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--><style>table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px;font-family:Arial;font-size:11pt;mso-number-format:"General"}th{font-weight:bold;background:#eee}</style></head><body>${clone.outerHTML}</body></html>`;
  const blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '-' + today() + '.xls';
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportExcel(kind) {
  if (kind === 'stock') return xlsFromTable('export-table-stock', 'stock-report');
  if (kind === 'movements') return xlsFromTable('export-table-movements', 'movement-report');
  if (kind === 'receipts') return xlsFromTable('export-table-receipts', 'received-register');
  if (kind === 'dispatches') return xlsFromTable('export-table-dispatches', 'dispatched-register');
}

// ---------------------------------------------------------------- customers / suppliers / products
function partyModal(kind, id) {
  const list = kind === 'customer' ? customersCache : suppliersCache;
  const x = id ? list.find(o => o.id === id) : {};
  const label = kind === 'customer' ? 'Customer' : 'Supplier';
  openModal(`${id ? 'Edit' : 'Add'} ${label}`, `
    <form class="form-grid" id="party-form">
      <label class="full">Name <input name="name" value="${esc(x.name || '')}" required></label>
      <label>Contact person <input name="contact_person" value="${esc(x.contact_person || '')}"></label>
      <label>Phone <input name="phone" value="${esc(x.phone || '')}"></label>
      <label>Email <input name="email" type="email" value="${esc(x.email || '')}"></label>
      <label class="full">Address <input name="address" value="${esc(x.address || '')}"></label>
      <label class="full">Notes <textarea name="notes">${esc(x.notes || '')}</textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#party-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    const url = kind === 'customer' ? '/customers' : '/suppliers';
    try {
      if (id) { await api(url + '/' + id, 'PUT', body); toast(label + ' updated'); }
      else { await api(url, 'POST', body); toast(label + ' added'); }
      closeModal(); await loadReference(); go(kind === 'customer' ? 'customers' : 'suppliers');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteParty(kind, id) {
  const list = kind === 'customer' ? customersCache : suppliersCache;
  const x = list.find(o => o.id === id);
  if (!confirmAction(`Delete ${kind} "${x.name}"?`)) return;
  const url = kind === 'customer' ? '/customers' : '/suppliers';
  try { await api(url + '/' + id, 'DELETE'); toast('Deleted'); await loadReference(); go(kind === 'customer' ? 'customers' : 'suppliers'); }
  catch (err) { toast(err.message, 'error'); }
}

async function renderCustomers(content) {
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">List of Customers</div>
      ${canWrite() ? '<button class="btn btn-transport" onclick="partyModal(\'customer\')">+ Add customer</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data" id="export-table-customers">
      <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>Address</th><th>Notes</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${customersCache.map(c => `<tr>
        <td><b>${esc(c.name)}</b></td>
        <td>${esc(c.contact_person || '—')}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${esc(c.email || '—')}</td>
        <td>${esc(c.address || '—')}</td>
        <td class="muted">${esc(c.notes || '')}</td>
        ${isAdmin() ? `<td><div class="flex"><button class="btn btn-sm btn-outline" onclick="partyModal('customer',${c.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteParty('customer',${c.id})">Del</button></div></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

async function renderSuppliers(content) {
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">List of Suppliers</div>
      ${canWrite() ? '<button class="btn btn-transport" onclick="partyModal(\'supplier\')">+ Add supplier</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>Address</th><th>Notes</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${suppliersCache.map(s => `<tr>
        <td><b>${esc(s.name)}</b></td>
        <td>${esc(s.contact_person || '—')}</td>
        <td>${esc(s.phone || '—')}</td>
        <td>${esc(s.email || '—')}</td>
        <td>${esc(s.address || '—')}</td>
        <td class="muted">${esc(s.notes || '')}</td>
        ${isAdmin() ? `<td><div class="flex"><button class="btn btn-sm btn-outline" onclick="partyModal('supplier',${s.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteParty('supplier',${s.id})">Del</button></div></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function productModal(id) {
  const p = id ? productsCache.find(x => x.id === id) : {};
  openModal(id ? 'Edit product' : 'Add product', `
    <form class="form-grid" id="product-form">
      <label class="full">Name <input name="name" value="${esc(p.name || '')}" required></label>
      <label>Category <input name="category" value="${esc(p.category || '')}" placeholder="Fuel / Lubricants / Aviation"></label>
      <label>Unit
        <select name="unit">
          ${['litres', 'kilolitres', 'tonnes', 'kg', 'barrels'].map(u => `<option value="${u}" ${p.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
      </label>
      <label>Density (kg/L) <input name="density" type="number" step="any" min="0" value="${p.density ?? ''}"></label>
      <label>Default min stock <input name="min_stock" type="number" step="any" min="0" value="${p.min_stock ?? ''}"></label>
      <label class="full">Notes <textarea name="notes">${esc(p.notes || '')}</textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#product-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (body.density === '') delete body.density;
    body.min_stock = Number(body.min_stock || 0);
    try {
      if (id) { await api('/products/' + id, 'PUT', body); toast('Product updated'); }
      else { await api('/products', 'POST', body); toast('Product added'); }
      closeModal(); await loadReference(); go('products');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteProduct(id) {
  const p = productsCache.find(x => x.id === id);
  if (!confirmAction(`Delete product "${p.name}"?`)) return;
  try { await api('/products/' + id, 'DELETE'); toast('Product deleted'); await loadReference(); go('products'); }
  catch (err) { toast(err.message, 'error'); }
}

async function renderProducts(content) {
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">List of Products</div>
      ${canWrite() ? '<button class="btn btn-transport" onclick="productModal()">+ Add product</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Category</th><th>Unit</th><th>Density</th><th>Min stock</th><th>Notes</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${productsCache.map(p => `<tr>
        <td><b>${esc(p.name)}</b></td>
        <td>${esc(p.category || '—')}</td>
        <td>${esc(p.unit)}</td>
        <td>${p.density != null ? p.density : '—'}</td>
        <td class="num">${fmtNum(p.min_stock)}</td>
        <td class="muted">${esc(p.notes || '')}</td>
        ${isAdmin() ? `<td><div class="flex"><button class="btn btn-sm btn-outline" onclick="productModal(${p.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">Del</button></div></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ---------------------------------------------------------------- transporters & drivers (admin)
function transporterModal(id) {
  const t = id ? transportersCache.find(x => x.id === id) : {};
  openModal(`${id ? 'Edit' : 'Add'} transporter`, `
    <form class="form-grid" id="transporter-form">
      <label class="full">Name <input name="name" value="${esc(t.name || '')}" required></label>
      <label>Contact person <input name="contact_person" value="${esc(t.contact_person || '')}"></label>
      <label>Phone <input name="phone" value="${esc(t.phone || '')}"></label>
      <label class="full">Notes <textarea name="notes">${esc(t.notes || '')}</textarea></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#transporter-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (id) { await api('/transporters/' + id, 'PUT', body); toast('Transporter updated'); }
      else { await api('/transporters', 'POST', body); toast('Transporter added'); }
      closeModal(); await loadReference(); go('transporters');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteTransporter(id) {
  const t = transportersCache.find(x => x.id === id);
  if (!confirmAction(`Delete transporter "${t.name}"?`)) return;
  try { await api('/transporters/' + id, 'DELETE'); toast('Deleted'); await loadReference(); go('transporters'); }
  catch (err) { toast(err.message, 'error'); }
}

async function renderTransporters(content) {
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">List of Transport Companies</div>
      ${canWrite() ? '<button class="btn btn-transport" onclick="transporterModal()">+ Add transporter</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Contact person</th><th>Phone</th><th>Notes</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${transportersCache.map(t => `<tr>
        <td><b>${esc(t.name)}</b></td>
        <td>${esc(t.contact_person || '—')}</td>
        <td>${esc(t.phone || '—')}</td>
        <td class="muted">${esc(t.notes || '')}</td>
        ${isAdmin() ? `<td><div class="flex"><button class="btn btn-sm btn-outline" onclick="transporterModal(${t.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteTransporter(${t.id})">Del</button></div></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function driverModal(id) {
  const d = id ? driversCache.find(x => x.id === id) : {};
  openModal(`${id ? 'Edit' : 'Add'} driver`, `
    <form class="form-grid" id="driver-form">
      <label class="full">Name <input name="name" value="${esc(d.name || '')}" required></label>
      <label>Phone <input name="phone" value="${esc(d.phone || '')}"></label>
      <label>Transporter
        <select name="transporter_id"><option value="">— Select transporter —</option>${transportersCache.map(t => `<option value="${t.id}" ${String(t.id) === String(d.transporter_id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      </label>
      <label class="full">Licence Expiry Date <input name="notes" type="date" value="${esc(d.notes || '')}"></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#driver-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (id) { await api('/drivers/' + id, 'PUT', body); toast('Driver updated'); }
      else { await api('/drivers', 'POST', body); toast('Driver added'); }
      closeModal(); await loadReference(); go('drivers');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteDriver(id) {
  const d = driversCache.find(x => x.id === id);
  if (!confirmAction(`Delete driver "${d.name}"?`)) return;
  try { await api('/drivers/' + id, 'DELETE'); toast('Deleted'); await loadReference(); go('drivers'); }
  catch (err) { toast(err.message, 'error'); }
}

async function renderDrivers(content) {
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">Tanker Drivers | Transport Company</div>
      ${canWrite() ? '<button class="btn btn-transport" onclick="driverModal()">+ Add driver</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Transporter</th><th>Phone</th><th>Licence Expiry Date</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${driversCache.map(d => `<tr>
        <td><b>${esc(d.name)}</b></td>
        <td>${esc(d.transporter || '—')}</td>
        <td>${esc(d.phone || '—')}</td>
        <td class="muted">${esc(d.notes || '')}</td>
        ${isAdmin() ? `<td><div class="flex"><button class="btn btn-sm btn-outline" onclick="driverModal(${d.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteDriver(${d.id})">Del</button></div></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ---------------------------------------------------------------- vehicles (admin)
const VEHICLE_TYPES = ['Truck Tractor', 'Tanker Trailer', 'Interlink Trailer', 'Draw-bar Link Trailer'];

function vehicleModal(id) {
  const v = id ? vehiclesCache.find(x => x.id === id) : {};
  openModal(`${id ? 'Edit' : 'Add'} vehicle`, `
    <form class="form-grid" id="vehicle-form">
      <label>Fleet Number <input name="fleet_no" value="${esc(v.fleet_no || '')}"></label>
      <label>Registration <input name="reg" value="${esc(v.reg || '')}" required></label>
      <label>Vehicle Type
        <select name="vehicle_type"><option value="">— Select type —</option>${VEHICLE_TYPES.map(tp => `<option value="${tp}" ${v.vehicle_type === tp ? 'selected' : ''}>${tp}</option>`).join('')}</select>
      </label>
      <label>Transporter
        <select name="transporter_id"><option value="">— Select transporter —</option>${transportersCache.map(t => `<option value="${t.id}" ${String(t.id) === String(v.transporter_id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      </label>
      <label>Licence Expiry Date <input name="licence_expiry" type="date" value="${esc(v.licence_expiry || '')}"></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#vehicle-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (id) { await api('/vehicles/' + id, 'PUT', body); toast('Vehicle updated'); }
      else { await api('/vehicles', 'POST', body); toast('Vehicle added'); }
      closeModal(); await loadReference(); go('vehicles');
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteVehicle(id) {
  const v = vehiclesCache.find(x => x.id === id);
  if (!confirmAction(`Delete vehicle "${v.reg}"?`)) return;
  try { await api('/vehicles/' + id, 'DELETE'); toast('Deleted'); await loadReference(); go('vehicles'); }
  catch (err) { toast(err.message, 'error'); }
}

async function renderVehicles(content) {
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">Delivery Vehicles | Transport Companies</div>
      ${canWrite() ? '<button class="btn btn-transport" onclick="vehicleModal()">+ Add vehicle</button>' : ''}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Fleet Number</th><th>Registration</th><th>Type</th><th>Transporter</th><th>Licence Expiry Date</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody>${vehiclesCache.map(v => `<tr>
        <td><b>${esc(v.fleet_no || '—')}</b></td>
        <td>${esc(v.reg)}</td>
        <td>${esc(v.vehicle_type || '—')}</td>
        <td>${esc(v.transporter || '—')}</td>
        <td class="muted">${esc(v.licence_expiry || '')}</td>
        ${isAdmin() ? `<td><div class="flex"><button class="btn btn-sm btn-outline" onclick="vehicleModal(${v.id})">Edit</button><button class="btn btn-sm btn-danger" onclick="deleteVehicle(${v.id})">Del</button></div></td>` : ''}
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ---------------------------------------------------------------- users (admin)
async function renderUsers(content) {
  const users = await api('/users');
  const rows = users.map(u => `<tr>
    <td><b>${esc(u.full_name)}</b></td>
    <td>${esc(u.username)}</td>
    <td>${esc(u.role)}</td>
    <td>${u.active ? '<span class="status-active">Active</span>' : '<span class="status-inactive">Inactive</span>'}</td>
    <td class="muted">${esc(String(u.created_at).slice(0, 10))}</td>
    <td><div class="flex">
      <button class="btn btn-sm btn-outline" onclick="userModal(${u.id})">Edit</button>
      <button class="btn btn-sm btn-outline" onclick="resetPasswordModal(${u.id},'${esc(u.username)}')">Password</button>
    </div></td>
  </tr>`).join('');
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">Manage System Users</div>
      <button class="btn btn-transport" onclick="userModal()">+ Add user</button>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Full name</th><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function renderWhatsApp(content) {
  let cfg;
  try { cfg = await api('/whatsapp/config'); } catch { cfg = null; }
  if (!cfg) {
    content.innerHTML = `<div class="error-msg">Could not load WhatsApp config.</div>`;
    return;
  }
  content.innerHTML = `
    <div class="content-head">
      <div class="muted">Send stock received / stock dispatch alerts to a WhatsApp group</div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-title">WhatsApp Business Cloud API settings</div>
        <form class="form-grid" id="wa-form">
          <label class="full" style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" name="enabled" id="wa-enabled" ${cfg.enabled ? 'checked' : ''} style="width:auto">
            Enable WhatsApp alerts
          </label>
          <label>Phone Number ID <input name="phone_number_id" value="${esc(cfg.phone_number_id)}" placeholder="e.g. 123456789012345"></label>
          <label>Recipient / group number <input name="recipient" value="${esc(cfg.recipient)}" placeholder="e.g. 27820000000 (no +, no spaces)"></label>
          <label class="full">Access token
            <input name="access_token" type="password" placeholder="${cfg.token_masked ? 'Existing: ' + esc(cfg.token_masked) : 'Paste system user access token'}" autocomplete="off">
            <span class="muted" style="font-size:12px">Leave blank to keep the existing token.</span>
          </label>
          <label>Template — stock received <input name="template_received" value="${esc(cfg.template_received)}"></label>
          <label>Template — stock dispatch <input name="template_dispatch" value="${esc(cfg.template_dispatch)}"></label>
          <label>Language code <input name="language" value="${esc(cfg.language)}" placeholder="en_US"></label>
          <div class="form-actions full">
            <button type="submit" class="btn btn-primary">Save settings</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="card-title">Test alerts</div>
        <p class="muted" style="font-size:13px;margin-bottom:14px">Send a test message to the recipient/group with sample data. Templates must be created and approved in Meta first.</p>
        <div class="flex" style="gap:10px">
          <button class="btn btn-success" id="wa-test-received">Test stock received</button>
          <button class="btn btn-outline" id="wa-test-dispatch">Test stock dispatch</button>
        </div>
        <div id="wa-test-result" class="muted" style="margin-top:14px;font-size:13px"></div>
        <div class="card-title" style="margin-top:20px">Template requirements</div>
        <ol class="wa-steps">
          <li>In Meta Business Suite → WhatsApp → Message templates, create two templates:
            <b>stock_received</b> and <b>stock_dispatched</b>.</li>
          <li><b>stock_received</b> body: <code>{{1}} received: {{2}} {{3}} into {{4}}</code></li>
          <li><b>stock_dispatched</b> body: <code>{{1}} dispatched: {{2}} {{3}} from {{4}} to {{5}}</code></li>
          <li>Get the phone number ID and system-user access token from your WhatsApp Business App (Meta for Developers).</li>
          <li>Recipient/group number must be international format, e.g. <code>27820000000</code>.</li>
        </ol>
      </div>
    </div>`;

  $('#wa-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      enabled: f.get('enabled') === 'on',
      phone_number_id: f.get('phone_number_id'),
      recipient: f.get('recipient'),
      template_received: f.get('template_received'),
      template_dispatch: f.get('template_dispatch'),
      language: f.get('language')
    };
    const tok = f.get('access_token');
    if (tok && tok.trim()) body.access_token = tok.trim();
    try {
      await api('/whatsapp/config', 'PUT', body);
      toast('WhatsApp settings saved', 'success');
      go('whatsapp');
    } catch (err) { toast(err.message, 'error'); }
  });

  $('#wa-test-received').addEventListener('click', () => testWhatsApp('received'));
  $('#wa-test-dispatch').addEventListener('click', () => testWhatsApp('dispatch'));
}

async function testWhatsApp(kind) {
  const el = $('#wa-test-result');
  el.textContent = 'Sending…';
  try {
    const r = await api('/whatsapp/test', 'POST', { kind });
    el.textContent = 'Sent successfully' + (r.result && r.result.id ? ' · Message ID ' + r.result.id : '');
    el.style.color = 'var(--success)';
  } catch (err) {
    el.textContent = err.message;
    el.style.color = 'var(--danger)';
  }
}

function userModal(id) {
  const list = JSON.parse(sessionStorage.getItem('wtt_users') || '[]');
  openModal(id ? 'Edit user' : 'Add user', `
    <form class="form-grid" id="user-form">
      <label>Full name <input name="full_name" value="${esc(u.full_name || '')}" required></label>
      <label>Username <input name="username" value="${esc(u.username || '')}" ${id ? 'disabled' : ''} required></label>
      ${id ? '' : '<label>Password <input name="password" type="password" minlength="8" required><span class="muted" style="font-size:12px">8+ characters, letters and numbers</span></label>'}
      <label>Role
        <select name="role">
          ${['Administrator','Manager','Supervisor','Dispatcher','Clerk'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </label>
      ${id ? `<label>Active <select name="active"><option value="1" ${u.active ? 'selected' : ''}>Yes</option><option value="0" ${!u.active ? 'selected' : ''}>No</option></select></label>` : ''}
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    try {
      if (id) {
        body.active = body.active === '1';
        await api('/users/' + id, 'PUT', body);
        toast('User updated');
      } else {
        await api('/users', 'POST', body);
        toast('User added');
      }
      closeModal(); go('users');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function resetPasswordModal(id, username) {
  openModal(`Reset password — ${username}`, `
    <form id="pw-form">
      <label style="display:block;margin-bottom:12px">New password <input name="password" type="password" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;margin-top:4px" required></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Set password</button>
      </div>
    </form>`);
  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/users/' + id + '/password', 'PUT', { password: $('#pw-form input[name=password]').value });
      toast('Password updated', 'success');
      closeModal();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function showChangePassword() {
  openModal('Change my password', `
    <form id="my-pw-form">
      <label style="display:block;margin-bottom:12px">Current password <input name="old_password" type="password" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;margin-top:4px" required></label>
      <label style="display:block;margin-bottom:12px">New password <input name="new_password" type="password" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;margin-top:4px" minlength="8" required><span class="muted" style="font-size:12px">8+ characters, letters and numbers</span></label>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-outline" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn btn-primary">Update password</button>
      </div>
    </form>`);
  $('#my-pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/me/password', 'PUT', Object.fromEntries(f.entries()));
      toast('Password updated', 'success');
      closeModal();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------------------------------------------------------------- audit
async function renderAudit(content) {
  content.innerHTML = `
    <div class="card">
      <div class="card-title">Audit log — every action is recorded</div>
      <div class="filter-bar">
        <label>From <input type="date" id="a-from"></label>
        <label>To <input type="date" id="a-to"></label>
        <label>Search <input id="a-q" placeholder="User / action / entity"></label>
        <button class="btn btn-outline" id="a-apply">Apply</button>
      </div>
      <div id="a-list" class="table-wrap"></div>
    </div>`;
  const load = async () => {
    const p = new URLSearchParams();
    if ($('#a-from').value) p.set('from', $('#a-from').value);
    if ($('#a-to').value) p.set('to', $('#a-to').value);
    if ($('#a-q').value.trim()) p.set('q', $('#a-q').value.trim());
    const rows = await api('/audit?' + p.toString());
    $('#a-list').innerHTML = `<table class="data">
      <thead><tr><th>Date / time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(String(r.created_at).slice(0, 19))}</td>
        <td><b>${esc(r.username || 'system')}</b></td>
        <td><span class="pill" style="background:#eef1f5">${esc(r.action)}</span></td>
        <td>${esc(r.entity || '')}${r.entity_id ? ' #' + r.entity_id : ''}</td>
        <td class="muted" style="max-width:420px;white-space:normal">${esc(r.details || '')}</td>
      </tr>`).join('') || '<tr class="empty-row"><td colspan="5">No audit entries.</td></tr>'}</tbody>
    </table>`;
  };
  $('#a-apply').addEventListener('click', load);
  load();
}

// ---------------------------------------------------------------- start
async function restoreSession() {
  if (!state.token) return false;
  try {
    state.me = await api('/me');
    return true;
  } catch {
    state.token = null;
    localStorage.removeItem('wtt_token');
    return false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#login-form').addEventListener('submit', doLogin);
  const v = $('#app-version');
  if (v) v.textContent = APP_VERSION;
  if (location.protocol === 'file:') {
    const err = $('#login-error');
    err.textContent = 'This file cannot run by itself. Run start.bat, then open http://localhost:3001 in your browser instead of opening index.html directly.';
    err.hidden = false;
    const btn = $('#login-form button[type=submit]');
    if (btn) btn.disabled = true;
    return;
  }
  if (await restoreSession()) boot();
});

// Global error handler to prevent browser dialogs
window.addEventListener('unhandledrejection', e => {
  e.preventDefault();
  console.error('Unhandled rejection:', e.reason);
  const msg = e.reason?.message || (typeof e.reason === 'string' ? e.reason : null);
  if (msg) toast(msg, 'error');
});
window.addEventListener('error', e => {
  if (!e.error) return;
  console.error('Error:', e.error);
  toast(e.error.message || 'Unexpected error', 'error');
});

async function boot() {
  try {
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    document.body.classList.add('role-' + state.me.role);
    $('#user-name').textContent = state.me.full_name;
    $('#user-role').textContent = state.me.role;
    bindNav();
    await loadReference();
    await go('dashboard');
  } catch (err) {
    toast(err.message || 'Failed to load data', 'error');
    logout(false);
  }
}