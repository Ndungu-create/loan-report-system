const $ = (s) => document.querySelector(s);
const money = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}
function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}

$('#loginBtn').onclick = async () => {
  $('#loginErr').classList.add('hidden');
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      body: { email: $('#email').value, password: $('#password').value }
    });
    $('#adminName').textContent = data.email;
    showApp();
    loadDashboard();
  } catch (e) {
    $('#loginErr').textContent = e.message;
    $('#loginErr').className = 'alert err';
    $('#loginErr').classList.remove('hidden');
  }
};

$('#logoutBtn').onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
};

document.querySelectorAll('.nav').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
    const page = btn.dataset.page;
    $(`#page-${page}`).classList.remove('hidden');
    $('#pageTitle').textContent = btn.textContent;
    if (page === 'dashboard') loadDashboard();
    if (page === 'codes') loadCodes();
    if (page === 'clients') loadClients();
    if (page === 'uploads') loadUploads();
    if (page === 'activity') loadActivity();
    if (page === 'finance') loadFinance();
  };
});

async function loadDashboard() {
  const d = await api('/api/admin/dashboard');
  $('#dashCards').innerHTML = [
    ['Total disbursed', money(d.totals.total_amount)],
    ['Uploads', d.totals.upload_count],
    ['Records', d.totals.records],
    ['Clients', d.clients],
    ['Online now', d.online],
    ['Active codes', d.codesActive],
    ['Expired/revoked', d.codesExpired]
  ].map(([l, v]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  $('#recentUploads').innerHTML = (d.recentUploads || []).map((u) =>
    `<tr><td>${u.created_at}</td><td>${u.client_name || ''}</td><td>${u.original_filename || ''}</td>
     <td>${money(u.total_amount)}</td><td>${u.records_valid || 0}${u.is_duplicate ? ' <span class="pill">dup</span>' : ''}</td></tr>`
  ).join('') || '<tr><td colspan="5" class="muted">No uploads yet</td></tr>';

  $('#recentAudit').innerHTML = (d.recentAudit || []).map((a) =>
    `<tr><td>${a.created_at}</td><td>${a.action}</td><td class="muted">${a.detail || ''}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="muted">—</td></tr>';
}

$('#codeDuration').onchange = () => {
  $('#customHoursWrap').classList.toggle('hidden', $('#codeDuration').value !== 'custom');
};

$('#createCodeBtn').onclick = async () => {
  const msg = $('#codeMsg');
  try {
    let durationHours = Number($('#codeDuration').value);
    if ($('#codeDuration').value === 'custom') durationHours = Number($('#customHours').value);
    const body = {
      clientName: $('#codeClientName').value.trim(),
      branch: $('#codeBranch').value.trim(),
      durationHours,
      code: $('#manualCode').value.trim() || undefined
    };
    const data = await api('/api/admin/codes', { method: 'POST', body });
    msg.textContent = `Code created: ${data.code} (${data.durationHours}h). Starts when client first activates.`;
    msg.className = 'alert ok';
    msg.classList.remove('hidden');
    $('#manualCode').value = '';
    loadCodes();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'alert err';
    msg.classList.remove('hidden');
  }
};

async function loadCodes() {
  const { codes } = await api('/api/admin/codes');
  $('#codesBody').innerHTML = codes.map((c) => `
    <tr>
      <td class="mono">${c.code}</td>
      <td>${c.client_name || ''}</td>
      <td>${c.branch || ''}</td>
      <td><span class="pill ${c.status}">${c.status}</span></td>
      <td>${c.expires_at || '— (on first use)'}</td>
      <td>${c.upload_count || 0}</td>
      <td>${money(c.total_amount)}</td>
      <td>
        <button class="btn outline sm" data-act="extend" data-id="${c.id}">+24h</button>
        <button class="btn outline sm" data-act="suspend" data-id="${c.id}">Suspend</button>
        <button class="btn outline sm" data-act="reactivate" data-id="${c.id}">Reactivate</button>
        <button class="btn outline sm" data-act="revoke" data-id="${c.id}">Revoke</button>
      </td>
    </tr>`).join('');

  $('#codesBody').querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      try {
        if (act === 'extend') await api(`/api/admin/codes/${id}/extend`, { method: 'POST', body: { extraHours: 24 } });
        if (act === 'revoke') await api(`/api/admin/codes/${id}/revoke`, { method: 'POST' });
        if (act === 'suspend') await api(`/api/admin/codes/${id}/suspend`, { method: 'POST' });
        if (act === 'reactivate') await api(`/api/admin/codes/${id}/reactivate`, { method: 'POST' });
        loadCodes();
      } catch (e) { alert(e.message); }
    };
  });
}

$('#addClientBtn').onclick = async () => {
  try {
    await api('/api/admin/clients', {
      method: 'POST',
      body: { name: $('#clientName').value, branch: $('#clientBranch').value, notes: $('#clientNotes').value }
    });
    $('#clientName').value = '';
    loadClients();
  } catch (e) { alert(e.message); }
};

async function loadClients() {
  const { clients } = await api('/api/admin/clients');
  $('#clientsBody').innerHTML = clients.map((c) =>
    `<tr><td>${c.name}</td><td>${c.branch || ''}</td><td>${c.upload_count}</td><td>${money(c.total_amount)}</td><td>${c.last_login_at || '—'}</td></tr>`
  ).join('');
}

async function loadUploads() {
  const { uploads } = await api('/api/admin/uploads');
  $('#uploadsBody').innerHTML = uploads.map((u) => `
    <tr>
      <td>${u.created_at}</td>
      <td>${u.client_name || ''}<div class="muted">${u.branch || ''}</div></td>
      <td>${u.original_filename || ''}</td>
      <td>${u.file_size ? Math.round(u.file_size / 1024) + ' KB' : '—'}</td>
      <td>${u.records_valid}/${u.records_total || u.records_valid}</td>
      <td>${money(u.total_amount)}</td>
      <td>${u.is_duplicate ? 'Yes' : ''}</td>
      <td>
        ${u.stored_filename ? `<a class="btn outline sm" href="/api/admin/uploads/${u.id}/file">Download</a>` : ''}
        <button class="btn outline sm" data-del="${u.id}">Delete</button>
      </td>
    </tr>`).join('');
  $('#uploadsBody').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this file?')) return;
      await api(`/api/admin/uploads/${b.dataset.del}`, { method: 'DELETE' });
      loadUploads();
    };
  });
}

async function loadActivity() {
  const d = await api('/api/admin/activity');
  $('#onlineHint').textContent = `(seen in last ${d.onlineThresholdSeconds}s)`;
  $('#onlineBody').innerHTML = (d.onlineClients || []).map((c) =>
    `<tr><td class="mono">${c.code}</td><td>${c.client_name}</td><td>${c.branch || ''}</td><td>${c.login_at}</td><td>${c.last_seen_at}</td><td>${c.expires_at || ''}</td></tr>`
  ).join('') || '<tr><td colspan="6" class="muted">No one online</td></tr>';
  $('#failedBody').innerHTML = (d.failed || []).map((f) =>
    `<tr><td>${f.created_at}</td><td>${f.action}</td><td>${f.detail || ''}</td><td>${f.ip || ''}</td></tr>`
  ).join('') || '<tr><td colspan="4" class="muted">—</td></tr>';
}

async function loadFinance() {
  const d = await api('/api/admin/finance');
  $('#finClient').innerHTML = d.byClient.map((r) =>
    `<tr><td>${r.client_name}</td><td>${r.branch || ''}</td><td>${r.uploads}</td><td>${money(r.total_amount)}</td></tr>`).join('');
  $('#finBranch').innerHTML = d.byBranch.map((r) =>
    `<tr><td>${r.branch}</td><td>${r.uploads}</td><td>${money(r.total_amount)}</td></tr>`).join('');
  $('#finDay').innerHTML = d.byDay.map((r) =>
    `<tr><td>${r.day}</td><td>${r.uploads}</td><td>${money(r.total_amount)}</td><td>${r.records}</td></tr>`).join('');
}

// boot
api('/api/admin/me').then((d) => {
  $('#adminName').textContent = d.admin.email;
  showApp();
  loadDashboard();
}).catch(() => showLogin());
