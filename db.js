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

CREATE TABLE IF NOT EXISTS vehicles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fleet_no       TEXT,
  reg            TEXT NOT NULL UNIQUE,
  vehicle_type   TEXT,
  transporter_id INTEGER REFERENCES transporters(id),
  licence_expiry TEXT,
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

// vehicles: rebuild if it still has the old schema (driver_id/notes)
const vehiclesCols = db.prepare('PRAGMA table_info(vehicles)').all().map(c => c.name);
if (vehiclesCols.length && !vehiclesCols.includes('fleet_no')) {
  db.exec(`DROP TABLE IF EXISTS vehicles; CREATE TABLE vehicles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fleet_no       TEXT,
    reg            TEXT NOT NULL UNIQUE,
    vehicle_type   TEXT,
    transporter_id INTEGER REFERENCES transporters(id),
    licence_expiry TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);
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
  db.prepare(
    'INSERT INTO users (username, password_hash, salt, full_name, role) VALUES (?,?,?,?,?)'
  ).run('admin', hashPassword('admin123', adminSalt), adminSalt, 'System Administrator', 'Administrator');

  log(null, 'SEED', 'system', null, 'Initialised database with default admin user');
}

// ---------------------------------------------------------------- export
module.exports = { db, hashPassword, makeSalt, now, nextDocNo, log };