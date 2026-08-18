'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.addEventListener('error', e => {
  const strip = $('#err-strip');
  if (strip) {
    strip.textContent = 'Something went wrong: ' + (e.message || 'unknown error') + '. Please update the app / browser and retry.';
    strip.classList.remove('hidden');
  }
});

function on(sel, evt, fn) {
  const el = $(sel);
  if (el) el.addEventListener(evt, fn);
}

let token = localStorage.getItem('wtt_token') || null;
let me = null;
let products = [], tanks = [], suppliers = [], customers = [], transporters = [], vehicles = [];

const state = { tab: 'receive', photos: { receive: null, dispatch: null } };

async function api(url, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch('/api' + url, opt);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
  return data;
}

function dtNow() { return new Date().toLocaleString('sv').replace(' ', 'T').slice(0, 16); }
function fmtQty(v, u) { const n = Number(v || 0); return n.toLocaleString('en-ZA', { maximumFractionDigits: 1 }) + ' ' + (u || 'L'); }

// ---------------------------------------------------------------- auth
async function boot() {
  if (token) {
    try {
      me = await api('/me');
      showApp();
      return;
    } catch (_) { token = null; localStorage.removeItem('wtt_token'); }
  }
  showLogin();
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app').classList.add('hidden');
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = me.full_name || me.username;
  populate();
  setTab(state.tab);
}

on('#form-login', 'submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-err').textContent = '';
  try {
    const data = await api('/login', 'POST', { username: f.get('username'), password: f.get('password') });
    token = data.token;
    localStorage.setItem('wtt_token', token);
    me = data.user;
    showApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

on('#btn-logout', 'click', () => {
  token = null;
  localStorage.removeItem('wtt_token');
  showLogin();
  $('#form-login').reset();
});

// ---------------------------------------------------------------- reference data
function productOptions(sel) {
  return products.map(p => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
function tanksForProduct(productId) {
  return tanks.filter(t => t.product_id === productId && t.active !== 0);
}
function genericOptions(list, key, label, sel) {
  return list.map(i => `<option value="${i[key]}" ${sel === i[key] ? 'selected' : ''}>${esc(i[label])}</option>`).join('');
}

async function populate() {
  [products, tanks, suppliers, customers, transporters, vehicles] = await Promise.all([
    api('/products'), api('/tanks'), api('/suppliers'), api('/customers'), api('/transporters'), api('/vehicles')
  ]);
  $$('select[name=product_id]').forEach(s => s.innerHTML = '<option value="">— Select product —</option>' + productOptions());
  const sup = $('#form-receive select[name=supplier_id]');
  sup.innerHTML = '<option value="">— Select —</option>' + genericOptions(suppliers, 'id', 'name');
  const trRec = $('#form-receive select[name=transporter_id]');
  trRec.innerHTML = '<option value="">— Select —</option>' + genericOptions(transporters, 'id', 'name');
  const cust = $('#form-dispatch select[name=customer_id]');
  cust.innerHTML = '<option value="">— Select —</option>' + genericOptions(customers, 'id', 'name');
  const trDisp = $('#form-dispatch select[name=transporter_id]');
  trDisp.innerHTML = '<option value="">— Select —</option>' + genericOptions(transporters, 'id', 'name');
  const vehRec = $('#form-receive select[name=vehicle_reg]');
  vehRec.innerHTML = '<option value="">— Select —</option>' + genericOptions(vehicles, 'reg', 'reg');
  const vehDisp = $('#form-dispatch select[name=vehicle_reg]');
  vehDisp.innerHTML = '<option value="">— Select —</option>' + genericOptions(vehicles, 'reg', 'reg');
  bindVehicleAutofill('#form-receive', 'rec-vehicle');
  bindVehicleAutofill('#form-dispatch', 'd-vehicle');
  setDefaults();
}

function bindVehicleAutofill(formSel, vehId) {
  const form = $(formSel);
  const veh = form.querySelector('#' + vehId);
  veh.addEventListener('change', () => {
    const v = vehicles.find(x => x.reg === veh.value);
    const trans = form.querySelector('select[name=transporter_id]');
    if (v && v.transporter_id && trans) trans.value = v.transporter_id;
  });
}

function setDefaults() {
  const now = new Date();
  const d = now.toISOString().slice(0, 10);
  const t = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $$('input[name$=_date]').forEach(i => { if (!i.value) i.value = d; });
  $$('input[name$=_time]').forEach(i => { if (!i.value) i.value = t; });
}

// product → tank filter (receive & dispatch)
$$('select[name=product_id]').forEach(prodSel => {
  prodSel.addEventListener('change', () => {
    const form = prodSel.closest('form');
    const tankSel = form.querySelector('select[name=tank_id]');
    tankSel.innerHTML = '<option value="">— Select tank —</option>' +
      tanksForProduct(Number(prodSel.value)).map(t => `<option value="${t.id}">${esc(t.code)}</option>`).join('');
  });
});

// meter open/close → qty
function bindQty(formSel, openId, closeId, qtyId) {
  const form = $(formSel);
  if (!form) return;
  const op = form.querySelector('#' + openId), cl = form.querySelector('#' + closeId);
  const out = form.querySelector('#' + qtyId);
  if (!op || !cl || !out) return;
  const upd = () => {
    const a = parseFloat(op.value) || 0, b = parseFloat(cl.value) || 0;
    out.textContent = fmtQty(Math.max(b - a, 0), 'L');
  };
  op.addEventListener('input', upd);
  cl.addEventListener('input', upd);
}
bindQty('#form-receive', 'r-meter-opening', 'r-meter-closing', 'recv-qty');
bindQty('#form-dispatch', 'd-meter-opening', 'd-meter-closing', 'd-qty');

// ---------------------------------------------------------------- photo capture
$$('.photo-widget').forEach(widget => {
  const box = widget.querySelector('.photo-box');
  const key = widget.dataset.target === 'photo-receive' ? 'receive' : 'dispatch';
  const emptyHtml = box.querySelector('.photo-empty') ? box.querySelector('.photo-empty').outerHTML : box.innerHTML;
  box.dataset.emptyHtml = emptyHtml;
  widget.querySelectorAll('label[for]').forEach(l => {
    const inp = document.getElementById(l.htmlFor);
    l.addEventListener('click', () => { if (inp) inp.value = ''; });
  });
  widget.querySelectorAll('.photo-input').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const dataUrl = await downscale(file);
        state.photos[key] = dataUrl;
        box.innerHTML = `<img src="${dataUrl}" alt="captured document">
          <button type="button" class="photo-remove" title="Remove photo">&#10005;</button>`;
        box.querySelector('.photo-remove').addEventListener('click', e => {
          e.stopPropagation();
          state.photos[key] = null;
          box.innerHTML = emptyHtml;
        });
      } catch (_) { alert('Could not read that image. Try another.'); }
    });
  });
});

function downscale(file, maxDim = 1600, quality = 0.82) {
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

// ---------------------------------------------------------------- tabs
function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#view-receive').classList.toggle('hidden', tab !== 'receive');
  $('#view-dispatch').classList.toggle('hidden', tab !== 'dispatch');
}
$$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ---------------------------------------------------------------- submit
function collect(formSel, key) {
  const f = new FormData($(formSel));
  const body = Object.fromEntries(f.entries());
  const op = parseFloat(body.meter_opening), cl = parseFloat(body.meter_closing);
  let qty = (isFinite(op) && isFinite(cl)) ? cl - op : 0;
  if (!(qty > 0)) qty = Number(body.loaded_litres || 0);
  body.qty = qty;
  const date = body[`${key}_date`] || dtNow().slice(0, 10);
  const time = body[`${key}_time`] || '00:00';
  body[`${key}_at`] = `${date}T${time}`;
  delete body[`${key}_date`];
  delete body[`${key}_time`];
  delete body.recv_qty;
  delete body.d_qty;
  body.photo = state.photos[key] || null;
  return body;
}

function setSaving(btn, on) {
  btn.disabled = on;
  btn.textContent = on ? 'Saving…' : btn.dataset.label;
}

function showErr(msg) {
  const strip = $('#err-strip');
  strip.textContent = msg;
  strip.classList.remove('hidden');
  clearTimeout(strip._t);
  strip._t = setTimeout(() => strip.classList.add('hidden'), 6000);
}

function validateForm(form) {
  if (form.checkValidity()) return true;
  const emptySelect = Array.from(form.querySelectorAll('select[required]')).find(s => s.options.length <= 1);
  if (emptySelect) {
    const label = emptySelect.closest('label');
    const name = label ? label.textContent.trim().replace(/\s+/g, ' ') : 'Select';
    showErr('No "' + name + '" options available. Add this reference data in the Stock System admin first, then sign out and back in.');
  } else {
    form.reportValidity();
    showErr('Please complete the highlighted fields before saving.');
  }
  return false;
}

async function submitReceive() {
  const form = $('#form-receive');
  if (!validateForm(form)) return;
  const btn = $('#btn-save-receive');
  setSaving(btn, true);
  try {
    const body = collect('#form-receive', 'received');
    const r = await api('/receipts', 'POST', body);
    showSuccess('Stock Received', r.receipt_no, 'receive', r.wa ? 'WhatsApp alert sent to group.' : 'WhatsApp alerts disabled — enable under WhatsApp Alerts.', r.warning);
    form.reset();
    state.photos.receive = null;
    resetPhoto('#photo-receive');
    setDefaults();
  } catch (err) { alert(err.message); }
  setSaving(btn, false);
}

async function submitDispatch() {
  const form = $('#form-dispatch');
  if (!validateForm(form)) return;
  const btn = $('#btn-save-dispatch');
  setSaving(btn, true);
  try {
    const body = collect('#form-dispatch', 'dispatched');
    const r = await api('/dispatches', 'POST', body);
    showSuccess('Stock Dispatched', r.dispatch_no, 'dispatch', r.wa ? 'WhatsApp alert sent to group.' : 'WhatsApp alerts disabled — enable under WhatsApp Alerts.', r.warning);
    form.reset();
    state.photos.dispatch = null;
    resetPhoto('#photo-dispatch');
    setDefaults();
  } catch (err) { alert(err.message); }
  setSaving(btn, false);
}

function resetPhoto(boxSel) {
  const box = $(boxSel);
  if (box && box.dataset.emptyHtml) box.innerHTML = box.dataset.emptyHtml;
}

function showSuccess(title, docNo, key, waMsg, warning) {
  $('#success-title').textContent = title;
  $('#success-doc').textContent = docNo;
  $('#success-wa').textContent = waMsg;
  $('#success-wa').style.color = warning ? 'var(--warn)' : 'var(--ok)';
  $('#btn-another').dataset.next = key;
  $('#success-overlay').classList.remove('hidden');
}

on('#btn-another', 'click', e => {
  $('#success-overlay').classList.add('hidden');
  const next = e.target.dataset.next === 'dispatch' ? 'dispatch' : 'receive';
  setTab(next);
});

on('#form-receive', 'submit', e => { e.preventDefault(); submitReceive(); });
on('#form-dispatch', 'submit', e => { e.preventDefault(); submitDispatch(); });

boot();