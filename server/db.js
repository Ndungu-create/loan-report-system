/**
 * Lightweight JSON file store with a better-sqlite3-like prepare API
 * for the queries used by this app. No native modules — works on Render free tier.
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'app.json');

const empty = () => ({
  admins: [],
  clients: [],
  access_codes: [],
  sessions: [],
  uploads: [],
  audit_logs: [],
  _seq: { admins: 0, clients: 0, access_codes: 0, uploads: 0, audit_logs: 0 }
});

function load() {
  try {
    if (fs.existsSync(dbPath)) return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (_) {}
  return empty();
}

function save(state) {
  fs.writeFileSync(dbPath, JSON.stringify(state, null, 0));
}

let state = load();

function nowISO() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function nextId(table) {
  state._seq[table] = (state._seq[table] || 0) + 1;
  return state._seq[table];
}

function matchWhere(row, where, params) {
  // very small subset: equality on named columns from SQL we generate
  return true;
}

/** Minimal SQL executor for the statements this app uses */
function execQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const p = params.slice();

  // SELECT COUNT(*) as c FROM admins
  if (/^SELECT COUNT\(\*\) as c FROM admins$/i.test(s)) {
    return { rows: [{ c: state.admins.length }] };
  }

  // SELECT * FROM admins WHERE email = ?
  if (/^SELECT \* FROM admins WHERE email = \?$/i.test(s)) {
    const email = p[0];
    const row = state.admins.find((a) => a.email === email) || null;
    return { rows: row ? [row] : [] };
  }

  // SELECT id, email, name FROM admins WHERE id = ?
  if (/^SELECT id, email, name FROM admins WHERE id = \?$/i.test(s)) {
    const row = state.admins.find((a) => a.id === p[0]) || null;
    return { rows: row ? [{ id: row.id, email: row.email, name: row.name }] : [] };
  }

  // INSERT INTO admins
  if (/^INSERT INTO admins \(email, password_hash, name\) VALUES \(\?, \?, \?\)$/i.test(s)) {
    const id = nextId('admins');
    state.admins.push({ id, email: p[0], password_hash: p[1], name: p[2], created_at: nowISO() });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }

  // UPDATE admins SET password_hash = ?, name = ? WHERE id = ?
  if (/^UPDATE admins SET password_hash = \?, name = \? WHERE id = \?$/i.test(s)) {
    const a = state.admins.find((x) => x.id === p[2]);
    if (a) { a.password_hash = p[0]; a.name = p[1]; save(state); return { changes: 1 }; }
    return { changes: 0 };
  }

  // INSERT clients
  if (/^INSERT INTO clients \(name, branch, notes\) VALUES \(\?, \?, \?\)$/i.test(s)) {
    const id = nextId('clients');
    state.clients.push({ id, name: p[0], branch: p[1], notes: p[2], created_at: nowISO(), updated_at: nowISO() });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }
  if (/^INSERT INTO clients \(name, branch\) VALUES \(\?, \?\)$/i.test(s)) {
    const id = nextId('clients');
    state.clients.push({ id, name: p[0], branch: p[1], notes: null, created_at: nowISO(), updated_at: nowISO() });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }

  // access_codes insert
  if (/^INSERT INTO access_codes \(code, client_id, client_name, branch, status, duration_hours, created_by\) VALUES \(\?, \?, \?, \?, 'unused', \?, \?\)$/i.test(s)) {
    const id = nextId('access_codes');
    state.access_codes.push({
      id, code: p[0], client_id: p[1], client_name: p[2], branch: p[3],
      status: 'unused', duration_hours: p[4], created_by: p[5],
      created_at: nowISO(), activated_at: null, expires_at: null, revoked_at: null,
      last_login_at: null, last_activity_at: null, failed_attempts: 0, locked_until: null
    });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }

  // SELECT access code by code
  if (/^SELECT \* FROM access_codes WHERE code = \?$/i.test(s)) {
    const row = state.access_codes.find((c) => c.code === p[0]) || null;
    return { rows: row ? [row] : [] };
  }
  if (/^SELECT id FROM access_codes WHERE code = \?$/i.test(s)) {
    const row = state.access_codes.find((c) => c.code === p[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (/^SELECT \* FROM access_codes WHERE id = \?$/i.test(s)) {
    const row = state.access_codes.find((c) => c.id === p[0]) || null;
    return { rows: row ? [row] : [] };
  }

  // UPDATE access_codes various
  if (s.startsWith('UPDATE access_codes')) {
    const id = p[p.length - 1];
    const c = state.access_codes.find((x) => x.id === id);
    if (!c) return { changes: 0 };
    if (s.includes("status = 'expired'")) {
      // bulk or single
      if (s.includes('WHERE status =')) {
        let n = 0;
        const now = Date.now();
        state.access_codes.forEach((x) => {
          if (x.status === 'active' && x.expires_at && new Date(x.expires_at).getTime() < now) {
            x.status = 'expired'; n++;
          }
        });
        save(state);
        return { changes: n };
      }
      c.status = 'expired';
    }
    if (s.includes("status = 'active'") && s.includes('activated_at')) {
      c.status = 'active'; c.activated_at = p[0]; c.expires_at = p[1];
      c.last_login_at = nowISO(); c.failed_attempts = 0;
    }
    if (s.includes('last_login_at') && s.includes('failed_attempts = 0') && !s.includes('activated_at')) {
      c.last_login_at = nowISO(); c.failed_attempts = 0;
    }
    if (s.includes('last_activity_at')) c.last_activity_at = nowISO();
    if (s.includes("status = 'revoked'")) { c.status = 'revoked'; c.revoked_at = nowISO(); }
    if (s.includes("status = 'suspended'")) c.status = 'suspended';
    if (s.includes('revoked_at = NULL')) { c.status = 'active'; c.revoked_at = null; }
    if (s.includes('expires_at = ?') && s.includes('duration_hours')) {
      c.expires_at = p[0];
      c.duration_hours = (c.duration_hours || 0) + p[1];
      if (['expired', 'revoked', 'suspended'].includes(c.status)) c.status = 'active';
    }
    save(state);
    return { changes: 1 };
  }

  // sessions
  if (/^INSERT INTO sessions \(id, role, admin_id, access_code_id, client_id, expires_at, ip, user_agent\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?\)$/i.test(s)) {
    state.sessions.push({
      id: p[0], role: p[1], admin_id: p[2], access_code_id: p[3], client_id: p[4],
      created_at: nowISO(), last_seen_at: nowISO(), expires_at: p[5], ip: p[6], user_agent: p[7]
    });
    save(state);
    return { changes: 1 };
  }
  if (/^SELECT \* FROM sessions WHERE id = \?$/i.test(s)) {
    const row = state.sessions.find((x) => x.id === p[0]) || null;
    return { rows: row ? [row] : [] };
  }
  if (/^DELETE FROM sessions WHERE id = \?$/i.test(s)) {
    state.sessions = state.sessions.filter((x) => x.id !== p[0]);
    save(state);
    return { changes: 1 };
  }
  if (/^DELETE FROM sessions WHERE access_code_id = \?$/i.test(s)) {
    state.sessions = state.sessions.filter((x) => x.access_code_id !== p[0]);
    save(state);
    return { changes: 1 };
  }
  if (/^UPDATE sessions SET last_seen_at = datetime\('now'\) WHERE id = \?$/i.test(s)) {
    const row = state.sessions.find((x) => x.id === p[0]);
    if (row) { row.last_seen_at = nowISO(); save(state); }
    return { changes: 1 };
  }

  // uploads insert
  if (s.startsWith('INSERT INTO uploads')) {
    const id = nextId('uploads');
    const row = {
      id,
      access_code_id: p[0], client_id: p[1], client_name: p[2], branch: p[3],
      original_filename: p[4], stored_filename: p[5], file_size: p[6],
      records_total: p[7], records_valid: p[8], records_skipped: p[9],
      total_amount: p[10], report_day: p[11], content_hash: p[12],
      status: 'processed', is_duplicate: p[13], duplicate_of: p[14],
      retention_until: p[15], created_at: nowISO(), deleted_at: null, report_filename: null
    };
    state.uploads.push(row);
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }

  if (/^SELECT id FROM uploads WHERE content_hash = \? AND access_code_id = \? AND deleted_at IS NULL AND is_duplicate = 0 ORDER BY id ASC LIMIT 1$/i.test(s)) {
    const row = state.uploads.find((u) => u.content_hash === p[0] && u.access_code_id === p[1] && !u.deleted_at && !u.is_duplicate);
    return { rows: row ? [{ id: row.id }] : [] };
  }

  if (/^SELECT \* FROM uploads WHERE id = \? AND deleted_at IS NULL$/i.test(s) || /^SELECT \* FROM uploads WHERE id = \?$/i.test(s)) {
    const row = state.uploads.find((u) => u.id === p[0] && (s.includes('deleted_at IS NULL') ? !u.deleted_at : true)) || null;
    return { rows: row ? [row] : [] };
  }

  if (/^UPDATE uploads SET deleted_at = datetime\('now'\) WHERE id = \?$/i.test(s)) {
    const u = state.uploads.find((x) => x.id === p[0]);
    if (u) { u.deleted_at = nowISO(); save(state); }
    return { changes: 1 };
  }
  if (/^UPDATE uploads SET deleted_at = datetime\('now'\), stored_filename = NULL WHERE id = \?$/i.test(s)) {
    const u = state.uploads.find((x) => x.id === p[0]);
    if (u) { u.deleted_at = nowISO(); u.stored_filename = null; save(state); }
    return { changes: 1 };
  }

  // audit
  if (/^INSERT INTO audit_logs \(actor_role, actor_id, action, detail, ip\) VALUES \(\?, \?, \?, \?, \?\)$/i.test(s)) {
    const id = nextId('audit_logs');
    state.audit_logs.push({ id, actor_role: p[0], actor_id: p[1], action: p[2], detail: p[3], ip: p[4], created_at: nowISO() });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }

  // Dashboard aggregates — handled loosely
  if (s.includes('FROM uploads WHERE') && s.includes('SUM(total_amount)')) {
    let list = state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate);
    if (s.includes('access_code_id = ?')) list = list.filter((u) => u.access_code_id === p[0]);
    if (s.includes('client_id = ?')) {
      const idx = s.includes('access_code_id') ? 1 : 0;
      // params order varies — best effort
    }
    return {
      rows: [{
        total_amount: list.reduce((a, u) => a + (u.total_amount || 0), 0),
        upload_count: list.length,
        records: list.reduce((a, u) => a + (u.records_valid || 0), 0),
        uploads: list.length,
        c: list.length
      }]
    };
  }

  if (/^SELECT COUNT\(\*\) as c FROM clients$/i.test(s)) {
    return { rows: [{ c: state.clients.length }] };
  }
  if (/SELECT COUNT\(\*\) as c FROM access_codes WHERE status = 'active'/i.test(s)) {
    return { rows: [{ c: state.access_codes.filter((c) => c.status === 'active').length }] };
  }
  if (/SELECT COUNT\(\*\) as c FROM access_codes WHERE status IN/i.test(s)) {
    return { rows: [{ c: state.access_codes.filter((c) => ['expired', 'revoked', 'suspended'].includes(c.status)).length }] };
  }

  // online count
  if (s.includes('FROM sessions') && s.includes("role = 'client'")) {
    const thresholdSec = 90;
    const cut = Date.now() - thresholdSec * 1000;
    const online = state.sessions.filter((sess) => {
      if (sess.role !== 'client') return false;
      return new Date(sess.last_seen_at.replace(' ', 'T') + 'Z').getTime() >= cut
        || new Date(sess.last_seen_at).getTime() >= cut;
    });
    if (s.includes('COUNT(DISTINCT access_code_id)')) {
      const ids = new Set(online.map((x) => x.access_code_id));
      return { rows: [{ c: ids.size }] };
    }
    // join list for activity
    const rows = online.map((sess) => {
      const ac = state.access_codes.find((c) => c.id === sess.access_code_id) || {};
      return {
        session_id: sess.id, last_seen_at: sess.last_seen_at, login_at: sess.created_at,
        code: ac.code, client_name: ac.client_name, branch: ac.branch, status: ac.status, expires_at: ac.expires_at
      };
    });
    return { rows };
  }

  // list queries
  if (/FROM uploads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15/i.test(s)) {
    const rows = state.uploads.filter((u) => !u.deleted_at).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 15);
    return { rows };
  }
  if (/FROM uploads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500/i.test(s)) {
    const rows = state.uploads.filter((u) => !u.deleted_at).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 500);
    return { rows };
  }
  if (/FROM uploads WHERE access_code_id = \? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20/i.test(s)) {
    const rows = state.uploads.filter((u) => u.access_code_id === p[0] && !u.deleted_at)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 20);
    return { rows };
  }
  if (/SELECT \* FROM audit_logs ORDER BY created_at DESC LIMIT 20/i.test(s)) {
    return { rows: state.audit_logs.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 20) };
  }
  if (/action IN \('code_invalid','admin_login_failed'\)/i.test(s)) {
    return {
      rows: state.audit_logs.filter((a) => ['code_invalid', 'admin_login_failed'].includes(a.action))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 50)
    };
  }

  // codes list with subcounts
  if (s.includes('FROM access_codes ac ORDER BY')) {
    const rows = state.access_codes.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((ac) => {
      const ups = state.uploads.filter((u) => u.access_code_id === ac.id && !u.deleted_at);
      const upsOk = ups.filter((u) => !u.is_duplicate);
      return {
        ...ac,
        upload_count: ups.length,
        total_amount: upsOk.reduce((s, u) => s + (u.total_amount || 0), 0)
      };
    });
    return { rows };
  }

  // clients list
  if (s.includes('FROM clients c ORDER BY')) {
    const rows = state.clients.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((c) => {
      const ups = state.uploads.filter((u) => u.client_id === c.id && !u.deleted_at && !u.is_duplicate);
      const codes = state.access_codes.filter((ac) => ac.client_id === c.id);
      const lastLogin = codes.map((x) => x.last_login_at).filter(Boolean).sort().reverse()[0] || null;
      return {
        ...c,
        upload_count: ups.length,
        total_amount: ups.reduce((s, u) => s + (u.total_amount || 0), 0),
        last_login_at: lastLogin
      };
    });
    return { rows };
  }

  // finance group by
  if (s.includes('GROUP BY client_name')) {
    const map = {};
    state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate).forEach((u) => {
      const k = (u.client_name || '') + '|' + (u.branch || '');
      if (!map[k]) map[k] = { client_name: u.client_name, branch: u.branch, uploads: 0, total_amount: 0, records: 0 };
      map[k].uploads++; map[k].total_amount += u.total_amount || 0; map[k].records += u.records_valid || 0;
    });
    return { rows: Object.values(map).sort((a, b) => b.total_amount - a.total_amount) };
  }
  if (s.includes('GROUP BY branch')) {
    const map = {};
    state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate).forEach((u) => {
      const k = u.branch || '(none)';
      if (!map[k]) map[k] = { branch: k, uploads: 0, total_amount: 0, records: 0 };
      map[k].uploads++; map[k].total_amount += u.total_amount || 0; map[k].records += u.records_valid || 0;
    });
    return { rows: Object.values(map).sort((a, b) => b.total_amount - a.total_amount) };
  }
  if (s.includes("date(created_at) as day") || s.includes('GROUP BY date(created_at)')) {
    const map = {};
    state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate).forEach((u) => {
      const day = String(u.created_at || '').slice(0, 10);
      if (!map[day]) map[day] = { day, uploads: 0, total_amount: 0, records: 0 };
      map[day].uploads++; map[day].total_amount += u.total_amount || 0; map[day].records += u.records_valid || 0;
    });
    return { rows: Object.values(map).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 60) };
  }

  // retention select
  if (s.includes('retention_until') && s.includes("datetime('now')")) {
    const now = Date.now();
    const rows = state.uploads.filter((u) => !u.deleted_at && u.retention_until && new Date(u.retention_until).getTime() < now)
      .map((u) => ({ id: u.id, stored_filename: u.stored_filename }));
    return { rows };
  }

  // SELECT COUNT/SUM for client me stats
  if (s.includes('FROM uploads WHERE access_code_id = ?') && s.includes('SUM(total_amount)')) {
    const list = state.uploads.filter((u) => u.access_code_id === p[0] && !u.deleted_at && !u.is_duplicate);
    return {
      rows: [{
        uploads: list.length,
        total_amount: list.reduce((a, u) => a + (u.total_amount || 0), 0),
        records: list.reduce((a, u) => a + (u.records_valid || 0), 0)
      }]
    };
  }

  console.warn('Unhandled SQL:', s, p);
  return { rows: [], lastInsertRowid: 0, changes: 0 };
}

const db = {
  exec() {},
  prepare(sql) {
    return {
      get(...params) {
        const { rows } = execQuery(sql, params);
        return rows[0];
      },
      all(...params) {
        const { rows } = execQuery(sql, params);
        return rows;
      },
      run(...params) {
        const r = execQuery(sql, params);
        return { lastInsertRowid: r.lastInsertRowid || 0, changes: r.changes || 0 };
      }
    };
  }
};

module.exports = db;
