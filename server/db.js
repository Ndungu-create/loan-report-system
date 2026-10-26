/**
 * JSON file store — robust matching so codes/admins/uploads actually persist on Render.
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'app.json');

function empty() {
  return {
    admins: [],
    clients: [],
    access_codes: [],
    sessions: [],
    uploads: [],
    audit_logs: [],
    _seq: { admins: 0, clients: 0, access_codes: 0, uploads: 0, audit_logs: 0 }
  };
}

function load() {
  try {
    if (fs.existsSync(dbPath)) {
      const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      raw.admins = raw.admins || [];
      raw.clients = raw.clients || [];
      raw.access_codes = raw.access_codes || [];
      raw.sessions = raw.sessions || [];
      raw.uploads = raw.uploads || [];
      raw.audit_logs = raw.audit_logs || [];
      raw._seq = raw._seq || { admins: 0, clients: 0, access_codes: 0, uploads: 0, audit_logs: 0 };
      return raw;
    }
  } catch (e) {
    console.error('DB load error', e.message);
  }
  return empty();
}

function save(state) {
  try {
    const tmp = dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, dbPath);
  } catch (e) {
    console.error('DB save error', e.message);
  }
}

let state = load();

function nowISO() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function nextId(table) {
  state._seq[table] = (state._seq[table] || 0) + 1;
  return state._seq[table];
}

function norm(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function byId(arr, id) {
  const n = Number(id);
  return arr.find((x) => Number(x.id) === n);
}

function execQuery(sql, params = []) {
  const s = norm(sql);
  const p = params.slice();
  const low = s.toLowerCase();

  // ----- ADMINS -----
  if (low === 'select count(*) as c from admins') {
    return { rows: [{ c: state.admins.length }] };
  }
  if (low.startsWith('select * from admins where email =')) {
    const email = String(p[0] || '').toLowerCase();
    const row = state.admins.find((a) => a.email === email) || null;
    return { rows: row ? [row] : [] };
  }
  if (low.startsWith('select id, email, name from admins where id =')) {
    const row = byId(state.admins, p[0]);
    return { rows: row ? [{ id: row.id, email: row.email, name: row.name }] : [] };
  }
  if (low.startsWith('insert into admins')) {
    const id = nextId('admins');
    state.admins.push({ id, email: String(p[0]).toLowerCase(), password_hash: p[1], name: p[2], created_at: nowISO() });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }
  if (low.startsWith('update admins set password_hash')) {
    const a = byId(state.admins, p[2]);
    if (a) { a.password_hash = p[0]; a.name = p[1]; save(state); return { changes: 1 }; }
    return { changes: 0 };
  }

  // ----- CLIENTS -----
  if (low.startsWith('insert into clients')) {
    const id = nextId('clients');
    state.clients.push({
      id, name: p[0], branch: p[1] || null, notes: p[2] || null,
      created_at: nowISO(), updated_at: nowISO()
    });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }
  if (low === 'select count(*) as c from clients') {
    return { rows: [{ c: state.clients.length }] };
  }
  if (low.includes('from clients c order by')) {
    const rows = state.clients.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((c) => {
      const ups = state.uploads.filter((u) => Number(u.client_id) === Number(c.id) && !u.deleted_at && !u.is_duplicate);
      const codes = state.access_codes.filter((ac) => Number(ac.client_id) === Number(c.id));
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

  // ----- ACCESS CODES -----
  if (low.startsWith('insert into access_codes')) {
    const id = nextId('access_codes');
    const row = {
      id,
      code: String(p[0] || '').toUpperCase(),
      client_id: p[1],
      client_name: p[2],
      branch: p[3] || null,
      status: 'unused',
      duration_hours: Number(p[4] || 24),
      created_by: p[5],
      created_at: nowISO(),
      activated_at: null,
      expires_at: null,
      revoked_at: null,
      last_login_at: null,
      last_activity_at: null,
      failed_attempts: 0,
      locked_until: null
    };
    state.access_codes.push(row);
    save(state);
    console.log('Code saved:', row.code, 'id=', id);
    return { lastInsertRowid: id, changes: 1 };
  }
  if (low.startsWith('select * from access_codes where code =')) {
    const code = String(p[0] || '').toUpperCase();
    const row = state.access_codes.find((c) => String(c.code).toUpperCase() === code) || null;
    return { rows: row ? [row] : [] };
  }
  if (low.startsWith('select id from access_codes where code =')) {
    const code = String(p[0] || '').toUpperCase();
    const row = state.access_codes.find((c) => String(c.code).toUpperCase() === code);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (low.startsWith('select * from access_codes where id =')) {
    const row = byId(state.access_codes, p[0]);
    return { rows: row ? [row] : [] };
  }
  if (low.includes('from access_codes ac order by')) {
    const rows = state.access_codes.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((ac) => {
      const ups = state.uploads.filter((u) => Number(u.access_code_id) === Number(ac.id) && !u.deleted_at);
      const upsOk = ups.filter((u) => !u.is_duplicate);
      return {
        ...ac,
        upload_count: ups.length,
        total_amount: upsOk.reduce((s, u) => s + (u.total_amount || 0), 0)
      };
    });
    return { rows };
  }
  if (low.includes("from access_codes where status = 'active'")) {
    return { rows: [{ c: state.access_codes.filter((c) => c.status === 'active').length }] };
  }
  if (low.includes('from access_codes where status in')) {
    return { rows: [{ c: state.access_codes.filter((c) => ['expired', 'revoked', 'suspended'].includes(c.status)).length }] };
  }
  if (low.startsWith('update access_codes')) {
    // bulk expire
    if (low.includes('where status =') && low.includes('expired')) {
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
    const id = p[p.length - 1];
    const c = byId(state.access_codes, id);
    if (!c) {
      console.warn('UPDATE code not found id=', id, 'params', p);
      return { changes: 0 };
    }
    if (low.includes("status = 'active'") && low.includes('activated_at')) {
      c.status = 'active';
      c.activated_at = p[0];
      c.expires_at = p[1];
      c.last_login_at = nowISO();
      c.failed_attempts = 0;
    } else if (low.includes('last_login_at') && low.includes('failed_attempts')) {
      c.last_login_at = nowISO();
      c.failed_attempts = 0;
    }
    if (low.includes('last_activity_at')) c.last_activity_at = nowISO();
    if (low.includes("status = 'expired'") && !low.includes('where status =')) c.status = 'expired';
    if (low.includes("status = 'revoked'")) { c.status = 'revoked'; c.revoked_at = nowISO(); }
    if (low.includes("status = 'suspended'")) c.status = 'suspended';
    if (low.includes('revoked_at = null') || low.includes('revoked_at = null')) {
      c.status = 'active';
      c.revoked_at = null;
    }
    if (low.includes('expires_at = ?') && low.includes('duration_hours')) {
      c.expires_at = p[0];
      c.duration_hours = (c.duration_hours || 0) + Number(p[1] || 0);
      if (['expired', 'revoked', 'suspended'].includes(c.status)) c.status = 'active';
    }
    save(state);
    return { changes: 1 };
  }

  // ----- SESSIONS -----
  if (low.startsWith('insert into sessions')) {
    state.sessions.push({
      id: p[0], role: p[1], admin_id: p[2], access_code_id: p[3], client_id: p[4],
      created_at: nowISO(), last_seen_at: nowISO(), expires_at: p[5], ip: p[6], user_agent: p[7]
    });
    save(state);
    return { changes: 1 };
  }
  if (low.startsWith('select * from sessions where id =')) {
    const row = state.sessions.find((x) => x.id === p[0]) || null;
    return { rows: row ? [row] : [] };
  }
  if (low.startsWith('delete from sessions where id =')) {
    state.sessions = state.sessions.filter((x) => x.id !== p[0]);
    save(state);
    return { changes: 1 };
  }
  if (low.startsWith('delete from sessions where access_code_id =')) {
    const aid = Number(p[0]);
    state.sessions = state.sessions.filter((x) => Number(x.access_code_id) !== aid);
    save(state);
    return { changes: 1 };
  }
  if (low.startsWith('update sessions set last_seen_at')) {
    const row = state.sessions.find((x) => x.id === p[0]);
    if (row) { row.last_seen_at = nowISO(); save(state); }
    return { changes: 1 };
  }
  if (low.includes('from sessions') && low.includes("role = 'client'")) {
    const thresholdSec = 90;
    const cut = Date.now() - thresholdSec * 1000;
    const online = state.sessions.filter((sess) => {
      if (sess.role !== 'client') return false;
      const t = new Date(String(sess.last_seen_at).replace(' ', 'T') + 'Z').getTime();
      return t >= cut || new Date(sess.last_seen_at).getTime() >= cut;
    });
    if (low.includes('count(distinct access_code_id)')) {
      return { rows: [{ c: new Set(online.map((x) => x.access_code_id)).size }] };
    }
    const rows = online.map((sess) => {
      const ac = byId(state.access_codes, sess.access_code_id) || {};
      return {
        session_id: sess.id, last_seen_at: sess.last_seen_at, login_at: sess.created_at,
        code: ac.code, client_name: ac.client_name, branch: ac.branch, status: ac.status, expires_at: ac.expires_at
      };
    });
    return { rows };
  }

  // ----- UPLOADS -----
  if (low.startsWith('insert into uploads')) {
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
  if (low.includes('from uploads where content_hash =')) {
    const row = state.uploads.find((u) =>
      u.content_hash === p[0] && Number(u.access_code_id) === Number(p[1]) && !u.deleted_at && !u.is_duplicate
    );
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (low.startsWith('select * from uploads where id =')) {
    const row = byId(state.uploads, p[0]);
    if (row && low.includes('deleted_at is null') && row.deleted_at) return { rows: [] };
    return { rows: row ? [row] : [] };
  }
  if (low.startsWith('update uploads set deleted_at')) {
    const u = byId(state.uploads, p[0]);
    if (u) {
      u.deleted_at = nowISO();
      if (low.includes('stored_filename = null')) u.stored_filename = null;
      save(state);
    }
    return { changes: 1 };
  }
  if (low.includes('from uploads where deleted_at is null order by created_at desc limit 15')) {
    return { rows: state.uploads.filter((u) => !u.deleted_at).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 15) };
  }
  if (low.includes('from uploads where deleted_at is null order by created_at desc limit 500')) {
    return { rows: state.uploads.filter((u) => !u.deleted_at).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 500) };
  }
  if (low.includes('from uploads where access_code_id =') && low.includes('limit 20')) {
    const rows = state.uploads.filter((u) => Number(u.access_code_id) === Number(p[0]) && !u.deleted_at)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 20);
    return { rows };
  }
  if (low.includes('from uploads where') && low.includes('sum(total_amount)')) {
    let list = state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate);
    if (low.includes('access_code_id = ?')) {
      list = list.filter((u) => Number(u.access_code_id) === Number(p[0]));
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
  if (low.includes('group by client_name')) {
    const map = {};
    state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate).forEach((u) => {
      const k = (u.client_name || '') + '|' + (u.branch || '');
      if (!map[k]) map[k] = { client_name: u.client_name, branch: u.branch, uploads: 0, total_amount: 0, records: 0 };
      map[k].uploads++; map[k].total_amount += u.total_amount || 0; map[k].records += u.records_valid || 0;
    });
    return { rows: Object.values(map).sort((a, b) => b.total_amount - a.total_amount) };
  }
  if (low.includes('group by branch')) {
    const map = {};
    state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate).forEach((u) => {
      const k = u.branch || '(none)';
      if (!map[k]) map[k] = { branch: k, uploads: 0, total_amount: 0, records: 0 };
      map[k].uploads++; map[k].total_amount += u.total_amount || 0; map[k].records += u.records_valid || 0;
    });
    return { rows: Object.values(map).sort((a, b) => b.total_amount - a.total_amount) };
  }
  if (low.includes('group by date(created_at)') || low.includes('as day')) {
    const map = {};
    state.uploads.filter((u) => !u.deleted_at && !u.is_duplicate).forEach((u) => {
      const day = String(u.created_at || '').slice(0, 10);
      if (!map[day]) map[day] = { day, uploads: 0, total_amount: 0, records: 0 };
      map[day].uploads++; map[day].total_amount += u.total_amount || 0; map[day].records += u.records_valid || 0;
    });
    return { rows: Object.values(map).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 60) };
  }
  if (low.includes('retention_until') && low.includes("datetime('now')")) {
    const now = Date.now();
    const rows = state.uploads.filter((u) => !u.deleted_at && u.retention_until && new Date(u.retention_until).getTime() < now)
      .map((u) => ({ id: u.id, stored_filename: u.stored_filename }));
    return { rows };
  }

  // ----- AUDIT -----
  if (low.startsWith('insert into audit_logs')) {
    const id = nextId('audit_logs');
    state.audit_logs.push({
      id, actor_role: p[0], actor_id: p[1], action: p[2], detail: p[3], ip: p[4], created_at: nowISO()
    });
    save(state);
    return { lastInsertRowid: id, changes: 1 };
  }
  if (low.includes('from audit_logs order by created_at desc limit 20')) {
    return { rows: state.audit_logs.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 20) };
  }
  if (low.includes("action in ('code_invalid'") || low.includes('code_invalid')) {
    return {
      rows: state.audit_logs.filter((a) => ['code_invalid', 'admin_login_failed'].includes(a.action))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 50)
    };
  }

  console.warn('Unhandled SQL:', s, 'params=', p);
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
