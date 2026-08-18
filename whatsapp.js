'use strict';

const { db } = require('./db');

const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function setting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function getConfig() {
  return {
    enabled: setting('wa_enabled') === '1',
    phone_number_id: setting('wa_phone_number_id') || '',
    access_token: setting('wa_access_token') || '',
    recipient: setting('wa_recipient') || '',
    templateReceived: setting('wa_template_received') || 'stock_received',
    templateDispatch: setting('wa_template_dispatch') || 'stock_dispatched',
    language: setting('wa_language') || 'en_US'
  };
}

async function sendTemplate(to, template, parameters) {
  const cfg = getConfig();
  if (!cfg.enabled) return { skipped: 'WhatsApp alerts are disabled' };
  if (!cfg.phone_number_id || !cfg.access_token) return { skipped: 'WhatsApp not configured (missing phone number id or token)' };
  if (!to) return { skipped: 'No recipient number configured' };

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: cfg.language },
      components: [{ type: 'body', parameters }]
    }
  };

  let res;
  try {
    res = await fetch(`${GRAPH_BASE}/${cfg.phone_number_id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.access_token}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('WhatsApp network error:', err.message);
    return { error: { message: err.message } };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('WhatsApp send failed:', res.status, JSON.stringify(data));
    return { error: data.error || { message: `HTTP ${res.status}` } };
  }
  return { ok: true, id: (data.messages && data.messages[0] && data.messages[0].id) || null };
}

function logWhatsApp(action, entity, docNo, result) {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, username, action, entity, entity_id, details) VALUES (NULL, ?, ?, ?, ?, ?)'
    ).run('whatsapp', action, entity, docNo, JSON.stringify(result));
  } catch (e) {
    console.error('WhatsApp audit log failed:', e.message);
  }
}

// Stock received: template body expects {{1}} receipt no, {{2}} product, {{3}} qty, {{4}} tank
async function notifyStockReceived(r) {
  const cfg = getConfig();
  const result = await sendTemplate(cfg.recipient, cfg.templateReceived, [
    { type: 'text', text: String(r.receipt_no || '') },
    { type: 'text', text: String(r.product || '') },
    { type: 'text', text: String(r.qty != null ? r.qty : '') + (r.unit ? ' ' + r.unit : '') },
    { type: 'text', text: String(r.tank || '') }
  ]);
  logWhatsApp('STOCK_RECEIVED', 'receipt', r.receipt_no, result);
  return result;
}

// Stock dispatched: template body expects {{1}} dispatch no, {{2}} product, {{3}} qty, {{4}} tank, {{5}} customer
async function notifyStockDispatched(r) {
  const cfg = getConfig();
  const result = await sendTemplate(cfg.recipient, cfg.templateDispatch, [
    { type: 'text', text: String(r.dispatch_no || '') },
    { type: 'text', text: String(r.product || '') },
    { type: 'text', text: String(r.qty != null ? r.qty : '') + (r.unit ? ' ' + r.unit : '') },
    { type: 'text', text: String(r.tank || '') },
    { type: 'text', text: String(r.customer || '') }
  ]);
  logWhatsApp('STOCK_DISPATCHED', 'dispatch', r.dispatch_no, result);
  return result;
}

module.exports = { getConfig, sendTemplate, notifyStockReceived, notifyStockDispatched };