import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, hash TEXT NOT NULL, salt TEXT NOT NULL, permissions TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, admin INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS entities_kind ON entities(kind,active);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), opened_at TEXT NOT NULL, closed_at TEXT, opening INTEGER NOT NULL, closing INTEGER, expected INTEGER, variance INTEGER, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_session ON sessions(user_id) WHERE closed_at IS NULL;
    CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, ticket INTEGER NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, day TEXT NOT NULL, total INTEGER NOT NULL, payment TEXT NOT NULL, client_id TEXT, data TEXT NOT NULL, voided_at TEXT, void_reason TEXT, void_session_id TEXT REFERENCES sessions(id));
    CREATE INDEX IF NOT EXISTS sales_day ON sales(day);
    CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, session_id TEXT REFERENCES sessions(id), user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, created_at TEXT NOT NULL, amount INTEGER NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS client_payments (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supplier_payments (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, supplier_id TEXT NOT NULL REFERENCES entities(id), session_id TEXT REFERENCES sessions(id), user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, day TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS print_jobs (id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS closure_print_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), state TEXT NOT NULL DEFAULT 'pending', error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS purged_sessions (id TEXT PRIMARY KEY REFERENCES sessions(id));
    CREATE TABLE IF NOT EXISTS client_opening_balances (client_id TEXT PRIMARY KEY REFERENCES entities(id), amount INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS stock_items (product_id TEXT PRIMARY KEY REFERENCES entities(id), supplier_id TEXT REFERENCES entities(id), quantity INTEGER NOT NULL DEFAULT 0, min_quantity INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock_movements (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL REFERENCES entities(id), supplier_id TEXT REFERENCES entities(id), kind TEXT NOT NULL, quantity INTEGER NOT NULL, before_quantity INTEGER NOT NULL, after_quantity INTEGER NOT NULL, unit_cost INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', sale_id TEXT, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS stock_movements_product_date ON stock_movements(product_id,created_at);
  `);
  const get = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  const put = (key,value) => db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  if (!get('deviceId')) put('deviceId', randomUUID());
  if (!get('ticket')) put('ticket', '0');
  if (!get('outboxSeq')) put('outboxSeq', '0');
  put('schemaVersion', '1');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { db, get, put, transaction, path };
}
