'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wtt.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'Clerk' CHECK (role IN ('Administrator','Manager','Supervisor','Dispatcher','Clerk')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT,
  unit        TEXT NOT NULL DEFAULT 'litres',
  density     REAL,
  min_stock   REAL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tanks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT,
  product_id     INTEGER REFERENCES products(id),
  capacity       REAL,
  current_qty    REAL NOT NULL DEFAULT 0,
  min_level      REAL DEFAULT 0,
  max_level      REAL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance','offline')),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no   TEXT NOT NULL UNIQUE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  tank_id      INTEGER NOT NULL REFERENCES tanks(id),
  supplier_id  INTEGER REFERENCES suppliers(id),
  qty          REAL NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'litres',
  loaded_litres REAL,
  meter_opening REAL,
  meter_closing REAL,
  vehicle_reg  TEXT,
  driver_name  TEXT,
  waybill_no   TEXT,
  source_ref   TEXT,
  received_at  TEXT NOT NULL,
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dispatches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_no  TEXT NOT NULL UNIQUE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  tank_id      INTEGER NOT NULL REFERENCES tanks(id),
  customer_id  INTEGER REFERENCES customers(id),
  qty          REAL NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'litres',
  vehicle_reg  TEXT,
  driver_name  TEXT,
  delivery_no  TEXT,
  order_no     TEXT,
  destination  TEXT,
  dispatched_at TEXT NOT NULL,
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS transfers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_tank_id   INTEGER NOT NULL REFERENCES tanks(id),
  to_tank_id     INTEGER NOT NULL REFERENCES tanks(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  qty            REAL NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'litres',
  transferred_at TEXT NOT NULL,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS adjustments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_id        INTEGER NOT NULL REFERENCES tanks(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  qty            REAL NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'litres',
  adj_type       TEXT NOT NULL DEFAULT 'correction' CHECK (adj_type IN ('gain','loss','correction','dip_reading')),
  dip_before     REAL,
  dip_after      REAL,
  reason         TEXT,
  notes          TEXT,
  adjusted_at    TEXT NOT NULL,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  username   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS transporters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  contact_person TEXT,
  phone       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  phone          TEXT,
  transporter_id INTEGER REFERENCES transporters(id),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ---------------------------------------------------------------- migrations
const receiptsCols = db.prepare('PRAGMA table_info(receipts)').all().map(c => c.name);
const recMigrations = [
  ['loaded_litres', 'REAL'],
  ['meter_opening', 'REAL'],
  ['meter_closing', 'REAL'],
  ['transporter_id', 'INTEGER']
];
for (const [name, ddl] of recMigrations) {
  if (!receiptsCols.includes(name)) db.exec(`ALTER TABLE receipts ADD COLUMN ${name} ${ddl}`);
}
const dispatchesCols = db.prepare('PRAGMA table_info(dispatches)').all().map(c => c.name);
if (!dispatchesCols.includes('transporter_id')) {
  db.exec('ALTER TABLE dispatches ADD COLUMN transporter_id INTEGER');
}
if (!dispatchesCols.includes('meter_opening')) {
  db.exec('ALTER TABLE dispatches ADD COLUMN meter_opening REAL');
}
if (!dispatchesCols.includes('meter_closing')) {
  db.exec('ALTER TABLE dispatches ADD COLUMN meter_closing REAL');
}

// ---------------------------------------------------------------- transporter seed
if (db.prepare('SELECT COUNT(*) AS c FROM transporters').get().c === 0) {
  db.exec(`
    INSERT INTO transporters (name, contact_person, phone, notes) VALUES
      ('Interstate Tankers', 'Johan Botha', '013 690 1111', 'Bulk fuel haulage'),
      ('Unitrans Fuel & Chemical', 'Sibusiso Dlamini', '011 874 1200', 'National tanker fleet'),
      ('Astral Tanker Services', 'Pieter Nel', '013 656 7788', 'Regional tanker service'),
      ('Karoo Tankers', 'Thabo Mokoena', '051 432 2211', 'Long-distance haulage');
  `);
}

// ---------------------------------------------------------------- driver seed
if (db.prepare('SELECT COUNT(*) AS c FROM drivers').get().c === 0) {
  db.exec(`
    INSERT INTO drivers (name, phone, transporter_id, notes) VALUES
      ('Johan van Zyl', '082 555 0101', (SELECT id FROM transporters WHERE name='Interstate Tankers'), ''),
      ('Petrus Mahlangu', '083 555 0202', (SELECT id FROM transporters WHERE name='Interstate Tankers'), ''),
      ('Sipho Nkosi', '084 555 0303', (SELECT id FROM transporters WHERE name='Unitrans Fuel & Chemical'), ''),
      ('Riaan de Wet', '081 555 0404', (SELECT id FROM transporters WHERE name='Astral Tanker Services'), ''),
      ('Themba Khumalo', '072 555 0505', (SELECT id FROM transporters WHERE name='Karoo Tankers'), '');
  `);
}

// ---------------------------------------------------------------- helpers
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function nextDocNo(prefix, table) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
  const seq = (row.c + 1).toString().padStart(6, '0');
  return `${prefix}${seq}`;
}

function log(user, action, entity, entityId, details) {
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)'
  ).run(user ? user.id : null, user ? user.username : 'system', action, entity, entityId, details ? JSON.stringify(details) : null);
}

// ---------------------------------------------------------------- seed
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const adminSalt = makeSalt();
  const opSalt = makeSalt();
  db.prepare(
    'INSERT INTO users (username, password_hash, salt, full_name, role) VALUES (?,?,?,?,?)'
  ).run('admin', hashPassword('admin123', adminSalt), adminSalt, 'System Administrator', 'Administrator');
  db.prepare(
    'INSERT INTO users (username, password_hash, salt, full_name, role) VALUES (?,?,?,?,?)'
  ).run('operator', hashPassword('operator123', opSalt), opSalt, 'Terminal Operator', 'Manager');

  db.exec(`
    INSERT INTO products (name, category, unit, density, min_stock, notes) VALUES
      ('Diesel 50ppm', 'Fuel', 'litres', 0.84, 50000, 'ULSD - low sulphur diesel'),
      ('Diesel 500ppm', 'Fuel', 'litres', 0.84, 50000, 'HSD - high sulphur diesel'),
      ('Petrol ULP 95', 'Fuel', 'litres', 0.75, 40000, 'Unleaded 95 octane'),
      ('Petrol ULP 93', 'Fuel', 'litres', 0.75, 40000, 'Unleaded 93 octane'),
      ('Illuminating Paraffin', 'Fuel', 'litres', 0.79, 20000, 'IP - illuminating paraffin'),
      ('Jet A1', 'Aviation', 'litres', 0.81, 20000, 'Aviation turbine fuel'),
      ('Heavy Furnace Oil', 'Fuel', 'litres', 0.95, 15000, 'HFO'),
      ('Engine Oil 20W-50', 'Lubricants', 'litres', 0.88, 2000, 'Bulk lubricant');

    INSERT INTO suppliers (name, contact_person, phone, email, address) VALUES
      ('Sasol Limited', 'Johan van der Merwe', '017 610 9111', 'supply@sasol.com', 'Sasol One, Secunda'),
      ('Engen Petroleum', 'Pieter Botha', '011 293 4500', 'terminal@engen.co.za', '147 West Street, Johannesburg'),
      ('BP Southern Africa', 'Thabo Nkosi', '011 993 8000', 'orders@bp.com', '30 Wellington Road, Parktown'),
      ('TotalEnergies Marketing SA', 'Riaan Steyn', '010 601 7500', 'supply@totalenergies.co.za', '3 Parkside, Woodmead');

    INSERT INTO customers (name, contact_person, phone, email, address) VALUES
      ('Shell Downstream SA', 'Mpho Dlamini', '011 498 5700', 'orders@shell.co.za', 'Rivonia Road, Sandton'),
      ('Astra Logistics', 'Chris Naidoo', '013 656 1200', 'ops@astra.co.za', 'Ext 7, Witbank'),
      ('Emalahleni Mining Supplies', 'Sipho Mahlangu', '013 690 2200', 'mining@emalahleni.ms', 'Blesboklaagte, Witbank'),
      ('Mpumalanga Fuels CC', 'Riaan Botha', '013 555 0190', 'info@mpufuels.co.za', 'CBD, Witbank');

    INSERT INTO tanks (code, name, product_id, capacity, current_qty, min_level, max_level, notes) VALUES
      ('T-101', 'Diesel 50ppm - Tank 1', 1, 1200000, 850000, 50000, 1150000, 'Main diesel storage'),
      ('T-102', 'Diesel 500ppm - Tank 2', 2, 800000, 600000, 50000, 760000, ''),
      ('T-103', 'Petrol ULP 95 - Tank 3', 3, 1000000, 720000, 40000, 960000, ''),
      ('T-104', 'Petrol ULP 93 - Tank 4', 4, 600000, 380000, 40000, 570000, ''),
      ('T-105', 'Paraffin - Tank 5', 5, 500000, 260000, 20000, 480000, ''),
      ('T-201', 'Jet A1 - Tank 6', 6, 400000, 150000, 20000, 385000, ''),
      ('T-202', 'HFO - Tank 7', 7, 700000, 520000, 15000, 670000, '');
  `);
  log(null, 'SEED', 'system', null, 'Initialised database with default data');
}

// ---------------------------------------------------------------- export
module.exports = { db, hashPassword, makeSalt, now, nextDocNo, log };