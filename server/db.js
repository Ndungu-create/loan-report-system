const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'app.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  branch TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT,
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'unused',
  duration_hours INTEGER NOT NULL DEFAULT 24,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  last_login_at TEXT,
  last_activity_at TEXT,
  created_by INTEGER REFERENCES admins(id),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  admin_id INTEGER REFERENCES admins(id),
  access_code_id INTEGER REFERENCES access_codes(id),
  client_id INTEGER REFERENCES clients(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_code_id INTEGER REFERENCES access_codes(id),
  client_id INTEGER REFERENCES clients(id),
  client_name TEXT,
  branch TEXT,
  original_filename TEXT,
  stored_filename TEXT,
  report_filename TEXT,
  file_size INTEGER,
  records_total INTEGER DEFAULT 0,
  records_valid INTEGER DEFAULT 0,
  records_skipped INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0,
  report_day TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'processed',
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retention_until TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_role TEXT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_codes_code ON access_codes(code);
CREATE INDEX IF NOT EXISTS idx_codes_status ON access_codes(status);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at);
CREATE INDEX IF NOT EXISTS idx_uploads_client ON uploads(client_id);
CREATE INDEX IF NOT EXISTS idx_uploads_hash ON uploads(content_hash);
`);

module.exports = db;
