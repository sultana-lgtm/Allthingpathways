import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';

const file = process.env.DB_FILE || 'data/printflow.db';
if (file !== ':memory:') mkdirSync('data', { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
  unit TEXT NOT NULL DEFAULT 'each', rate INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'in-house');
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL, customer_email TEXT DEFAULT '', customer_phone TEXT DEFAULT '',
  due_date TEXT, details TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received',
  subtotal INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  qb_invoice_id TEXT, qb_balance INTEGER, qb_error TEXT, qb_synced_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual', email_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  description TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, rate INTEGER NOT NULL DEFAULT 0, price_id INTEGER);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  method TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT, last4 TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY, gmail_id TEXT UNIQUE, thread_id TEXT,
  from_name TEXT, from_email TEXT, subject TEXT, body TEXT, received_at TEXT,
  kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  draft TEXT, order_id INTEGER);
CREATE TABLE IF NOT EXISTS qb_mock_invoices (
  id TEXT PRIMARY KEY, customer TEXT, email TEXT, date TEXT, total INTEGER, balance INTEGER, lines TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

export const hashPassword = (pw, salt = randomBytes(16).toString('hex')) =>
  ({ salt, hash: scryptSync(pw, salt, 64).toString('hex') });

export const getKv = (k) => db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v;
export const setKv = (k, v) =>
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seed() {
  if (!db.prepare('SELECT COUNT(*) c FROM users').get().c) {
    const user = process.env.ADMIN_USER || 'admin';
    const pw = process.env.ADMIN_PASSWORD || randomBytes(6).toString('hex');
    const { salt, hash } = hashPassword(pw);
    db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(user, salt, hash);
    console.log(`\n  Created staff login  ->  username: ${user}   password: ${pw}\n  (set ADMIN_USER / ADMIN_PASSWORD before first start to choose your own)\n`);
  }
  if (!db.prepare('SELECT COUNT(*) c FROM prices').get().c) {
    const ins = db.prepare('INSERT INTO prices(name,category,unit,rate,source) VALUES(?,?,?,?,?)');
    [
      ['Business cards (full colour)', 'Cards', 'per 100', 1800, 'in-house'],
      ['Flyers 8.5x11', 'Flyers', 'each', 45, 'in-house'],
      ['Brochures tri-fold', 'Flyers', 'each', 90, 'in-house'],
      ['Posters 18x24', 'Large format', 'each', 1400, 'in-house'],
      ['Vinyl banner 3x6', 'Large format', 'each', 8500, 'outsourced'],
      ['Yard signs', 'Signs', 'each', 1100, 'outsourced'],
      ['Booklets saddle-stitched', 'Booklets', 'each', 320, 'in-house'],
      ['Custom t-shirts', 'Apparel', 'each', 1650, 'outsourced'],
      ['Design / setup fee', 'Services', 'per hour', 6500, 'in-house'],
    ].forEach((r) => ins.run(...r));
  }
}
