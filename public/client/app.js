const $ = (s) => document.querySelector(s);
const money = (n) => Number(n || 0).toLocaleString();

let nameMap = {};
let cleanedRows = [];
let reportRows = [];
let naRows = [];
let summary = {};
let availableDates = [];
let selectedDay = null;
let lastFile = null;

async function api(path, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 90000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      credentials: 'include',
      signal: controller.signal,
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
      body: opts.body instanceof FormData || typeof opts.body === 'string' ? opts.body
        : opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || ('HTTP ' + res.status));
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out — server may be waking up. Wait 30s and try again.');
    if (e.message === 'Failed to fetch') throw new Error('Cannot reach server (sleeping or network). Open the site, wait 40s, then upload again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function wakeServer() {
  try {
    await api('/api/client/me', { timeoutMs: 60000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function registerUpload(file, meta) {
  // try with file first
  try {
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('meta', JSON.stringify(meta));
    return await api('/api/client/uploads', { method: 'POST', body: fd, timeoutMs: 120000 });
  } catch (e1) {
    // fallback: log totals only (no file) so admin still sees the amount
    try {
      return await api('/api/client/uploads', {
        method: 'POST',
        body: { ...meta, metaOnly: true },
        timeoutMs: 90000
      });
    } catch (e2) {
      throw e1;
    }
  }
}

function status(msg, ok) {
  const el = $('#status');
  el.textContent = msg;
  el.className = 'alert ' + (ok === false ? 'err' : ok ? 'ok' : '');
  el.classList.remove('hidden');
}

function normalizeKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}
function applyNameMap(name) {
  const key = normalizeKey(name);
  if (nameMap[key]) return nameMap[key].toUpperCase();
  const nc = key.replace(/,/g, '');
  for (const k of Object.keys(nameMap)) {
    if (normalizeKey(k).replace(/,/g, '') === nc) return nameMap[k].toUpperCase();
  }
  return name;
}

function cleanData(rows) {
  const records = [];
  let currentBranch = null, headers = 0, totals = 0, bad = 0;
  const branchesSet = new Set(), datesSet = new Set();
  let totalAmount = 0;
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v)) return v;
    if (typeof v === 'number' && v > 30000 && v < 60000)
      return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  function fmt(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const colA = row[0] != null ? String(row[0]).trim() : '';
    if (colA && colA.includes('Individual Loans Disbursal')) {
      const m = colA.match(/,\s*(.+)$/);
      currentBranch = m ? m[1].trim() : colA;
      headers++;
      continue;
    }
    if (colA && colA.toLowerCase().startsWith('total')) { totals++; continue; }
    const amt = typeof row[5] === 'number' ? row[5] : parseFloat(row[5]);
    const customer = row[4];
    if (!(amt > 0) || !customer || !currentBranch) { bad++; continue; }
    const dt = parseDate(row[7]) || parseDate(row[8]);
    if (!dt) { bad++; continue; }
    const officerStr = row[9] != null ? String(row[9]).trim() : 'UNKNOWN';
    const offKey = officerStr.toUpperCase().replace(/\s+/g, ' ');
    const isNA = !officerStr || /^(NA|N\/A|UNKNOWN|-|NULL|N\.A\.?)$/.test(offKey);
    const dateStr = fmt(dt);
    records.push({
      Date: dateStr, Branch: currentBranch, Customer: String(customer).trim(),
      Amount: Math.round(amt * 100) / 100, 'Loan Officer': officerStr, _isNA: isNA
    });
    branchesSet.add(currentBranch);
    datesSet.add(dateStr);
    totalAmount += amt;
  }
  return {
    records,
    dates: Array.from(datesSet).sort(),
    stats: { headers, totals, bad, clean: records.length },
    summary: {
      records: records.length,
      totalAmount: Math.round(totalAmount),
      branches: branchesSet.size,
      skipped: headers + totals + bad
    }
  };
}

function buildSalespersonReport(records, day) {
  const map = {};
  records.forEach((r) => {
    const off = r['Loan Officer'] || 'UNKNOWN';
    if (!map[off]) map[off] = { total: 0, daily: 0, branches: {} };
    const amt = Number(r.Amount) || 0;
    map[off].total += amt;
    if (r.Date === day) map[off].daily += amt;
    map[off].branches[r.Branch || ''] = (map[off].branches[r.Branch || ''] || 0) + amt;
  });
  const list = Object.keys(map).map((off) => {
    let mainBranch = '', maxAmt = -1;
    for (const b in map[off].branches) {
      if (map[off].branches[b] > maxAmt) { maxAmt = map[off].branches[b]; mainBranch = b; }
    }
    let branchDisp = mainBranch.replace(/ BRANCH$/i, '').replace(/Chaguo Magic HQ/i, 'HEADOFFICE').toUpperCase();
    let displayName = off;
    if (off.includes(', ')) {
      const p = off.split(', ');
      displayName = (p[1] + ' ' + p[0]).trim();
    }
    displayName = applyNameMap(displayName.toUpperCase());
    return { name: displayName, branch: branchDisp, daily: Math.round(map[off].daily), total: Math.round(map[off].total) };
  });
  const merged = {};
  list.forEach((r) => {
    if (!merged[r.name]) merged[r.name] = { name: r.name, branch: r.branch, daily: 0, total: 0, branchAmt: {} };
    merged[r.name].daily += r.daily;
    merged[r.name].total += r.total;
    merged[r.name].branchAmt[r.branch] = (merged[r.name].branchAmt[r.branch] || 0) + r.total;
  });
  Object.keys(merged).forEach((k) => {
    let best = '', max = -1;
    for (const b in merged[k].branchAmt) {
      if (merged[k].branchAmt[b] > max) { max = merged[k].branchAmt[b]; best = b; }
    }
    merged[k].branch = best;
  });
  return Object.values(merged).sort((a, b) => b.total - a.total)
    .map((r, i) => ({ sno: i + 1, ...r }));
}

function buildBranchReport(personRows) {
  const map = {};
  personRows.forEach((r) => {
    const br = (r.branch || 'UNKNOWN').toUpperCase();
    if (!map[br]) map[br] = { branch: br, daily: 0, total: 0, staff: 0 };
    map[br].daily += Number(r.daily) || 0;
    map[br].total += Number(r.total) || 0;
    map[br].staff += 1;
  });
  return Object.values(map).map((r) => ({
    ...r,
    daily: Math.round(r.daily),
    total: Math.round(r.total),
    avg: r.staff ? Math.round((r.total / r.staff) * 100) / 100 : 0
  })).sort((a, b) => b.avg - a.avg);
}

function rebuildReport() {
  reportRows = buildSalespersonReport(cleanedRows, selectedDay);
  naRows = cleanedRows.filter((r) => r._isNA).map((r) => ({
    Branch: (r.Branch || '').replace(/ BRANCH$/i, '').toUpperCase(),
    Customer: r.Customer, Amount: r.Amount, Date: r.Date, Officer: r['Loan Officer'] || 'N/A'
  }));
  renderTable('report');
  $('#resultStats').innerHTML = [
    ['Valid records', summary.records],
    ['Skipped rows', summary.skipped],
    ['Total amount', money(summary.totalAmount)],
    ['Officers', reportRows.length],
    ['Branches', summary.branches]
  ].map(([l, v]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
}

function renderTable(which) {
  const host = $('#tableHost');
  if (which === 'report') {
    const totalDaily = reportRows.reduce((s, r) => s + r.daily, 0);
    host.innerHTML = `<table><thead><tr><th>S/NO</th><th>NAME</th><th>BRANCH</th><th class="num">DAILY</th><th class="num">TOTAL</th></tr></thead><tbody>
      ${reportRows.map((r) => `<tr><td>${r.sno}</td><td>${r.name}</td><td>${r.branch}</td><td class="num">${money(r.daily)}</td><td class="num">${money(r.total)}</td></tr>`).join('')}
      <tr><td></td><td><strong>TOTAL</strong></td><td></td><td class="num"><strong>${money(totalDaily)}</strong></td><td class="num"><strong>${money(summary.totalAmount)}</strong></td></tr>
    </tbody></table>`;
  } else if (which === 'branch') {
    const br = buildBranchReport(reportRows);
    host.innerHTML = `<table><thead><tr><th>#</th><th>BRANCH</th><th class="num">TODAY</th><th class="num">TOTAL</th><th>STAFF</th><th class="num">AVG</th></tr></thead><tbody>
      ${br.map((r, i) => `<tr><td>${i + 1}</td><td>${r.branch}</td><td class="num">${money(r.daily)}</td><td class="num">${money(r.total)}</td><td>${r.staff}</td><td class="num">${money(r.avg)}</td></tr>`).join('')}
    </tbody></table>`;
  } else if (which === 'na') {
    host.innerHTML = naRows.length
      ? `<table><thead><tr><th>#</th><th>BRANCH</th><th>CLIENT</th><th class="num">AMOUNT</th><th>DATE</th><th>OFFICER</th></tr></thead><tbody>
        ${naRows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.Branch}</td><td>${r.Customer}</td><td class="num">${money(r.Amount)}</td><td>${r.Date}</td><td>${r.Officer}</td></tr>`).join('')}
      </tbody></table>`
      : '<p class="muted">No N/A officers</p>';
  } else {
    host.innerHTML = `<table><thead><tr><th>Date</th><th>Branch</th><th>Customer</th><th class="num">Amount</th><th>Officer</th></tr></thead><tbody>
      ${cleanedRows.slice(0, 50).map((r) => `<tr><td>${r.Date}</td><td>${r.Branch}</td><td>${r.Customer}</td><td class="num">${money(r.Amount)}</td><td>${r['Loan Officer']}</td></tr>`).join('')}
    </tbody></table>`;
  }
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    renderTable(t.dataset.t);
  };
});

async function refreshMe() {
  const me = await api('/api/client/me');
  const exp = me.expiresAt ? new Date(me.expiresAt) : null;
  const left = exp ? Math.max(0, Math.round((exp - Date.now()) / 3600000)) : null;
  $('#clientMeta').textContent =
    `${me.clientName || ''}${me.branch ? ' · ' + me.branch : ''} · Code ${me.code} · ${me.status}` +
    (exp ? ` · expires ${exp.toLocaleString()} (${left}h left)` : '');
  $('#clientCards').innerHTML = [
    ['Your total disbursed', money(me.stats.total_amount)],
    ['Your uploads', me.stats.uploads],
    ['Your records', me.stats.records]
  ].map(([l, v]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  $('#historyBody').innerHTML = (me.recent || []).map((u) =>
    `<tr><td>${u.created_at}</td><td>${u.original_filename || ''}</td><td>${money(u.total_amount)}</td>
     <td>${u.records_valid}</td><td>${u.report_day || ''}</td>
     <td>${u.is_duplicate ? '<span class="pill">duplicate</span>' : ''}</td></tr>`
  ).join('') || '<tr><td colspan="6" class="muted">No uploads yet</td></tr>';
}

$('#loginBtn').onclick = async () => {
  try {
    await api('/api/client/login', { method: 'POST', body: { code: $('#codeInput').value } });
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    await refreshMe();
    setInterval(() => api('/api/client/heartbeat', { method: 'POST' }).catch(() => {}), 30000);
  } catch (e) {
    $('#loginErr').textContent = e.message;
    $('#loginErr').className = 'alert err';
    $('#loginErr').classList.remove('hidden');
  }
};

$('#logoutBtn').onclick = async () => {
  await api('/api/client/logout', { method: 'POST' });
  location.reload();
};

$('#dropzone').onclick = () => $('#fileInput').click();
$('#namesDrop').onclick = () => $('#namesInput').click();
['dragover', 'drop'].forEach((ev) => {
  $('#dropzone').addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
});

$('#fileInput').onchange = () => { if ($('#fileInput').files[0]) handleFile($('#fileInput').files[0]); };
$('#namesInput').onchange = () => {
  const f = $('#namesInput').files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    let start = 0;
    if (rows[0] && String(rows[0][0]).toUpperCase().includes('FIND')) start = 1;
    let n = 0;
    for (let i = start; i < rows.length; i++) {
      const a = String(rows[i][0] || '').trim();
      const b = String(rows[i][1] || '').trim();
      if (a && b) { nameMap[normalizeKey(a)] = b.toUpperCase(); n++; }
    }
    $('#mapBadge').textContent = n + ' name replacements loaded';
    $('#mapBadge').className = 'badge on';
  };
  reader.readAsArrayBuffer(f);
};

async function sha256(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleFile(file) {
  if (typeof XLSX === 'undefined') { status('SheetJS failed to load', false); return; }
  status('Processing ' + file.name + '…');
  lastFile = file;
  const ab = await file.arrayBuffer();
  const contentHash = await sha256(ab);
  const wb = XLSX.read(new Uint8Array(ab), { type: 'array', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: false });
  const result = cleanData(rows);
  cleanedRows = result.records;
  summary = result.summary;
  availableDates = result.dates;
  if (!cleanedRows.length) { status('No valid loan records found', false); return; }

  $('#daySelect').innerHTML = availableDates.map((d) => `<option value="${d}">${d}</option>`).join('');
  selectedDay = availableDates[availableDates.length - 1];
  $('#daySelect').value = selectedDay;
  rebuildReport();
  $('#resultsPanel').classList.remove('hidden');

  // register upload with server (wake + retry)
  const meta = {
    recordsValid: summary.records,
    recordsSkipped: summary.skipped,
    recordsTotal: summary.records + summary.skipped,
    totalAmount: summary.totalAmount,
    reportDay: selectedDay,
    contentHash,
    originalFilename: file.name,
    fileSize: file.size
  };
  status('Connecting to server…', true);
  await wakeServer();
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      status('Saving to server (try ' + attempt + '/3)…', true);
      const reg = await registerUpload(file, meta);
      status(
        '✓ ' + summary.records + ' records · total ' + money(summary.totalAmount) +
        (reg.isDuplicate ? ' · flagged as possible duplicate (not double-counted in admin totals)' : '') +
        (reg.metaOnly ? ' · totals saved (file not stored)' : ''),
        true
      );
      await refreshMe();
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  if (lastErr) {
    status('Report ready on this device. Server log failed: ' + lastErr.message, false);
  }
}

$('#daySelect').onchange = () => {
  selectedDay = $('#daySelect').value;
  rebuildReport();
};

$('#dlClean').onclick = () => {
  if (!cleanedRows.length) return;
  const ws = XLSX.utils.json_to_sheet(cleanedRows.map((r) => ({
    Date: r.Date, Branch: r.Branch, Customer: r.Customer, Amount: r.Amount, 'Loan Officer': r['Loan Officer']
  })));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Clean Data');
  XLSX.writeFile(wb, 'Cleaned_Disbursements.xlsx');
};

$('#dlReport').onclick = async () => {
  if (!reportRows.length || typeof ExcelJS === 'undefined') return;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Daily Report');
  ws.addRow(['', '', 'DAILY REPORT ' + selectedDay]);
  ws.addRow(['S/NO', 'NAME', 'BRANCH', 'DAILY SALES', 'TOTAL SALES']);
  reportRows.forEach((r) => ws.addRow([r.sno, r.name, r.branch, r.daily, r.total]));
  ws.addRow(['', 'TOTAL', '', reportRows.reduce((s, r) => s + r.daily, 0), summary.totalAmount]);
  const br = buildBranchReport(reportRows);
  const wsB = wb.addWorksheet('per branch');
  wsB.addRow(['#', 'BRANCH', 'TODAYS SALES', 'TOTAL SALES', 'NO OF STAFFS', 'AVERAGE SALES']);
  br.forEach((r, i) => wsB.addRow([i + 1, r.branch, r.daily, r.total, r.staff, r.avg]));
  if (naRows.length) {
    const wsN = wb.addWorksheet('N-A Officers');
    wsN.addRow(['#', 'BRANCH', 'CLIENT', 'AMOUNT', 'DATE', 'OFFICER']);
    naRows.forEach((r, i) => wsN.addRow([i + 1, r.Branch, r.Customer, r.Amount, r.Date, r.Officer]));
  }
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf]));
  a.download = 'Daily_Report_' + (selectedDay || '').replace(/-/g, '') + '.xlsx';
  a.click();
};

// session restore
api('/api/client/me').then(async () => {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  await refreshMe();
  setInterval(() => api('/api/client/heartbeat', { method: 'POST' }).catch(() => {}), 30000);
}).catch(() => {});
