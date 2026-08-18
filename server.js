'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { db, hashPassword, makeSalt, now, nextDocNo, log } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_DAYS = 7;

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
  if (process.env.FORCE_HTTPS === 'true' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// ---------------------------------------------------------------- brute-force protection
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();
function rateLimitLogin(ip, username) {
  const key = `${ip}|${username || ''}`;
  const nowMs = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || nowMs - rec.resetAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, resetAt: nowMs + LOGIN_WINDOW_MS });
    return true;
  }
  rec.count++;
  return rec.count <= LOGIN_MAX_ATTEMPTS;
}
function clearLoginAttempts(ip, username) {
  loginAttempts.delete(`${ip}|${username || ''}`);
}

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}, 60 * 60 * 1000);
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, p) => {
  if (/\.(js|css|html)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
} }));

// ---------------------------------------------------------------- auth helpers
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, user.id, expires);
  return { token, expires };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const row = db.prepare(`
    SELECT s.token, u.id, u.username, u.full_name, u.role, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row) return res.status(401).json({ error: 'Invalid session' });
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  if (!row.active) return res.status(401).json({ error: 'Account disabled' });
  req.user = { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
  next();
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}

function bodyStr(v) {
  return v === undefined || v === null ? null : String(v).trim() || null;
}

function pwOk(pw) {
  return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

const PW_MSG = 'Password must be at least 8 characters and contain both letters and numbers';

{
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  if (admin && admin.password_hash === hashPassword('admin123', admin.salt)) {
    console.warn('WARNING: Default admin password is in use. Change it immediately via Change password.');
  }
}

// ---------------------------------------------------------------- auth routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimitLogin(ip, username)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || user.password_hash !== hashPassword(password, user.salt)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!user.active) return res.status(401).json({ error: 'Account disabled' });
  clearLoginAttempts(ip, username);
  const session = createSession(user);
  log(user, 'LOGIN', 'session', user.id, { username: user.username });
  res.json({ token: session.token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
});

app.post('/api/logout', auth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  log(req.user, 'LOGOUT', 'session', req.user.id, {});
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---------------------------------------------------------------- dashboard
app.get('/api/dashboard', auth, (req, res) => {
  const totals = db.prepare(`
    SELECT COUNT(*) AS tank_count,
           COALESCE(SUM(current_qty),0) AS total_qty,
           COALESCE(SUM(CASE WHEN product_id IS NULL THEN 1 ELSE 0 END),0) AS empty_tanks
    FROM tanks`).get();

  const receivedOverview = db.prepare(`
    SELECT COUNT(*) AS docs,
           COALESCE(SUM(qty),0) AS litres,
           COALESCE(SUM(CASE WHEN date(received_at)=date('now','localtime') THEN qty ELSE 0 END),0) AS today_litres
    FROM receipts`).get();

  const dispatchedOverview = db.prepare(`
    SELECT COUNT(*) AS docs,
           COALESCE(SUM(qty),0) AS litres,
           COALESCE(SUM(CASE WHEN date(dispatched_at)=date('now','localtime') THEN qty ELSE 0 END),0) AS today_litres
    FROM dispatches`).get();

  const tankVolumes = db.prepare(`
    SELECT t.code, t.name, p.name AS product, t.current_qty, t.capacity, t.min_level, t.max_level,
           CASE WHEN t.current_qty < t.min_level THEN 'low'
                WHEN t.max_level IS NOT NULL AND t.current_qty > t.max_level THEN 'high'
                ELSE 'ok' END AS level,
           ROUND(CASE WHEN t.capacity > 0 THEN (t.current_qty / t.capacity) * 100 ELSE 0 END, 1) AS fill_pct
    FROM tanks t LEFT JOIN products p ON p.id = t.product_id
    ORDER BY t.code`).all();

  const alerts = db.prepare(`
    SELECT t.code, t.name, p.name AS product, t.current_qty, t.min_level, t.max_level, t.capacity,
           CASE WHEN t.current_qty < t.min_level THEN 'low'
                WHEN t.max_level IS NOT NULL AND t.current_qty > t.max_level THEN 'high'
                ELSE 'ok' END AS level
    FROM tanks t LEFT JOIN products p ON p.id = t.product_id
    WHERE t.status = 'active'
    ORDER BY level DESC, t.code`).all()
    .filter(a => a.level !== 'ok');

  const recent = db.prepare(`
    SELECT 'receipt' AS type, id, receipt_no AS doc, qty, unit, received_at AS ts, created_by
    FROM receipts
    UNION ALL
    SELECT 'dispatch', id, dispatch_no, qty, unit, dispatched_at, created_by FROM dispatches
    UNION ALL
    SELECT 'transfer', id, '', qty, unit, transferred_at, created_by FROM transfers
    UNION ALL
    SELECT 'adjustment', id, '', qty, unit, adjusted_at, created_by FROM adjustments
    ORDER BY ts DESC, id DESC LIMIT 12`).all();

  const recentRich = recent.map(r => {
    const creator = r.created_by ? db.prepare('SELECT full_name FROM users WHERE id=?').get(r.created_by) : null;
    return { ...r, operator: creator ? creator.full_name : '' };
  });

  const movementsToday = db.prepare(`
    SELECT (SELECT COUNT(*) FROM receipts WHERE date(received_at)=date('now','localtime')) +
           (SELECT COUNT(*) FROM dispatches WHERE date(dispatched_at)=date('now','localtime')) AS c`).get().c;

  res.json({ totals, tankVolumes, received: receivedOverview, dispatched: dispatchedOverview, recent: recentRich, movementsToday });
});

// ---------------------------------------------------------------- products
app.get('/api/products', auth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM products ORDER BY name`).all());
});

app.post('/api/products', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Product name required' });
  const r = db.prepare(`INSERT INTO products (name, category, unit, density, min_stock, notes)
    VALUES (?,?,?,?,?,?)`)
    .run(name, bodyStr(b.category), bodyStr(b.unit) || 'litres', b.density ?? null, b.min_stock ?? 0, bodyStr(b.notes));
  log(req.user, 'CREATE', 'product', r.lastInsertRowid, b);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/products/:id', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Product name required' });
  db.prepare(`UPDATE products SET name=?, category=?, unit=?, density=?, min_stock=?, notes=? WHERE id=?`)
    .run(name, bodyStr(b.category), bodyStr(b.unit) || 'litres', b.density ?? null, b.min_stock ?? 0, bodyStr(b.notes), req.params.id);
  log(req.user, 'UPDATE', 'product', +req.params.id, b);
  res.json({ ok: true });
});

app.delete('/api/products/:id', auth, role('Administrator'), (req, res) => {
  const inUse = db.prepare('SELECT id FROM tanks WHERE product_id=? LIMIT 1').get(req.params.id);
  if (inUse) return res.status(400).json({ error: 'Product is assigned to a tank and cannot be deleted' });
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  log(req.user, 'DELETE', 'product', +req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- suppliers
app.get('/api/suppliers', auth, (req, res) => res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all()));
app.post('/api/suppliers', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Supplier name required' });
  const r = db.prepare(`INSERT INTO suppliers (name, contact_person, phone, email, address, notes)
    VALUES (?,?,?,?,?,?)`).run(name, bodyStr(b.contact_person), bodyStr(b.phone), bodyStr(b.email), bodyStr(b.address), bodyStr(b.notes));
  log(req.user, 'CREATE', 'supplier', r.lastInsertRowid, b);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/suppliers/:id', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Supplier name required' });
  db.prepare(`UPDATE suppliers SET name=?, contact_person=?, phone=?, email=?, address=?, notes=? WHERE id=?`)
    .run(name, bodyStr(b.contact_person), bodyStr(b.phone), bodyStr(b.email), bodyStr(b.address), bodyStr(b.notes), req.params.id);
  log(req.user, 'UPDATE', 'supplier', +req.params.id, b);
  res.json({ ok: true });
});
app.delete('/api/suppliers/:id', auth, role('Administrator'), (req, res) => {
  const inUse = db.prepare('SELECT id FROM receipts WHERE supplier_id=? LIMIT 1').get(req.params.id);
  if (inUse) return res.status(400).json({ error: 'Supplier has receipt history and cannot be deleted' });
  db.prepare('DELETE FROM suppliers WHERE id=?').run(req.params.id);
  log(req.user, 'DELETE', 'supplier', +req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- customers
app.get('/api/customers', auth, (req, res) => res.json(db.prepare('SELECT * FROM customers ORDER BY name').all()));
app.post('/api/customers', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Customer name required' });
  const r = db.prepare(`INSERT INTO customers (name, contact_person, phone, email, address, notes)
    VALUES (?,?,?,?,?,?)`).run(name, bodyStr(b.contact_person), bodyStr(b.phone), bodyStr(b.email), bodyStr(b.address), bodyStr(b.notes));
  log(req.user, 'CREATE', 'customer', r.lastInsertRowid, b);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/customers/:id', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Customer name required' });
  db.prepare(`UPDATE customers SET name=?, contact_person=?, phone=?, email=?, address=?, notes=? WHERE id=?`)
    .run(name, bodyStr(b.contact_person), bodyStr(b.phone), bodyStr(b.email), bodyStr(b.address), bodyStr(b.notes), req.params.id);
  log(req.user, 'UPDATE', 'customer', +req.params.id, b);
  res.json({ ok: true });
});
app.delete('/api/customers/:id', auth, role('Administrator'), (req, res) => {
  const inUse = db.prepare('SELECT id FROM dispatches WHERE customer_id=? LIMIT 1').get(req.params.id);
  if (inUse) return res.status(400).json({ error: 'Customer has dispatch history and cannot be deleted' });
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  log(req.user, 'DELETE', 'customer', +req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- tanks
function tankWithProduct(id) {
  return db.prepare(`
    SELECT t.*, p.name AS product, p.unit AS product_unit
    FROM tanks t LEFT JOIN products p ON p.id = t.product_id WHERE t.id=?`).get(id);
}

app.get('/api/tanks', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, p.name AS product, p.unit AS product_unit
    FROM tanks t LEFT JOIN products p ON p.id = t.product_id
    ORDER BY t.code`).all());
});

app.post('/api/tanks', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const code = bodyStr(b.code);
  if (!code) return res.status(400).json({ error: 'Tank code required' });
  if (b.product_id && !db.prepare('SELECT id FROM products WHERE id=?').get(b.product_id))
    return res.status(400).json({ error: 'Invalid product' });
  const r = db.prepare(`INSERT INTO tanks (code, name, product_id, capacity, current_qty, min_level, max_level, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(code, bodyStr(b.name) || code, b.product_id ?? null, b.capacity ?? null, b.current_qty ?? 0,
         b.min_level ?? 0, b.max_level ?? null, bodyStr(b.status) || 'active', bodyStr(b.notes));
  log(req.user, 'CREATE', 'tank', r.lastInsertRowid, b);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/tanks/:id', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const code = bodyStr(b.code);
  if (!code) return res.status(400).json({ error: 'Tank code required' });
  db.prepare(`UPDATE tanks SET code=?, name=?, product_id=?, capacity=?, min_level=?, max_level=?, status=?, notes=? WHERE id=?`)
    .run(code, bodyStr(b.name) || code, b.product_id ?? null, b.capacity ?? null,
         b.min_level ?? 0, b.max_level ?? null, bodyStr(b.status) || 'active', bodyStr(b.notes), req.params.id);
  log(req.user, 'UPDATE', 'tank', +req.params.id, b);
  res.json({ ok: true });
});

app.delete('/api/tanks/:id', auth, role('Administrator'), (req, res) => {
  const hasMv = db.prepare(`
    SELECT (SELECT COUNT(*) FROM receipts WHERE tank_id=?) +
           (SELECT COUNT(*) FROM dispatches WHERE tank_id=?) +
           (SELECT COUNT(*) FROM transfers WHERE from_tank_id=? OR to_tank_id=?) +
           (SELECT COUNT(*) FROM adjustments WHERE tank_id=?) AS c`)
    .get(req.params.id, req.params.id, req.params.id, req.params.id, req.params.id).c;
  if (hasMv > 0) return res.status(400).json({ error: 'Tank has movement history and cannot be deleted' });
  db.prepare('DELETE FROM tanks WHERE id=?').run(req.params.id);
  log(req.user, 'DELETE', 'tank', +req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- transporters
app.get('/api/transporters', auth, (req, res) => res.json(db.prepare('SELECT * FROM transporters ORDER BY name').all()));
app.post('/api/transporters', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Transporter name required' });
  const r = db.prepare(`INSERT INTO transporters (name, contact_person, phone, notes)
    VALUES (?,?,?,?)`).run(name, bodyStr(b.contact_person), bodyStr(b.phone), bodyStr(b.notes));
  log(req.user, 'CREATE', 'transporter', r.lastInsertRowid, b);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/transporters/:id', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Transporter name required' });
  db.prepare(`UPDATE transporters SET name=?, contact_person=?, phone=?, notes=? WHERE id=?`)
    .run(name, bodyStr(b.contact_person), bodyStr(b.phone), bodyStr(b.notes), req.params.id);
  log(req.user, 'UPDATE', 'transporter', +req.params.id, b);
  res.json({ ok: true });
});
app.delete('/api/transporters/:id', auth, role('Administrator'), (req, res) => {
  const inUse = db.prepare('SELECT id FROM receipts WHERE transporter_id=? LIMIT 1').get(req.params.id);
  if (inUse) return res.status(400).json({ error: 'Transporter is linked to a receipt and cannot be deleted' });
  const drv = db.prepare('SELECT id FROM drivers WHERE transporter_id=? LIMIT 1').get(req.params.id);
  if (drv) return res.status(400).json({ error: 'Transporter is linked to a driver and cannot be deleted' });
  db.prepare('DELETE FROM transporters WHERE id=?').run(req.params.id);
  log(req.user, 'DELETE', 'transporter', +req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- drivers
app.get('/api/drivers', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT d.*, t.name AS transporter
    FROM drivers d LEFT JOIN transporters t ON t.id = d.transporter_id
    ORDER BY d.name`).all());
});
app.post('/api/drivers', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Driver name required' });
  const r = db.prepare(`INSERT INTO drivers (name, phone, transporter_id, notes)
    VALUES (?,?,?,?)`).run(name, bodyStr(b.phone), b.transporter_id ?? null, bodyStr(b.notes));
  log(req.user, 'CREATE', 'driver', r.lastInsertRowid, b);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/drivers/:id', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const name = bodyStr(b.name);
  if (!name) return res.status(400).json({ error: 'Driver name required' });
  db.prepare(`UPDATE drivers SET name=?, phone=?, transporter_id=?, notes=? WHERE id=?`)
    .run(name, bodyStr(b.phone), b.transporter_id ?? null, bodyStr(b.notes), req.params.id);
  log(req.user, 'UPDATE', 'driver', +req.params.id, b);
  res.json({ ok: true });
});
app.delete('/api/drivers/:id', auth, role('Administrator'), (req, res) => {
  db.prepare('DELETE FROM drivers WHERE id=?').run(req.params.id);
  log(req.user, 'DELETE', 'driver', +req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------- receipts (stock received)
app.get('/api/receipts', auth, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.from) { where.push('date(r.received_at) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('date(r.received_at) <= ?'); args.push(req.query.to); }
  if (req.query.product_id) { where.push('r.product_id = ?'); args.push(req.query.product_id); }
  if (req.query.tank_id) { where.push('r.tank_id = ?'); args.push(req.query.tank_id); }
  if (req.query.q) {
    where.push('(r.receipt_no LIKE ? OR r.vehicle_reg LIKE ? OR r.waybill_no LIKE ? OR r.driver_name LIKE ? OR s.name LIKE ?)');
    const like = `%${req.query.q}%`;
    args.push(like, like, like, like, like);
  }
  const sql = `
    SELECT r.*, p.name AS product, p.unit AS product_unit, t.code AS tank, s.name AS supplier,
           tr.name AS transporter, u.full_name AS operator
    FROM receipts r
    JOIN products p ON p.id = r.product_id
    JOIN tanks t ON t.id = r.tank_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN transporters tr ON tr.id = r.transporter_id
    LEFT JOIN users u ON u.id = r.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.received_at DESC, r.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/receipts', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const product_id = Number(b.product_id);
  const tank_id = Number(b.tank_id);
  if (!product_id || !tank_id) return res.status(400).json({ error: 'Product and tank required' });
  const loaded = b.loaded_litres !== undefined && b.loaded_litres !== '' && b.loaded_litres !== null ? Number(b.loaded_litres) : null;
  const mOpen = b.meter_opening !== undefined && b.meter_opening !== '' && b.meter_opening !== null ? Number(b.meter_opening) : null;
  const mClose = b.meter_closing !== undefined && b.meter_closing !== '' && b.meter_closing !== null ? Number(b.meter_closing) : null;
  let qty = Number(b.qty);
  if (mOpen != null && mClose != null) {
    qty = mClose - mOpen;
    if (!(qty > 0)) return res.status(400).json({ error: 'Meter closing reading must be greater than opening reading' });
  }
  if (!(qty > 0)) return res.status(400).json({ error: 'Received quantity must be greater than zero' });
  const tank = tankWithProduct(tank_id);
  if (!tank) return res.status(400).json({ error: 'Tank not found' });
  if (tank.product_id !== product_id) return res.status(400).json({ error: `Product does not match tank product (${tank.product})` });
  const unit = bodyStr(b.unit) || tank.product_unit || 'litres';
  const receipt_no = nextDocNo('GRV-', 'receipts');
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO receipts (receipt_no, product_id, tank_id, supplier_id, transporter_id, qty, unit, loaded_litres, meter_opening, meter_closing, vehicle_reg, driver_name, waybill_no, source_ref, received_at, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receipt_no, product_id, tank_id, b.supplier_id ?? null, b.transporter_id ?? null, qty, unit, loaded, mOpen, mClose,
           bodyStr(b.vehicle_reg), bodyStr(b.driver_name), bodyStr(b.waybill_no), bodyStr(b.source_ref),
           bodyStr(b.received_at) || now(), bodyStr(b.notes), req.user.id);
    db.prepare('UPDATE tanks SET current_qty = current_qty + ? WHERE id=?').run(qty, tank_id);
    db.exec('COMMIT');
    log(req.user, 'CREATE', 'receipt', r.lastInsertRowid, b);
    const over = tank.max_level != null && (tank.current_qty + qty) > tank.max_level;
    res.json({ id: r.lastInsertRowid, receipt_no, warning: over ? `Tank ${tank.code} is now above its max level (${tank.max_level} ${unit}).` : null });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

app.get('/api/receipts/:id', auth, (req, res) => {
  const r = db.prepare(`SELECT * FROM receipts WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// ---------------------------------------------------------------- dispatches (stock dispatched)
app.get('/api/dispatches', auth, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.from) { where.push('date(d.dispatched_at) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('date(d.dispatched_at) <= ?'); args.push(req.query.to); }
  if (req.query.product_id) { where.push('d.product_id = ?'); args.push(req.query.product_id); }
  if (req.query.tank_id) { where.push('d.tank_id = ?'); args.push(req.query.tank_id); }
  if (req.query.customer_id) { where.push('d.customer_id = ?'); args.push(req.query.customer_id); }
  if (req.query.q) {
    where.push('(d.dispatch_no LIKE ? OR d.vehicle_reg LIKE ? OR d.delivery_no LIKE ? OR d.driver_name LIKE ? OR c.name LIKE ?)');
    const like = `%${req.query.q}%`;
    args.push(like, like, like, like, like);
  }
  const sql = `
    SELECT d.*, p.name AS product, p.unit AS product_unit, t.code AS tank, c.name AS customer,
           tr.name AS transporter, u.full_name AS operator
    FROM dispatches d
    JOIN products p ON p.id = d.product_id
    JOIN tanks t ON t.id = d.tank_id
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN transporters tr ON tr.id = d.transporter_id
    LEFT JOIN users u ON u.id = d.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/dispatches', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const mOpen = b.meter_opening !== undefined && b.meter_opening !== '' && b.meter_opening !== null ? Number(b.meter_opening) : null;
  const mClose = b.meter_closing !== undefined && b.meter_closing !== '' && b.meter_closing !== null ? Number(b.meter_closing) : null;
  let qty = Number(b.qty);
  if (mOpen != null && mClose != null) {
    qty = mClose - mOpen;
    if (!(qty > 0)) return res.status(400).json({ error: 'Meter closing reading must be greater than opening reading' });
  }
  const product_id = Number(b.product_id);
  const tank_id = Number(b.tank_id);
  if (!product_id || !tank_id) return res.status(400).json({ error: 'Product and tank required' });
  if (!(qty > 0)) return res.status(400).json({ error: 'Quantity must be greater than zero' });
  const tank = tankWithProduct(tank_id);
  if (!tank) return res.status(400).json({ error: 'Tank not found' });
  if (tank.product_id !== product_id) return res.status(400).json({ error: `Product does not match tank product (${tank.product})` });
  if (qty > tank.current_qty) return res.status(400).json({ error: `Insufficient stock in ${tank.code}. Available: ${tank.current_qty} ${tank.product_unit}.` });
  const unit = bodyStr(b.unit) || tank.product_unit || 'litres';
  const dispatch_no = nextDocNo('DEL-', 'dispatches');
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO dispatches (dispatch_no, product_id, tank_id, customer_id, transporter_id, qty, unit, meter_opening, meter_closing, vehicle_reg, driver_name, delivery_no, order_no, destination, dispatched_at, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(dispatch_no, product_id, tank_id, b.customer_id ?? null, b.transporter_id ?? null, qty, unit,
           mOpen, mClose,
           bodyStr(b.vehicle_reg), bodyStr(b.driver_name), bodyStr(b.delivery_no), bodyStr(b.order_no),
           bodyStr(b.destination), bodyStr(b.dispatched_at) || now(), bodyStr(b.notes), req.user.id);
    db.prepare('UPDATE tanks SET current_qty = current_qty - ? WHERE id=?').run(qty, tank_id);
    db.exec('COMMIT');
    log(req.user, 'CREATE', 'dispatch', r.lastInsertRowid, b);
    res.json({ id: r.lastInsertRowid, dispatch_no });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

app.get('/api/dispatches/:id', auth, (req, res) => {
  const r = db.prepare(`SELECT * FROM dispatches WHERE id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// ---------------------------------------------------------------- transfers
app.get('/api/transfers', auth, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.from) { where.push('date(tf.transferred_at) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('date(tf.transferred_at) <= ?'); args.push(req.query.to); }
  const sql = `
    SELECT tf.*, p.name AS product, p.unit AS product_unit,
           ft.code AS from_tank, tt.code AS to_tank, u.full_name AS operator
    FROM transfers tf
    JOIN products p ON p.id = tf.product_id
    JOIN tanks ft ON ft.id = tf.from_tank_id
    JOIN tanks tt ON tt.id = tf.to_tank_id
    LEFT JOIN users u ON u.id = tf.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY tf.transferred_at DESC, tf.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/transfers', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const qty = Number(b.qty);
  if (!b.from_tank_id || !b.to_tank_id) return res.status(400).json({ error: 'Both tanks required' });
  if (b.from_tank_id === b.to_tank_id) return res.status(400).json({ error: 'Cannot transfer into the same tank' });
  if (!(qty > 0)) return res.status(400).json({ error: 'Quantity must be greater than zero' });
  const from = tankWithProduct(b.from_tank_id);
  const to = tankWithProduct(b.to_tank_id);
  if (!from || !to) return res.status(400).json({ error: 'Tank not found' });
  if (!from.product_id || !to.product_id) return res.status(400).json({ error: 'Both tanks must have a product assigned' });
  if (from.product_id !== to.product_id) return res.status(400).json({ error: 'Tanks hold different products - cannot transfer' });
  if (qty > from.current_qty) return res.status(400).json({ error: `Insufficient stock in ${from.code}. Available: ${from.current_qty} ${from.product_unit}.` });
  const unit = bodyStr(b.unit) || from.product_unit || 'litres';
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO transfers (from_tank_id, to_tank_id, product_id, qty, unit, transferred_at, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(b.from_tank_id, b.to_tank_id, from.product_id, qty, unit, bodyStr(b.transferred_at) || now(), bodyStr(b.notes), req.user.id);
    db.prepare('UPDATE tanks SET current_qty = current_qty - ? WHERE id=?').run(qty, b.from_tank_id);
    db.prepare('UPDATE tanks SET current_qty = current_qty + ? WHERE id=?').run(qty, b.to_tank_id);
    db.exec('COMMIT');
    log(req.user, 'CREATE', 'transfer', r.lastInsertRowid, b);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// ---------------------------------------------------------------- adjustments & dip readings
app.get('/api/adjustments', auth, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.from) { where.push('date(a.adjusted_at) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('date(a.adjusted_at) <= ?'); args.push(req.query.to); }
  const sql = `
    SELECT a.*, p.name AS product, p.unit AS product_unit, t.code AS tank, u.full_name AS operator
    FROM adjustments a
    JOIN products p ON p.id = a.product_id
    JOIN tanks t ON t.id = a.tank_id
    LEFT JOIN users u ON u.id = a.created_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.adjusted_at DESC, a.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/adjustments', auth, role('Administrator','Manager','Supervisor','Dispatcher'), (req, res) => {
  const b = req.body || {};
  const tank = tankWithProduct(b.tank_id);
  if (!tank) return res.status(400).json({ error: 'Tank not found' });
  if (!tank.product_id) return res.status(400).json({ error: 'Tank has no product assigned' });
  const unit = bodyStr(b.unit) || tank.product_unit || 'litres';
  const adjType = bodyStr(b.adj_type) || 'correction';
  const qty = Number(b.qty);

  db.exec('BEGIN');
  try {
    let storedQty, applied;
    if (adjType === 'gain' || adjType === 'loss') {
      if (!(qty > 0)) { db.exec('ROLLBACK'); return res.status(400).json({ error: 'For gain/loss, quantity must be greater than zero' }); }
      applied = adjType === 'gain' ? qty : -qty;
      storedQty = qty;
      if (tank.current_qty + applied < 0) { db.exec('ROLLBACK'); return res.status(400).json({ error: 'Adjustment would make tank stock negative' }); }
    } else {
      if (!(qty >= 0)) { db.exec('ROLLBACK'); return res.status(400).json({ error: 'Dip/correction quantity must be zero or more' }); }
      applied = qty - tank.current_qty;
      storedQty = qty;
    }
    const r = db.prepare(`INSERT INTO adjustments (tank_id, product_id, qty, unit, adj_type, dip_before, dip_after, reason, notes, adjusted_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.tank_id, tank.product_id, storedQty, unit, adjType,
           b.dip_before ?? null, b.dip_after ?? null, bodyStr(b.reason), bodyStr(b.notes),
           bodyStr(b.adjusted_at) || now(), req.user.id);
    db.prepare('UPDATE tanks SET current_qty = current_qty + ? WHERE id=?').run(applied, b.tank_id);
    db.exec('COMMIT');
    log(req.user, 'CREATE', 'adjustment', r.lastInsertRowid, b);
    res.json({ id: r.lastInsertRowid, applied });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// ---------------------------------------------------------------- stock & movement reports
app.get('/api/reports/stock', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.code, t.name, p.name AS product, p.unit AS unit, t.capacity,
           t.current_qty, t.min_level, t.max_level,
           CASE WHEN t.current_qty < t.min_level THEN 'LOW'
                WHEN t.max_level IS NOT NULL AND t.current_qty > t.max_level THEN 'HIGH'
                ELSE 'OK' END AS status,
           ROUND(CASE WHEN t.capacity > 0 THEN (t.current_qty / t.capacity) * 100 ELSE 0 END, 1) AS fill_pct
    FROM tanks t LEFT JOIN products p ON p.id = t.product_id
    ORDER BY t.code`).all();
  const totals = {
    litres: rows.reduce((s, r) => s + r.current_qty, 0),
    capacity: rows.reduce((s, r) => s + (r.capacity || 0), 0)
  };
  res.json({ rows, totals });
});

app.get('/api/reports/movements', auth, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.from) { where.push('date(m.ts) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('date(m.ts) <= ?'); args.push(req.query.to); }
  if (req.query.product_id) { where.push('m.product_id = ?'); args.push(req.query.product_id); }
  if (req.query.tank_id) { where.push('m.tank_id = ?'); args.push(req.query.tank_id); }
  if (req.query.type) { where.push('m.type = ?'); args.push(req.query.type); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sql = `
    SELECT * FROM (
      SELECT 'receipt' AS type, r.id AS ref_id, r.receipt_no AS doc_no, r.product_id, r.tank_id,
             p.name AS product, t.code AS tank, r.qty, r.unit, 'IN' AS direction,
             r.supplier_id, s.name AS party, r.vehicle_reg, r.driver_name, r.received_at AS ts,
             r.notes, u.full_name AS operator
      FROM receipts r JOIN products p ON p.id=r.product_id JOIN tanks t ON t.id=r.tank_id
           LEFT JOIN suppliers s ON s.id=r.supplier_id LEFT JOIN users u ON u.id=r.created_by
      UNION ALL
      SELECT 'dispatch', d.id, d.dispatch_no, d.product_id, d.tank_id,
             p.name, t.code, d.qty, d.unit, 'OUT',
             NULL, c.name, d.vehicle_reg, d.driver_name, d.dispatched_at, d.notes, u.full_name
      FROM dispatches d JOIN products p ON p.id=d.product_id JOIN tanks t ON t.id=d.tank_id
           LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN users u ON u.id=d.created_by
      UNION ALL
      SELECT 'transfer_out', tf.id, 'TRF-' || tf.id, tf.product_id, tf.from_tank_id,
             p.name, ft.code, tf.qty, tf.unit, 'OUT',
             NULL, 'Transfer to ' || tt.code, NULL, NULL, tf.transferred_at, tf.notes, u.full_name
      FROM transfers tf JOIN products p ON p.id=tf.product_id JOIN tanks ft ON ft.id=tf.from_tank_id
           JOIN tanks tt ON tt.id=tf.to_tank_id LEFT JOIN users u ON u.id=tf.created_by
      UNION ALL
      SELECT 'transfer_in', tf.id, 'TRF-' || tf.id, tf.product_id, tf.to_tank_id,
             p.name, tt.code, tf.qty, tf.unit, 'IN',
             NULL, 'Transfer from ' || ft.code, NULL, NULL, tf.transferred_at, tf.notes, u.full_name
      FROM transfers tf JOIN products p ON p.id=tf.product_id JOIN tanks tt ON tt.id=tf.to_tank_id
           JOIN tanks ft ON ft.id=tf.from_tank_id LEFT JOIN users u ON u.id=tf.created_by
      UNION ALL
      SELECT 'adjustment', a.id, 'ADJ-' || a.id, a.product_id, a.tank_id,
             p.name, t.code, a.qty, a.unit,
             CASE WHEN a.adj_type IN ('loss','correction','dip_reading') AND a.qty < t.current_qty THEN 'ADJ' ELSE 'ADJ' END,
             NULL, a.adj_type, NULL, NULL, a.adjusted_at, a.notes, u.full_name
      FROM adjustments a JOIN products p ON p.id=a.product_id JOIN tanks t ON t.id=a.tank_id
           LEFT JOIN users u ON u.id=a.created_by
    ) m ${whereSql}
    ORDER BY m.ts DESC, m.ref_id DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...args));
});

// ---------------------------------------------------------------- users & audit (admin)
app.get('/api/users', auth, role('Administrator'), (req, res) => {
  res.json(db.prepare(`SELECT id, username, full_name, role, active, created_at FROM users ORDER BY full_name`).all());
});

app.post('/api/users', auth, role('Administrator'), (req, res) => {
  const b = req.body || {};
  const username = bodyStr(b.username);
  const password = bodyStr(b.password);
  const full_name = bodyStr(b.full_name);
  const role_ = bodyStr(b.role) || 'Clerk';
  if (!username || !full_name || !password) return res.status(400).json({ error: 'Username, full name and password required' });
  if (!pwOk(password)) return res.status(400).json({ error: PW_MSG });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(400).json({ error: 'Username already exists' });
  if (!['Administrator','Manager','Supervisor','Dispatcher','Clerk'].includes(role_)) return res.status(400).json({ error: 'Invalid role' });
  const salt = makeSalt();
  const r = db.prepare(`INSERT INTO users (username, password_hash, salt, full_name, role) VALUES (?,?,?,?,?)`)
    .run(username, hashPassword(password, salt), salt, full_name, role_);
  log(req.user, 'CREATE', 'user', r.lastInsertRowid, { username, full_name, role: role_ });
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/users/:id', auth, role('Administrator'), (req, res) => {
  const b = req.body || {};
  const full_name = bodyStr(b.full_name);
  const role_ = bodyStr(b.role);
  const active = b.active === undefined ? 1 : (b.active ? 1 : 0);
  if (!full_name) return res.status(400).json({ error: 'Full name required' });
  if (!['Administrator','Manager','Supervisor','Dispatcher','Clerk'].includes(role_)) return res.status(400).json({ error: 'Invalid role' });
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id && active === 0) return res.status(400).json({ error: 'You cannot disable your own account' });
  db.prepare('UPDATE users SET full_name=?, role=?, active=? WHERE id=?').run(full_name, role_, active, req.params.id);
  log(req.user, 'UPDATE', 'user', +req.params.id, { full_name, role: role_, active });
  res.json({ ok: true });
});

app.put('/api/users/:id/password', auth, role('Administrator'), (req, res) => {
  const b = req.body || {};
  const password = bodyStr(b.password);
  if (!pwOk(password)) return res.status(400).json({ error: PW_MSG });
  const salt = makeSalt();
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(password, salt), salt, req.params.id);
  log(req.user, 'UPDATE', 'user_password', +req.params.id, {});
  res.json({ ok: true });
});

app.put('/api/me/password', auth, (req, res) => {
  const b = req.body || {};
  const oldPw = bodyStr(b.old_password);
  const newPw = bodyStr(b.new_password);
  if (!oldPw || !newPw) return res.status(400).json({ error: 'Current and new password required' });
  if (!pwOk(newPw)) return res.status(400).json({ error: PW_MSG });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (user.password_hash !== hashPassword(oldPw, user.salt)) return res.status(400).json({ error: 'Current password is incorrect' });
  const salt = makeSalt();
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(newPw, salt), salt, req.user.id);
  log(req.user, 'UPDATE', 'own_password', req.user.id, {});
  res.json({ ok: true });
});

app.get('/api/audit', auth, role('Administrator'), (req, res) => {
  const where = [];
  const args = [];
  if (req.query.from) { where.push('date(a.created_at) >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('date(a.created_at) <= ?'); args.push(req.query.to); }
  if (req.query.q) { where.push('(a.username LIKE ? OR a.action LIKE ? OR a.entity LIKE ?)'); const like = `%${req.query.q}%`; args.push(like, like, like); }
  const sql = `
    SELECT a.* FROM audit_log a
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.created_at DESC, a.id DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...args));
});

// ---------------------------------------------------------------- settings
app.get('/api/settings', auth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
app.put('/api/settings', auth, role('Administrator'), (req, res) => {
  const { facility_name } = req.body || {};
  if (facility_name !== undefined) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('facility_name', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(facility_name));
  }
  log(req.user, 'UPDATE', 'settings', null, { facility_name });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- error handling
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Witbank Tank Terminals stock system running on http://0.0.0.0:${PORT}`);
  console.log(`On this PC:     http://localhost:${PORT}`);
});