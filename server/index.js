require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const RETENTION_DAYS = Number(process.env.FILE_RETENTION_DAYS || 7);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const ONLINE_THRESHOLD = Number(process.env.ONLINE_THRESHOLD_SECONDS || 90);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
const reportsDir = path.join(__dirname, '..', 'data', 'reports');
[uploadsDir, reportsDir].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(SESSION_SECRET));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });

function audit(actorRole, actorId, action, detail, ip) {
  db.prepare('INSERT INTO audit_logs (actor_role, actor_id, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
    actorRole || null, actorId || null, action, detail ? JSON.stringify(detail) : null, ip || null
  );
}

function genCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const exists = db.prepare('SELECT id FROM access_codes WHERE code = ?').get(c);
    if (!exists) return c;
  }
  throw new Error('Could not generate unique code');
}

function createSession(role, extra = {}) {
  const id = uuidv4();
  const hours = role === 'admin' ? 12 : 8;
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (id, role, admin_id, access_code_id, client_id, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, role, extra.adminId || null, extra.accessCodeId || null, extra.clientId || null,
    expires, extra.ip || null, extra.ua || null
  );
  return { id, expires };
}

function getSession(req) {
  const sid = req.signedCookies?.sid || req.cookies?.sid;
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  // heartbeat
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(sid);
  if (s.access_code_id) {
    db.prepare("UPDATE access_codes SET last_activity_at = datetime('now') WHERE id = ?").run(s.access_code_id);
    const code = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(s.access_code_id);
    if (!code || !['active', 'unused'].includes(code.status)) return null;
    if (code.expires_at && new Date(code.expires_at).getTime() < Date.now()) {
      db.prepare("UPDATE access_codes SET status = 'expired' WHERE id = ?").run(code.id);
      db.prepare('DELETE FROM sessions WHERE access_code_id = ?').run(code.id);
      return null;
    }
    if (code.status === 'unused' && code.activated_at) {
      // shouldn't happen; treat as active
    }
  }
  return s;
}

function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(401).json({ error: 'Admin login required' });
  req.session = s;
  next();
}

function requireClient(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'client') return res.status(401).json({ error: 'Client access required' });
  const code = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(s.access_code_id);
  if (!code || code.status !== 'active') return res.status(403).json({ error: 'Access code not active' });
  if (code.expires_at && new Date(code.expires_at).getTime() < Date.now()) {
    db.prepare("UPDATE access_codes SET status = 'expired' WHERE id = ?").run(code.id);
    return res.status(403).json({ error: 'Access code expired' });
  }
  req.session = s;
  req.accessCode = code;
  next();
}

function setSessionCookie(res, sessionId, expiresAt) {
  res.cookie('sid', sessionId, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expiresAt)
  });
}

function refreshExpiredCodes() {
  db.prepare(`UPDATE access_codes SET status = 'expired'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
}

// ---- Auth routes ----

// One-time admin setup when no admins exist (or SETUP_SECRET provided)
app.post('/api/setup/admin', loginLimiter, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM admins').get().c;
  const setupSecret = process.env.SETUP_SECRET || '';
  const provided = String(req.body.setupSecret || '');
  if (count > 0 && (!setupSecret || provided !== setupSecret)) {
    return res.status(403).json({ error: 'Setup locked. Admin already exists.' });
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || 'Administrator').trim();
  if (!email || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) required' });
  }
  const hash = bcrypt.hashSync(password, 12);
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ?, name = ? WHERE id = ?').run(hash, name, existing.id);
  } else {
    db.prepare('INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)').run(email, hash, name);
  }
  audit('system', null, 'admin_setup', { email }, req.ip);
  res.json({ ok: true, message: 'Admin ready. You can log in.' });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    audit('anon', null, 'admin_login_failed', { email }, req.ip);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const sess = createSession('admin', { adminId: admin.id, ip: req.ip, ua: req.get('user-agent') });
  setSessionCookie(res, sess.id, sess.expires);
  audit('admin', admin.id, 'admin_login', null, req.ip);
  res.json({ ok: true, name: admin.name, email: admin.email });
});

app.post('/api/admin/logout', (req, res) => {
  const s = getSession(req);
  if (s) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  const admin = db.prepare('SELECT id, email, name FROM admins WHERE id = ?').get(req.session.admin_id);
  res.json({ admin });
});

app.post('/api/client/login', codeLimiter, (req, res) => {
  refreshExpiredCodes();
  const codeStr = String(req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(codeStr)) {
    return res.status(400).json({ error: 'Enter a valid 4-character code' });
  }
  const code = db.prepare('SELECT * FROM access_codes WHERE code = ?').get(codeStr);
  if (!code) {
    audit('anon', null, 'code_invalid', { code: codeStr }, req.ip);
    return res.status(401).json({ error: 'Invalid access code' });
  }
  if (code.locked_until && new Date(code.locked_until).getTime() > Date.now()) {
    return res.status(429).json({ error: 'Too many failed attempts. Try later.' });
  }
  if (['revoked', 'suspended', 'expired'].includes(code.status)) {
    return res.status(403).json({ error: `Code is ${code.status}` });
  }

  // Activate on first use
  let expiresAt = code.expires_at;
  if (code.status === 'unused') {
    const activated = new Date();
    expiresAt = new Date(activated.getTime() + code.duration_hours * 3600 * 1000).toISOString();
    db.prepare(`UPDATE access_codes SET status = 'active', activated_at = ?, expires_at = ?,
      last_login_at = datetime('now'), failed_attempts = 0 WHERE id = ?`)
      .run(activated.toISOString(), expiresAt, code.id);
  } else if (code.status === 'active') {
    if (code.expires_at && new Date(code.expires_at).getTime() < Date.now()) {
      db.prepare("UPDATE access_codes SET status = 'expired' WHERE id = ?").run(code.id);
      return res.status(403).json({ error: 'Code is expired' });
    }
    db.prepare("UPDATE access_codes SET last_login_at = datetime('now'), failed_attempts = 0 WHERE id = ?").run(code.id);
  } else {
    return res.status(403).json({ error: 'Code cannot be used' });
  }

  // end other sessions for this code (optional single session)
  db.prepare('DELETE FROM sessions WHERE access_code_id = ?').run(code.id);
  const sess = createSession('client', {
    accessCodeId: code.id, clientId: code.client_id, ip: req.ip, ua: req.get('user-agent')
  });
  setSessionCookie(res, sess.id, sess.expires);
  audit('client', code.id, 'client_login', { code: codeStr }, req.ip);
  const updated = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(code.id);
  res.json({
    ok: true,
    clientName: updated.client_name,
    branch: updated.branch,
    status: updated.status,
    expiresAt: updated.expires_at,
    activatedAt: updated.activated_at
  });
});

app.post('/api/client/logout', (req, res) => {
  const s = getSession(req);
  if (s) {
    audit('client', s.access_code_id, 'client_logout', null, req.ip);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  }
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.post('/api/client/heartbeat', requireClient, (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString(), expiresAt: req.accessCode.expires_at });
});

app.get('/api/client/me', requireClient, (req, res) => {
  const c = req.accessCode;
  const stats = db.prepare(`
    SELECT COUNT(*) as uploads, COALESCE(SUM(total_amount),0) as total_amount,
           COALESCE(SUM(records_valid),0) as records
    FROM uploads WHERE access_code_id = ? AND deleted_at IS NULL AND is_duplicate = 0
  `).get(c.id);
  const recent = db.prepare(`
    SELECT id, original_filename, total_amount, records_valid, created_at, report_day, status, is_duplicate
    FROM uploads WHERE access_code_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20
  `).all(c.id);
  res.json({
    clientName: c.client_name,
    branch: c.branch,
    code: c.code,
    status: c.status,
    expiresAt: c.expires_at,
    activatedAt: c.activated_at,
    stats,
    recent
  });
});

// ---- Admin: dashboard ----
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  refreshExpiredCodes();
  const { from, to, clientId, branch } = req.query;
  let uploadWhere = "deleted_at IS NULL AND is_duplicate = 0";
  const params = [];
  if (from) { uploadWhere += ' AND created_at >= ?'; params.push(from); }
  if (to) { uploadWhere += ' AND created_at <= ?'; params.push(to + ' 23:59:59'); }
  if (clientId) { uploadWhere += ' AND client_id = ?'; params.push(Number(clientId)); }
  if (branch) { uploadWhere += ' AND branch = ?'; params.push(branch); }

  const totals = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) as total_amount,
           COUNT(*) as upload_count,
           COALESCE(SUM(records_valid),0) as records
    FROM uploads WHERE ${uploadWhere}
  `).get(...params);

  const clients = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
  const codesActive = db.prepare("SELECT COUNT(*) as c FROM access_codes WHERE status = 'active'").get().c;
  const codesExpired = db.prepare("SELECT COUNT(*) as c FROM access_codes WHERE status IN ('expired','revoked','suspended')").get().c;
  const online = db.prepare(`
    SELECT COUNT(DISTINCT access_code_id) as c FROM sessions
    WHERE role = 'client' AND last_seen_at >= datetime('now', ?)
  `).get(`-${ONLINE_THRESHOLD} seconds`).c;

  const recentUploads = db.prepare(`
    SELECT id, client_name, branch, original_filename, total_amount, records_valid, created_at, status, is_duplicate
    FROM uploads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15
  `).all();

  const recentAudit = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 20').all();

  res.json({
    totals, clients, codesActive, codesExpired, online,
    recentUploads, recentAudit, onlineThresholdSeconds: ONLINE_THRESHOLD
  });
});

// ---- Admin: clients ----
app.get('/api/admin/clients', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM uploads u WHERE u.client_id = c.id AND u.deleted_at IS NULL AND u.is_duplicate = 0) as upload_count,
      (SELECT COALESCE(SUM(total_amount),0) FROM uploads u WHERE u.client_id = c.id AND u.deleted_at IS NULL AND u.is_duplicate = 0) as total_amount,
      (SELECT last_login_at FROM access_codes ac WHERE ac.client_id = c.id ORDER BY last_login_at DESC LIMIT 1) as last_login_at
    FROM clients c ORDER BY c.created_at DESC
  `).all();
  res.json({ clients: rows });
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const branch = String(req.body.branch || '').trim() || null;
  const notes = String(req.body.notes || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Client name required' });
  const info = db.prepare('INSERT INTO clients (name, branch, notes) VALUES (?, ?, ?)').run(name, branch, notes);
  audit('admin', req.session.admin_id, 'client_create', { id: info.lastInsertRowid, name }, req.ip);
  res.json({ id: info.lastInsertRowid, name, branch, notes });
});

// ---- Admin: access codes ----
app.get('/api/admin/codes', requireAdmin, (req, res) => {
  refreshExpiredCodes();
  const rows = db.prepare(`
    SELECT ac.*,
      (SELECT COUNT(*) FROM uploads u WHERE u.access_code_id = ac.id AND u.deleted_at IS NULL) as upload_count,
      (SELECT COALESCE(SUM(total_amount),0) FROM uploads u WHERE u.access_code_id = ac.id AND u.deleted_at IS NULL AND u.is_duplicate = 0) as total_amount
    FROM access_codes ac ORDER BY ac.created_at DESC
  `).all();
  res.json({ codes: rows });
});

app.post('/api/admin/codes', requireAdmin, (req, res) => {
  let code = String(req.body.code || '').trim().toUpperCase();
  const clientName = String(req.body.clientName || '').trim();
  const branch = String(req.body.branch || '').trim() || null;
  const clientId = req.body.clientId ? Number(req.body.clientId) : null;
  const durationHours = Number(req.body.durationHours || 24);
  if (!clientName) return res.status(400).json({ error: 'Client name required' });
  if (!durationHours || durationHours < 1) return res.status(400).json({ error: 'Invalid duration' });
  if (code) {
    if (!/^[A-Z0-9]{4}$/.test(code)) return res.status(400).json({ error: 'Code must be 4 letters/numbers' });
    if (db.prepare('SELECT id FROM access_codes WHERE code = ?').get(code)) {
      return res.status(409).json({ error: 'Code already exists' });
    }
  } else {
    code = genCode();
  }
  let resolvedClientId = clientId;
  if (!resolvedClientId) {
    const info = db.prepare('INSERT INTO clients (name, branch) VALUES (?, ?)').run(clientName, branch);
    resolvedClientId = info.lastInsertRowid;
  }
  const info = db.prepare(`
    INSERT INTO access_codes (code, client_id, client_name, branch, status, duration_hours, created_by)
    VALUES (?, ?, ?, ?, 'unused', ?, ?)
  `).run(code, resolvedClientId, clientName, branch, durationHours, req.session.admin_id);
  audit('admin', req.session.admin_id, 'code_create', { code, durationHours, clientName }, req.ip);
  res.json({ id: info.lastInsertRowid, code, durationHours, status: 'unused' });
});

app.post('/api/admin/codes/:id/revoke', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE access_codes SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`).run(id);
  db.prepare('DELETE FROM sessions WHERE access_code_id = ?').run(id);
  audit('admin', req.session.admin_id, 'code_revoke', { id }, req.ip);
  res.json({ ok: true });
});

app.post('/api/admin/codes/:id/suspend', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE access_codes SET status = 'suspended' WHERE id = ?`).run(id);
  db.prepare('DELETE FROM sessions WHERE access_code_id = ?').run(id);
  audit('admin', req.session.admin_id, 'code_suspend', { id }, req.ip);
  res.json({ ok: true });
});

app.post('/api/admin/codes/:id/reactivate', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const code = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id);
  if (!code) return res.status(404).json({ error: 'Not found' });
  if (code.expires_at && new Date(code.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Code already past expiry; extend duration first' });
  }
  db.prepare(`UPDATE access_codes SET status = 'active', revoked_at = NULL WHERE id = ?`).run(id);
  audit('admin', req.session.admin_id, 'code_reactivate', { id }, req.ip);
  res.json({ ok: true });
});

app.post('/api/admin/codes/:id/extend', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const extraHours = Number(req.body.extraHours || 0);
  if (extraHours < 1) return res.status(400).json({ error: 'extraHours required' });
  const code = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id);
  if (!code) return res.status(404).json({ error: 'Not found' });
  const base = code.expires_at && new Date(code.expires_at).getTime() > Date.now()
    ? new Date(code.expires_at)
    : new Date();
  const newExp = new Date(base.getTime() + extraHours * 3600 * 1000).toISOString();
  db.prepare(`UPDATE access_codes SET expires_at = ?, status = CASE WHEN status IN ('expired','revoked','suspended') THEN 'active' ELSE status END, duration_hours = duration_hours + ? WHERE id = ?`)
    .run(newExp, extraHours, id);
  audit('admin', req.session.admin_id, 'code_extend', { id, extraHours, newExp }, req.ip);
  res.json({ ok: true, expiresAt: newExp });
});

// ---- Admin: activity / online ----
app.get('/api/admin/activity', requireAdmin, (req, res) => {
  const onlineClients = db.prepare(`
    SELECT s.id as session_id, s.last_seen_at, s.created_at as login_at, ac.code, ac.client_name, ac.branch, ac.status, ac.expires_at
    FROM sessions s
    JOIN access_codes ac ON ac.id = s.access_code_id
    WHERE s.role = 'client' AND s.last_seen_at >= datetime('now', ?)
    ORDER BY s.last_seen_at DESC
  `).all(`-${ONLINE_THRESHOLD} seconds`);
  const failed = db.prepare(`
    SELECT * FROM audit_logs WHERE action IN ('code_invalid','admin_login_failed') ORDER BY created_at DESC LIMIT 50
  `).all();
  res.json({ onlineClients, failed, onlineThresholdSeconds: ONLINE_THRESHOLD });
});

// ---- Uploads ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    cb(null, `${Date.now()}_${uuidv4().slice(0, 8)}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx?$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx or .xls files allowed'));
  }
});

app.post('/api/client/uploads', requireClient, (req, res, next) => {
  // multipart or JSON
  if (req.is('multipart/form-data')) {
    return upload.single('file')(req, res, next);
  }
  next();
}, (req, res) => {
  try {
    const meta = typeof req.body.meta === 'string'
      ? JSON.parse(req.body.meta || '{}')
      : (req.body.meta || req.body || {});
    const recordsValid = Number(meta.recordsValid || 0);
    const recordsSkipped = Number(meta.recordsSkipped || 0);
    const recordsTotal = Number(meta.recordsTotal || recordsValid + recordsSkipped);
    const totalAmount = Number(meta.totalAmount || 0);
    const reportDay = meta.reportDay || null;
    const contentHash = meta.contentHash || null;
    const branch = meta.branch || req.accessCode.branch || null;

    let isDuplicate = 0;
    let duplicateOf = null;
    if (contentHash) {
      const prev = db.prepare(`
        SELECT id FROM uploads WHERE content_hash = ? AND access_code_id = ? AND deleted_at IS NULL AND is_duplicate = 0
        ORDER BY id ASC LIMIT 1
      `).get(contentHash, req.accessCode.id);
      if (prev) { isDuplicate = 1; duplicateOf = prev.id; }
    }

    const retention = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
    const info = db.prepare(`
      INSERT INTO uploads (
        access_code_id, client_id, client_name, branch, original_filename, stored_filename,
        file_size, records_total, records_valid, records_skipped, total_amount, report_day,
        content_hash, status, is_duplicate, duplicate_of, retention_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed', ?, ?, ?)
    `).run(
      req.accessCode.id, req.accessCode.client_id, req.accessCode.client_name, branch,
      req.file?.originalname || meta.originalFilename || 'upload.xlsx',
      req.file?.filename || null,
      req.file?.size || meta.fileSize || 0,
      recordsTotal, recordsValid, recordsSkipped, totalAmount, reportDay,
      contentHash, isDuplicate, duplicateOf, retention
    );

    // optional report blob saved as base64 in body is too heavy; client downloads locally
    audit('client', req.accessCode.id, 'upload', {
      uploadId: info.lastInsertRowid, totalAmount, recordsValid, isDuplicate
    }, req.ip);

    res.json({
      ok: true,
      uploadId: info.lastInsertRowid,
      isDuplicate: !!isDuplicate,
      duplicateOf,
      metaOnly: !req.file,
      message: isDuplicate
        ? 'Processed, but flagged as possible duplicate of an earlier upload (excluded from combined totals).'
        : 'Upload recorded'
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

app.get('/api/admin/uploads', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM uploads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500
  `).all();
  res.json({ uploads: rows });
});

app.get('/api/admin/uploads/:id/file', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM uploads WHERE id = ? AND deleted_at IS NULL').get(Number(req.params.id));
  if (!u || !u.stored_filename) return res.status(404).json({ error: 'File not found' });
  const fp = path.join(uploadsDir, u.stored_filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing on disk' });
  res.download(fp, u.original_filename || u.stored_filename);
});

app.delete('/api/admin/uploads/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE uploads SET deleted_at = datetime('now') WHERE id = ?").run(id);
  if (u.stored_filename) {
    const fp = path.join(uploadsDir, u.stored_filename);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (_) {}
  }
  audit('admin', req.session.admin_id, 'upload_delete', { id }, req.ip);
  res.json({ ok: true });
});

app.get('/api/admin/finance', requireAdmin, (req, res) => {
  const byClient = db.prepare(`
    SELECT client_name, branch, COUNT(*) as uploads, SUM(total_amount) as total_amount, SUM(records_valid) as records
    FROM uploads WHERE deleted_at IS NULL AND is_duplicate = 0
    GROUP BY client_name, branch ORDER BY total_amount DESC
  `).all();
  const byDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as uploads, SUM(total_amount) as total_amount, SUM(records_valid) as records
    FROM uploads WHERE deleted_at IS NULL AND is_duplicate = 0
    GROUP BY date(created_at) ORDER BY day DESC LIMIT 60
  `).all();
  const byBranch = db.prepare(`
    SELECT COALESCE(branch,'(none)') as branch, COUNT(*) as uploads, SUM(total_amount) as total_amount, SUM(records_valid) as records
    FROM uploads WHERE deleted_at IS NULL AND is_duplicate = 0
    GROUP BY branch ORDER BY total_amount DESC
  `).all();
  res.json({ byClient, byDay, byBranch });
});

// retention cleanup job
function cleanupExpiredFiles() {
  const due = db.prepare(`
    SELECT id, stored_filename FROM uploads
    WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until < datetime('now')
  `).all();
  for (const u of due) {
    if (u.stored_filename) {
      const fp = path.join(uploadsDir, u.stored_filename);
      if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (_) {}
    }
    db.prepare("UPDATE uploads SET deleted_at = datetime('now'), stored_filename = NULL WHERE id = ?").run(u.id);
  }
}
setInterval(cleanupExpiredFiles, 60 * 60 * 1000);

// static panels
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/client', express.static(path.join(__dirname, '..', 'public', 'client')));
app.use('/shared', express.static(path.join(__dirname, '..', 'public', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.redirect('/client/'));
app.get('/admin', (req, res) => res.redirect('/admin/'));
app.get('/setup', (req, res) => res.redirect('/setup.html'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Loan Report System running on http://localhost:${PORT}`);
  console.log(`Admin:  http://localhost:${PORT}/admin/`);
  console.log(`Client: http://localhost:${PORT}/client/`);
  refreshExpiredCodes();
});
