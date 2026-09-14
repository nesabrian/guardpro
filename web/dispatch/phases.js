/* Guard Pro dispatch — Phases 2 to 5 add-on. Loaded after the board script; extends it in place. */
(function () {
  const P = { requests: null, reports: null, repFilter: { status: 'submitted', kind: '' }, ts: null, tsWs: S.ws, inv: null, invStatus: '', aging: null, rates: null, paySub: 'timesheets', patrol: null, runsheets: null, patrolDate: TODAY, cp: {}, notes: { unread: 0, list: [] } };
  const money = n => '$' + (Math.round((+n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtAt = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const labelDate = ds => { const d = parseLocal(ds); return `${DAY[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };
  const posName = id => { const r = S.pos.get(String(id)); return r ? r.pos.name : id; };

  /* ---------- tabs, badges, bell ---------- */
  const tabs = $('#tabs'); const mk = (v, html) => { const b = document.createElement('button'); b.dataset.view = v; b.innerHTML = html; return b; };
  const before = tabs.querySelector('[data-view=officers]');
  tabs.insertBefore(mk('requests', 'Requests <span class="badge" id="badge-req" hidden></span>'), before);
  tabs.insertBefore(mk('reports', 'Reports <span class="badge" id="badge-rep" hidden></span>'), before);
  tabs.appendChild(mk('pay', 'Pay &amp; bill')); tabs.appendChild(mk('patrol', 'Patrol'));
  const bell = document.createElement('button'); bell.className = 'bell'; bell.id = 'bell'; bell.innerHTML = '🔔<span class="badge" id="badge-bell" hidden></span>'; bell.title = 'Notifications';
  $('#status').before(bell);
  const style = document.createElement('style'); style.textContent = `
  .badge{display:inline-block;min-width:18px;padding:1px 5px;border-radius:9px;background:var(--gold);color:#1a1400;font-size:11px;font-weight:700;margin-left:4px;font-family:Barlow,sans-serif;letter-spacing:0;vertical-align:middle}
  .bell{background:none;border:0;color:#fff;font-size:16px;padding:0 8px;position:relative}
  .notes{position:absolute;right:16px;top:52px;width:360px;max-height:60vh;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);z-index:30;padding:6px 0}
  .notes div{padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px}.notes div.unread{background:var(--today)}.notes .t{color:var(--faint);font-size:11px}
  .photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px}.photos img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;border:1px solid var(--line);cursor:zoom-in}
  .lines input{width:100%;border:1px solid var(--line);border-radius:4px;padding:3px 6px;background:var(--surface);color:inherit;font:inherit;font-size:13px}
  .lines td{padding:4px 6px}
  .stops{display:flex;flex-direction:column;gap:8px}.stop{border:1px solid var(--line);border-radius:6px;padding:8px}
  .stat-row{display:flex;gap:16px;flex-wrap:wrap;padding:10px 16px}
  .kv2{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;font-size:13px}.kv2 div:nth-child(odd){color:var(--muted)}
  .pre{white-space:pre-wrap;background:var(--surface-2);padding:8px 10px;border-radius:6px;font-size:13px}
  .qr{display:inline-block;margin:8px;text-align:center;font-size:12px}`;
  document.head.appendChild(style);

  async function loadNotes() { try { P.notes = await API.get('/api/notifications'); const b = $('#badge-bell'); b.hidden = !P.notes.unread; b.textContent = P.notes.unread; } catch (e) {} }
  bell.addEventListener('click', async () => {
    let box = $('.notes'); if (box) { box.remove(); return; }
    await loadNotes(); box = document.createElement('div'); box.className = 'notes';
    box.innerHTML = P.notes.notifications.map(n => `<div class="${n.read_at ? '' : 'unread'}" data-link="${esc(n.link || '')}">${esc(n.text)}<div class="t">${fmtAt(n.at)}</div></div>`).join('') || '<div class="muted">Nothing yet.</div>';
    document.body.appendChild(box);
    box.addEventListener('click', e => { const d = e.target.closest('[data-link]'); if (d && d.dataset.link) { const map = { requests: 'requests', reports: 'reports', live: 'live', patrol: 'patrol' }; if (map[d.dataset.link]) setView(map[d.dataset.link]); } box.remove(); });
    if (P.notes.unread) { await API.send('POST', '/api/notifications/read'); $('#badge-bell').hidden = true; }
  });
  async function loadBadges() { try { const r = await API.get('/api/requests?status=pending'); P.requests = r; const b = $('#badge-req'); b.hidden = !r.pending; b.textContent = r.pending; } catch (e) {} try { const r = await API.get('/api/reports?status=submitted&days=30'); const b = $('#badge-rep'); b.hidden = !r.unreviewed; b.textContent = r.unreviewed; } catch (e) {} loadNotes(); }
  // second event stream for phase events
  try { const es = new EventSource('/api/events'); es.addEventListener('change', ev => { const d = JSON.parse(ev.data); if (d.type === 'requests') { loadBadges(); if (S.view === 'requests') loadRequests(); } if (d.type === 'reports') { loadBadges(); if (S.view === 'reports') loadReports(); } if (d.type === 'notify' && d.scope === 'dispatch') { loadNotes(); } if (d.type === 'timesheets' && S.view === 'pay') loadTimesheets(); if (d.type === 'invoices' && S.view === 'pay') loadInvoices(); if ((d.type === 'routes' || d.type === 'runsheets') && S.view === 'patrol') loadPatrol(); }); } catch (e) {}
  const _connect = connect; connect = async function () { await _connect(); if (S.db) loadBadges(); };
  if (S.db) loadBadges();

  /* ---------- loaders ---------- */
  async function loadRequests() { try { P.requests = await API.get('/api/requests?status=pending'); if (S.view === 'requests') renderContent(); } catch (e) { toast(e.message); } }
  async function loadReports() { try { const q = new URLSearchParams({ days: 30 }); if (P.repFilter.status) q.set('status', P.repFilter.status); if (P.repFilter.kind) q.set('kind', P.repFilter.kind); P.reports = await API.get('/api/reports?' + q); if (S.view === 'reports') renderContent(); } catch (e) { toast(e.message); } }
  async function loadTimesheets() { try { P.ts = await API.get('/api/timesheets/' + P.tsWs); if (S.view === 'pay') renderContent(); } catch (e) { toast(e.message); } }
  async function loadInvoices() { try { P.inv = await API.get('/api/invoices' + (P.invStatus ? '?status=' + P.invStatus : '')); P.aging = await API.get('/api/invoices/aging'); if (S.view === 'pay') renderContent(); } catch (e) { toast(e.message); } }
  async function loadRates() { try { P.rates = await API.get('/api/rates'); if (S.view === 'pay') renderContent(); } catch (e) { toast(e.message); } }
  async function loadPatrol() { try { P.patrol = await API.get('/api/routes'); P.runsheets = await API.get('/api/runsheets?date=' + P.patrolDate); if (S.view === 'patrol') renderContent(); } catch (e) { toast(e.message); } }
  const _setView = setView; setView = function (v) { _setView(v); if (v === 'requests') loadRequests(); if (v === 'reports') loadReports(); if (v === 'pay') { if (P.paySub === 'timesheets') loadTimesheets(); else if (P.paySub === 'rates') loadRates(); else loadInvoices(); } if (v === 'patrol') loadPatrol(); };

  /* ---------- sub bar ---------- */
  const _renderSub = renderSub; renderSub = function () {
    if (S.view === 'requests') { $('#sub').innerHTML = `<span class="muted">Officer requests waiting for a decision. Approving a pickup assigns the shift; approving a drop opens it on the shift board.</span><button class="btn sm" data-act2="reload-req">Refresh</button>`; return; }
    if (S.view === 'reports') { $('#sub').innerHTML = `<div class="seg">${[['submitted', 'New'], ['reviewed', 'Reviewed'], ['sent', 'Sent'], ['', 'All']].map(([v, l]) => `<button data-repstatus="${v}" class="${P.repFilter.status === v ? 'on' : ''}">${l}</button>`).join('')}</div><div class="seg">${[['', 'All types'], ['incident', 'Incidents'], ['daily', 'Daily'], ['patrol', 'Patrol']].map(([v, l]) => `<button data-repkind="${v}" class="${P.repFilter.kind === v ? 'on' : ''}">${l}</button>`).join('')}</div><input class="search" id="q" placeholder="Search reports…" value="${esc(S.q)}">`; return; }
    if (S.view === 'pay') {
      const seg = `<div class="seg">${[['timesheets', 'Timesheets'], ['invoices', 'Invoices'], ['aging', 'Aging'], ['rates', 'Rates & holidays']].map(([v, l]) => `<button data-paysub="${v}" class="${P.paySub === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
      if (P.paySub === 'timesheets') $('#sub').innerHTML = seg + `<div class="weeknav"><button class="btn" data-act2="ts-prev">‹</button><div class="wk">${weekLabel(P.tsWs)}</div><button class="btn" data-act2="ts-next">›</button></div><button class="btn" data-act2="ts-approve-all">Approve all complete</button><a class="btn" href="/api/timesheets/${P.tsWs}/payroll.csv">Payroll CSV</a><input class="search" id="q" placeholder="Search officers…" value="${esc(S.q)}">`;
      else if (P.paySub === 'invoices') $('#sub').innerHTML = seg + `<div class="seg">${[['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['paid', 'Paid']].map(([v, l]) => `<button data-invstatus="${v}" class="${P.invStatus === v ? 'on' : ''}">${l}</button>`).join('')}</div><label class="chk">From <input type="date" id="inv-from" value="${iso(addDays(parseLocal(S.ws), -7))}"></label><label class="chk">To <input type="date" id="inv-to" value="${iso(addDays(parseLocal(S.ws), -1))}"></label><button class="btn primary" data-act2="inv-generate">Generate invoices</button><input class="search" id="q" placeholder="Search sites…" value="${esc(S.q)}">`;
      else if (P.paySub === 'rates') $('#sub').innerHTML = seg + `<button class="btn primary" data-act2="rate-new">+ New rate</button><span class="muted">Defaults when no rate matches: bill ${money(P.rates ? P.rates.defaults.billRate : 0)}/h · pay ${money(P.rates ? P.rates.defaults.payRate : 0)}/h · overtime after ${P.rates ? P.rates.defaults.weeklyOt : 40} h/week</span>`;
      else $('#sub').innerHTML = seg + `<span class="muted">Sent invoices not yet paid, grouped by how overdue they are.</span>`;
      return;
    }
    if (S.view === 'patrol') { $('#sub').innerHTML = `<button class="btn primary" data-act2="route-new">+ New route</button><label class="chk">Runsheets for <input type="date" id="patrol-date" value="${P.patrolDate}"></label><span class="muted">Assign a route to a post in Sites &amp; posts; every shift on that post gets a runsheet.</span>`; return; }
    _renderSub();
  };

  /* ---------- content ---------- */
  const _renderContent = renderContent; renderContent = function () {
    if (!['requests', 'reports', 'pay', 'patrol'].includes(S.view)) return _renderContent();
    const c = $('#content'); if (!S.db) { c.innerHTML = '<div class="loading">Sign in to open the board.</div>'; return; }
    if (S.view === 'requests') c.innerHTML = renderRequests(); else if (S.view === 'reports') c.innerHTML = renderReports(); else if (S.view === 'pay') c.innerHTML = renderPay(); else c.innerHTML = renderPatrol();
  };
  function renderRequests() {
    const R = P.requests; if (!R) return '<div class="loading">Loading…</div>';
    const kindL = { pickup: 'Pick up', drop: 'Drop', swap: 'Swap' };
    return `<h3 style="margin:14px 16px 6px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Shift requests (${R.requests.length})</h3>
    <table class="list"><thead><tr><th>Type</th><th>Officer</th><th>Shift</th><th>Note</th><th>Asked</th><th></th></tr></thead><tbody>${R.requests.map(r => `<tr><td><span class="tag ${r.kind === 'pickup' ? 'ok' : r.kind === 'drop' ? 'off' : 'info'}">${kindL[r.kind]}</span></td><td>${esc(r.employee)}${r.target ? '<div class="small muted">→ ' + esc(r.target) + '</div>' : ''}</td><td>${r.shift ? esc(r.shift.label) : '<span class="muted">shift removed</span>'}</td><td class="small">${esc(r.note || '')}</td><td class="small muted">${fmtAt(r.at)}</td><td style="white-space:nowrap"><button class="btn sm primary" data-act2="req-approve" data-id="${r.id}">Approve</button> <button class="btn sm" data-act2="req-decline" data-id="${r.id}">Decline</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No pending shift requests.</td></tr>'}</tbody></table>
    <h3 style="margin:20px 16px 6px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Time-off requests (${R.timeOff.length})</h3>
    <table class="list"><thead><tr><th>Officer</th><th>Dates</th><th>Reason</th><th>Scheduled shifts affected</th><th>Asked</th><th></th></tr></thead><tbody>${R.timeOff.map(r => `<tr><td>${esc(r.employee)}</td><td>${r.from_date}${r.to_date !== r.from_date ? ' → ' + r.to_date : ''}</td><td class="small">${esc(r.note || '')}</td><td class="small">${r.conflicts.length ? r.conflicts.map(c => `<div style="color:var(--vacant)">${c.s.slice(5, 10)} ${tShort(c.s)} ${esc(c.site || '')}</div>`).join('') : '<span class="muted">none</span>'}</td><td class="small muted">${fmtAt(r.at)}</td><td style="white-space:nowrap"><button class="btn sm primary" data-act2="to-approve" data-id="${r.id}">Approve</button> <button class="btn sm" data-act2="to-decline" data-id="${r.id}">Decline</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No pending time-off requests.</td></tr>'}</tbody></table>`;
  }
  function renderReports() {
    const R = P.reports; if (!R) return '<div class="loading">Loading…</div>';
    const rows = R.reports.filter(r => matchQ(r.site, r.employee, r.title, JSON.stringify(r.fields)));
    return `<table class="list"><thead><tr><th>When</th><th>Type</th><th>Site</th><th>Officer</th><th>Title</th><th>Status</th></tr></thead><tbody>${rows.map(r => `<tr class="row ${S.sel && S.sel.type === 'report' && S.sel.id === r.id ? 'sel' : ''}" data-report="${r.id}"><td class="small">${fmtAt(r.at)}</td><td><span class="tag ${r.kind === 'incident' ? (r.flagged ? 'off' : 'armed') : r.kind === 'patrol' ? 'info' : ''}">${r.kind}</span></td><td>${esc(r.site)}</td><td>${esc(r.employee)}</td><td>${esc(r.title)}${r.photos.length ? ' <span class="tag">' + r.photos.length + ' 📷</span>' : ''}</td><td><span class="tag ${r.status === 'submitted' ? 'off' : r.status === 'sent' ? 'ok' : 'info'}">${r.status}</span></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No reports match.</td></tr>'}</tbody></table>`;
  }
  function renderPay() {
    if (P.paySub === 'timesheets') {
      const R = P.ts; if (!R || R.ws !== P.tsWs) return '<div class="loading">Loading…</div>';
      const rows = R.sheets.filter(s => matchQ(s.employee, s.customId));
      return `<div class="stat-row"><div class="stat"><b>${rows.length}</b>officers</div><div class="stat"><b>${fmtH(R.totals.hours)}</b>hours</div><div class="stat ${R.totals.ot ? 'warn' : ''}"><b>${fmtH(R.totals.ot)}</b>OT hrs</div><div class="stat"><b>${money(R.totals.pay)}</b>gross pay</div><div class="stat"><b>${R.totals.approved}/${R.sheets.length}</b>approved</div></div>
      <table class="list"><thead><tr><th>Officer</th><th class="num">Shifts</th><th class="num">Scheduled</th><th class="num">Paid hours</th><th class="num">OT</th><th class="num">Gross pay</th><th>Clock data</th><th>Status</th></tr></thead><tbody>${rows.map(s => `<tr class="row ${S.sel && S.sel.type === 'ts' && S.sel.emp === s.employeeId ? 'sel' : ''}" data-ts="${s.employeeId}"><td><b>${esc(s.employee)}</b> <span class="faint small">${esc(s.customId)}</span></td><td class="num">${s.lines.length}</td><td class="num">${fmtH(s.lines.reduce((n, l) => n + l.sched, 0))}</td><td class="num">${fmtH(s.total)}</td><td class="num" style="${s.ot ? 'color:var(--ot);font-weight:600' : ''}">${fmtH(s.ot)}</td><td class="num">${money(s.pay)}</td><td>${s.missing ? '<span class="tag off">' + s.missing + ' missing</span>' : '<span class="tag ok">complete</span>'}</td><td><span class="tag ${s.status === 'approved' ? 'ok' : ''}">${s.status}</span></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No shifts that week.</td></tr>'}</tbody></table>`;
    }
    if (P.paySub === 'invoices') {
      const R = P.inv; if (!R) return '<div class="loading">Loading…</div>';
      const rows = R.invoices.filter(i => matchQ(i.site, i.number));
      return `<table class="list"><thead><tr><th>Number</th><th>Site</th><th>Period</th><th class="num">Total</th><th>Due</th><th>Status</th></tr></thead><tbody>${rows.map(i => `<tr class="row ${S.sel && S.sel.type === 'invoice' && S.sel.id === i.id ? 'sel' : ''}" data-invoice="${i.id}"><td><b>${esc(i.number)}</b></td><td>${esc(i.site)}</td><td class="small">${i.period_from} → ${i.period_to}</td><td class="num">${money(i.total)}</td><td class="small ${i.daysOverdue ? '' : 'muted'}" style="${i.daysOverdue ? 'color:var(--vacant)' : ''}">${i.due_date || ''}${i.daysOverdue ? ' · ' + i.daysOverdue + 'd late' : ''}</td><td><span class="tag ${i.status === 'paid' ? 'ok' : i.status === 'sent' ? 'info' : i.status === 'void' ? '' : 'armed'}">${i.status}</span></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No invoices yet. Pick a period above and generate them from approved timesheets.</td></tr>'}</tbody></table>`;
    }
    if (P.paySub === 'aging') {
      const A = P.aging; if (!A) return '<div class="loading">Loading…</div>';
      return `<div class="stat-row">${Object.entries(A.sums).map(([k, v]) => `<div class="stat ${k !== 'current' && v ? 'bad' : ''}"><b>${money(v)}</b>${k}</div>`).join('')}<div class="stat"><b>${money(A.total)}</b>outstanding</div></div>
      <table class="list"><thead><tr><th>Number</th><th>Site</th><th>Sent</th><th>Due</th><th>Bucket</th><th class="num">Amount</th></tr></thead><tbody>${A.open.map(i => `<tr class="row" data-invoice="${i.id}"><td>${esc(i.number)}</td><td>${esc(i.site)}</td><td class="small">${(i.sent_at || '').slice(0, 10)}</td><td class="small">${i.due_date || ''}</td><td><span class="tag ${i.bucket === 'current' ? 'ok' : 'off'}">${i.bucket}</span></td><td class="num">${money(i.total)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing outstanding.</td></tr>'}</tbody></table>`;
    }
    const R = P.rates; if (!R) return '<div class="loading">Loading…</div>';
    const refLabel = r => r.scope === 'position' ? `${esc(r.refName.name || r.ref_id)} <span class="faint small">${esc(r.refName.site || '')}</span>` : esc(r.refName || r.ref_id);
    return `<table class="list"><thead><tr><th>Applies to</th><th>Scope</th><th class="num">Bill /h</th><th class="num">Pay /h</th><th class="num">OT ×</th><th class="num">Holiday ×</th><th>From</th><th>Note</th></tr></thead><tbody>${R.rates.map(r => `<tr class="row ${S.sel && S.sel.type === 'rate' && S.sel.id === r.id ? 'sel' : ''}" data-rate="${r.id}"><td>${refLabel(r)}</td><td><span class="tag">${r.scope}</span></td><td class="num">${r.bill_rate != null ? money(r.bill_rate) : '—'}</td><td class="num">${r.pay_rate != null ? money(r.pay_rate) : '—'}</td><td class="num">${r.ot_multiplier}</td><td class="num">${r.holiday_multiplier}</td><td class="small">${r.effective_from}</td><td class="small muted">${esc(r.note || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No rates yet. Add one per post (or per site as a fallback).</td></tr>'}</tbody></table>
    <h3 style="margin:20px 16px 6px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Holidays (billed and paid at the holiday multiplier)</h3>
    <div style="padding:0 16px 20px"><div id="holidays">${R.holidays.map(h => `<span class="tag" style="margin:2px">${h.date} ${esc(h.name || '')} <button class="linkbtn" data-act2="hol-del" data-date="${h.date}">×</button></span>`).join('') || '<span class="muted small">None yet.</span>'}</div><div class="row3" style="max-width:520px;margin-top:8px"><input type="date" id="hol-date" class="search" style="min-width:0"><input id="hol-name" class="search" style="min-width:0" placeholder="Name"><button class="btn sm" data-act2="hol-add">Add holiday</button></div></div>`;
  }
  function renderPatrol() {
    const R = P.patrol, RS = P.runsheets; if (!R || !RS) return '<div class="loading">Loading…</div>';
    const st = { planned: '', active: 'info', done: 'ok' };
    return `<h3 style="margin:14px 16px 6px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Routes</h3>
    <table class="list"><thead><tr><th>Route</th><th>Vehicle</th><th class="num">Stops</th><th>Sites</th><th>Status</th></tr></thead><tbody>${R.routes.map(r => `<tr class="row ${S.sel && S.sel.type === 'route' && S.sel.id === r.id ? 'sel' : ''}" data-route="${r.id}"><td><b>${esc(r.name)}</b></td><td>${esc(r.vehicle)}</td><td class="num">${r.stops.length}</td><td class="small">${r.stops.map(s => esc(s.site || '?')).join(' → ')}</td><td>${r.active ? '<span class="tag ok">active</span>' : '<span class="tag">inactive</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No routes yet.</td></tr>'}</tbody></table>
    <h3 style="margin:20px 16px 6px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Runsheets · ${labelDate(RS.date)}</h3>
    <table class="list"><thead><tr><th>Shift</th><th>Route</th><th>Officer</th><th>Status</th><th class="num">Visits</th><th class="num">Missed</th><th>Next</th></tr></thead><tbody>${RS.runsheets.map(r => `<tr class="row ${S.sel && S.sel.type === 'runsheet' && S.sel.id === r.id ? 'sel' : ''}" data-runsheet="${r.id}"><td class="small">${r.shift ? tShort(r.shift.s) + '–' + tShort(r.shift.e) : ''}</td><td>${esc(r.route.name)}</td><td>${esc(r.officer || '')}</td><td><span class="tag ${st[r.status] || ''}">${r.status}</span>${r.startedAt ? '<div class="small muted">started ' + fmtAt(r.startedAt) + '</div>' : ''}</td><td class="num">${r.done}/${r.total}</td><td class="num" style="${r.missed ? 'color:var(--vacant);font-weight:600' : ''}">${r.missed || ''}</td><td class="small">${r.next ? esc(r.next.site) + (r.next.arrived ? ' (on site)' : '') : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No runsheets that day. A runsheet appears when an officer on a patrol post opens their shift.</td></tr>'}</tbody></table>`;
  }

  /* ---------- panels ---------- */
  const _renderPanel = renderPanel; renderPanel = function () {
    const sel = S.sel; const p = $('#panel');
    // Do not wipe an editor while someone is typing in it (background refreshes call render too).
    const ae = document.activeElement; if (sel && ['route', 'rate', 'invoice', 'ts', 'site'].includes(sel.type) && ae && p.contains(ae) && (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && !['checkbox', 'radio'].includes(ae.type)))) return;
    if (sel && ['report', 'ts', 'invoice', 'rate', 'route', 'runsheet'].includes(sel.type)) { p.className = 'panel'; const keep = ['route', 'rate'].includes(sel.type); if (!keep) p.innerHTML = '<div class="panel-in"><div class="loading">Loading…</div></div>'; renderPhasePanel(sel).then(html => { if (S.sel === sel) p.innerHTML = html; }).catch(e => { p.innerHTML = `<div class="panel-in"><div class="note bad">${esc(e.message)}</div></div>`; }); return; }
    _renderPanel();
    if (sel && sel.type === 'site' && !sel.isNew) appendSiteSetup(sel);
  };
  async function renderPhasePanel(sel) {
    if (sel.type === 'report') {
      const r = await API.get('/api/reports/' + sel.id); sel.data = r; const site = S.sites.get(String(r.siteId)) || {};
      return `<div class="panel-in"><div class="kicker">${r.kind} report · ${esc(r.status)}</div><h2>${esc(r.title)}</h2><div class="muted small">${esc(r.site)} · ${esc(r.employee)} · ${fmtAt(r.at)}${r.flagged ? ' · <span class="tag off">flagged</span>' : ''}</div>
      <div class="kv2">${Object.entries(r.fields).map(([k, v]) => `<div>${esc(k)}</div><div class="pre">${esc(v)}</div>`).join('')}</div>
      ${r.photos.length ? `<h3>Photos</h3><div class="photos">${r.photos.map(id => `<a href="/api/photos/${id}" target="_blank"><img src="/api/photos/${id}" alt="report photo"></a>`).join('')}</div>` : ''}
      ${r.sentAt ? `<div class="note">Sent ${fmtAt(r.sentAt)} to ${esc(r.sentTo)}</div>` : ''}
      <h3>Send to client</h3><div class="field"><label>Email (comma separated)</label><input data-f2="sendto" value="${esc(site.email || '')}"></div>
      <div class="actions">${r.status === 'submitted' ? `<button class="btn" data-act2="rep-review">Mark reviewed</button>` : ''}<button class="btn primary" data-act2="rep-send">Send to client</button>${r.shiftId ? `<button class="btn" data-act2="rep-shift" data-shift="${r.shiftId}">Open shift</button>` : ''}<button class="btn" data-act="cancel">Close</button></div></div>`;
    }
    if (sel.type === 'ts') {
      const s = (P.ts && P.ts.ws === P.tsWs ? P.ts.sheets : []).find(x => x.employeeId === sel.emp); if (!s) throw new Error('Timesheet not loaded');
      sel.lines = sel.lines || s.lines.map(l => ({ shiftId: l.shiftId, paid: l.paid, note: l.note }));
      return `<div class="panel-in"><div class="kicker">Timesheet · week of ${weekLabel(P.tsWs)}</div><h2>${esc(s.employee)} ${s.status === 'approved' ? '<span class="tag ok">approved</span>' : ''}</h2>
      <div class="kv2"><div>Paid hours</div><div>${fmtH(s.total)} (OT ${fmtH(s.ot)})</div><div>Gross pay</div><div>${money(s.pay)}</div></div>
      <div style="overflow-x:auto"><table class="list lines"><thead><tr><th>Date</th><th>Site / post</th><th class="num">Sched</th><th class="num">Actual</th><th class="num">Paid</th><th>Note</th></tr></thead><tbody>${s.lines.map((l, i) => `<tr><td class="small">${l.date.slice(5)}<div class="faint">${tShort(l.s)}–${tShort(l.e)}</div></td><td class="small">${esc(l.site)}<div class="faint">${esc(l.pos)}${l.pto ? ' · PTO' : ''}${l.holiday ? ' · holiday' : ''}</div></td><td class="num">${fmtH(l.sched)}</td><td class="num ${l.missing ? '' : ''}" style="${l.missing ? 'color:var(--vacant)' : ''}">${l.actual != null ? fmtH(l.actual) : (l.pto ? '—' : 'no clock')}</td><td class="num" style="width:70px"><input type="number" step="0.25" min="0" data-ts-paid="${i}" value="${sel.lines[i].paid}"></td><td style="width:120px"><input data-ts-note="${i}" value="${esc(sel.lines[i].note || '')}" placeholder="reason"></td></tr>`).join('')}</tbody></table></div>
      <div class="small faint">Actual hours come from clock-in and clock-out rounded to the nearest quarter hour, less the break. Change "Paid" where the clock data is wrong and say why.</div>
      <div class="actions"><button class="btn" data-act2="ts-save">Save</button><button class="btn primary" data-act2="ts-approve" ${s.status === 'approved' ? 'disabled' : ''}>Approve</button><button class="btn" data-act="cancel">Close</button></div></div>`;
    }
    if (sel.type === 'invoice') {
      const v = await API.get('/api/invoices/' + sel.id); sel.data = v; sel.lines = sel.lines || v.lines.map(l => ({ ...l }));
      const t = sel.lines.reduce((a, l) => { if (l.type === 'credit') a.credits += Math.abs(l.amount || 0); else a.sub += (l.amount || 0); return a; }, { sub: 0, credits: 0 });
      const editable = v.status === 'draft';
      return `<div class="panel-in"><div class="kicker">${esc(v.site)} · ${v.period_from} → ${v.period_to}</div><h2>${esc(v.number)} <span class="tag ${v.status === 'paid' ? 'ok' : v.status === 'sent' ? 'info' : ''}">${v.status}</span></h2>
      <div class="kv2"><div>Due</div><div>${editable ? `<input type="date" data-f2="due" value="${v.due_date || ''}" style="border:1px solid var(--line);border-radius:4px;padding:2px 6px;background:var(--surface);color:inherit">` : esc(v.due_date || '')}</div>${v.sent_at ? `<div>Sent</div><div>${fmtAt(v.sent_at)} to ${esc(v.sent_to)}</div>` : ''}${v.paid_at ? `<div>Paid</div><div>${fmtAt(v.paid_at)} · ${money(v.paid_amount)}</div>` : ''}</div>
      <div style="overflow-x:auto"><table class="list lines"><thead><tr><th>Description</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th>${editable ? '<th></th>' : ''}</tr></thead><tbody>${sel.lines.map((l, i) => editable ? `<tr><td><input data-inv="description|${i}" value="${esc(l.description)}"></td><td style="width:70px"><input type="number" step="0.25" data-inv="hours|${i}" value="${l.hours ?? ''}"></td><td style="width:80px"><input type="number" step="0.01" data-inv="rate|${i}" value="${l.rate ?? ''}"></td><td style="width:90px"><input type="number" step="0.01" data-inv="amount|${i}" value="${l.amount}"></td><td><button class="linkbtn" data-act2="inv-line-del" data-i="${i}">×</button></td></tr>` : `<tr><td>${esc(l.description)}</td><td class="num">${l.hours ?? ''}</td><td class="num">${l.rate != null ? money(l.rate) : ''}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
      <tr><td colspan="3" class="num muted">Subtotal</td><td class="num">${money(t.sub)}</td>${editable ? '<td></td>' : ''}</tr>${t.credits ? `<tr><td colspan="3" class="num muted">Credits</td><td class="num">-${money(t.credits)}</td>${editable ? '<td></td>' : ''}</tr>` : ''}<tr><td colspan="3" class="num"><b>Total</b></td><td class="num"><b>${money(t.sub - t.credits)}</b></td>${editable ? '<td></td>' : ''}</tr></tbody></table></div>
      ${editable ? `<div class="actions"><button class="btn sm" data-act2="inv-line-add">+ Line</button><button class="btn sm" data-act2="inv-save">Save changes</button></div>` : ''}
      ${v.status !== 'paid' && v.status !== 'void' ? `<h3>Credit memo</h3><div class="row2"><input class="search" style="min-width:0" type="number" step="0.01" data-f2="credit-amt" placeholder="Amount"><input class="search" style="min-width:0" data-f2="credit-note" placeholder="Reason"></div><div class="actions"><button class="btn sm" data-act2="inv-credit">Apply credit</button></div>` : ''}
      <h3>Deliver</h3><div class="field"><label>Email (comma separated)</label><input data-f2="inv-to" value="${esc(v.siteEmail || '')}"></div>
      <div class="actions">${v.status !== 'paid' && v.status !== 'void' ? `<button class="btn primary" data-act2="inv-send">${v.status === 'sent' ? 'Resend' : 'Send invoice'}</button><button class="btn" data-act2="inv-paid">Mark paid</button>` : ''}<a class="btn" href="/invoices/${v.id}" target="_blank">Print view</a>${v.status === 'draft' || v.status === 'sent' ? `<button class="btn danger" data-act2="inv-void">Void</button>` : ''}<button class="btn" data-act="cancel">Close</button></div></div>`;
    }
    if (sel.type === 'rate') {
      const r = sel.id === 'new' ? { scope: 'position', ref_id: '', bill_rate: '', pay_rate: '', ot_multiplier: 1.5, holiday_multiplier: 1.5, effective_from: TODAY, note: '' } : P.rates.rates.find(x => x.id === sel.id); sel.draft = sel.draft || { ...r };
      const d = sel.draft; const opts = d.scope === 'site' ? sitesSorted().map(s => [s.id, s.name]) : d.scope === 'employee' ? activeEmps().map(e => [e.id, e.last + ', ' + e.first]) : [...S.pos.values()].filter(x => x.pos.active !== false).map(x => [x.pos.id, x.site.name + ' — ' + x.pos.name]).sort((a, b) => a[1].localeCompare(b[1]));
      return `<div class="panel-in"><div class="kicker">${sel.id === 'new' ? 'New rate' : 'Rate'}</div><h2>${d.scope === 'position' ? 'Post rate' : d.scope === 'site' ? 'Site rate' : 'Officer pay override'}</h2>
      <div class="field"><label>Scope</label><select data-f2="rate-scope"><option value="position" ${d.scope === 'position' ? 'selected' : ''}>Post (bill and pay)</option><option value="site" ${d.scope === 'site' ? 'selected' : ''}>Site fallback (all posts without their own rate)</option><option value="employee" ${d.scope === 'employee' ? 'selected' : ''}>Officer pay override</option></select></div>
      <div class="field"><label>Applies to</label><select data-f2="rate-ref"><option value="">Choose…</option>${opts.map(([id, n]) => `<option value="${id}" ${String(d.ref_id) === String(id) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div class="row2">${d.scope !== 'employee' ? `<div class="field"><label>Bill rate $/h</label><input type="number" step="0.01" data-f2="rate-bill" value="${d.bill_rate ?? ''}"></div>` : ''}<div class="field"><label>Pay rate $/h</label><input type="number" step="0.01" data-f2="rate-pay" value="${d.pay_rate ?? ''}"></div></div>
      <div class="row3"><div class="field"><label>OT multiplier</label><input type="number" step="0.05" data-f2="rate-ot" value="${d.ot_multiplier}"></div><div class="field"><label>Holiday multiplier</label><input type="number" step="0.05" data-f2="rate-hol" value="${d.holiday_multiplier}"></div><div class="field"><label>Effective from</label><input type="date" data-f2="rate-from" value="${d.effective_from}"></div></div>
      <div class="field"><label>Note</label><input data-f2="rate-note" value="${esc(d.note || '')}"></div>
      <div class="actions"><button class="btn primary" data-act2="rate-save">Save rate</button>${sel.id !== 'new' ? '<button class="btn danger" data-act2="rate-del">Delete</button>' : ''}<button class="btn" data-act="cancel">Close</button></div></div>`;
    }
    if (sel.type === 'route') {
      const r = sel.id === 'new' ? { name: '', vehicle: '', stops: [], active: true, notes: '' } : P.patrol.routes.find(x => x.id === sel.id); sel.draft = sel.draft || JSON.parse(JSON.stringify(r)); if (sel.id === 'new') P.routeDraft = sel.draft;
      const d = sel.draft; const siteOpts = sitesSorted().map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      return `<div class="panel-in"><div class="kicker">${sel.id === 'new' ? 'New route' : 'Route'}</div><h2>${esc(d.name || 'Patrol route')}</h2>${sel.error ? `<div class="note bad">${esc(sel.error)}</div>` : ''}<div class="small muted">A runsheet is created automatically for every shift on a post that uses this route. Assign the route to a post under Sites &amp; posts.</div>
      <div class="row2"><div class="field"><label>Route name</label><input data-f2="route-name" value="${esc(d.name)}" placeholder="North Shore night run"></div><div class="field"><label>Vehicle</label><input data-f2="route-vehicle" value="${esc(d.vehicle)}" placeholder="Patrol 3"></div></div>
      <label class="chk"><input type="checkbox" data-f2="route-active" ${d.active ? 'checked' : ''}> Active</label>
      <h3>Stops in order</h3><div class="stops">${d.stops.map((s, i) => `<div class="stop"><div style="display:flex;gap:6px;align-items:center"><b style="flex:0 0 22px">${i + 1}.</b><select data-stop="siteId|${i}" style="flex:1;min-width:0"><option value="">Site…</option>${siteOpts.replace(`value="${s.siteId}"`, `value="${s.siteId}" selected`)}</select><button class="linkbtn" data-act2="stop-up" data-i="${i}">↑</button><button class="linkbtn" data-act2="stop-del" data-i="${i}">×</button></div>
      <div class="row3" style="margin-top:6px"><div class="field"><label>Window from</label><input type="time" data-stop="windowFrom|${i}" value="${s.windowFrom || ''}"></div><div class="field"><label>Window to</label><input type="time" data-stop="windowTo|${i}" value="${s.windowTo || ''}"></div><div class="field"><label>Visits / night</label><input type="number" min="1" data-stop="visits|${i}" value="${s.visits || 1}"></div></div>
      <div class="field"><label>What to check</label><input data-stop="instructions|${i}" value="${esc(s.instructions || '')}" placeholder="Gates locked, lot lights, rear door"></div></div>`).join('')}</div>
      <div class="actions" style="margin-top:8px"><button class="btn sm" data-act2="stop-add">+ Add stop</button></div>
      <div class="field"><label>Notes for the driver</label><textarea data-f2="route-notes" rows="2">${esc(d.notes || '')}</textarea></div>
      <div class="actions"><button class="btn primary" data-act2="route-save">Save route</button>${sel.id !== 'new' ? '<button class="btn danger" data-act2="route-del">Delete</button>' : ''}<button class="btn" data-act="cancel">Close</button></div></div>`;
    }
    if (sel.type === 'runsheet') {
      const r = await API.get('/api/runsheets/' + sel.id);
      return `<div class="panel-in"><div class="kicker">Runsheet · ${esc(r.route.name)}${r.route.vehicle ? ' · ' + esc(r.route.vehicle) : ''}</div><h2>${esc(r.officer || 'Unassigned')} <span class="tag ${r.status === 'done' ? 'ok' : r.status === 'active' ? 'info' : ''}">${r.status}</span></h2>
      <div class="kv2"><div>Started</div><div>${fmtAt(r.startedAt) || '—'}</div><div>Ended</div><div>${fmtAt(r.endedAt) || '—'}</div><div>Visits</div><div>${r.done}/${r.total}${r.missed ? ` · <span style="color:var(--vacant)">${r.missed} missed</span>` : ''}</div><div>GPS points</div><div>${r.breadcrumbs.length}</div></div>
      ${r.stops.map(s => `<div class="tpl"><span><b>${esc(s.site)}</b><div class="small muted">${s.windowFrom || s.windowTo ? (s.windowFrom || '') + '–' + (s.windowTo || '') : 'any time'}${s.instructions ? ' · ' + esc(s.instructions) : ''}</div></span><span>${s.visits.map(v => `<span class="tag ${v.status === 'ok' ? 'ok' : v.status === 'late' ? 'armed' : v.status === 'missed' ? 'off' : ''}" title="${esc(v.note || '')}">${v.arrivedAt ? fmtAt(v.arrivedAt).split(' ')[1] : v.status}</span>`).join(' ')}</span>${s.visits.some(v => v.note) ? `<span class="who">${s.visits.filter(v => v.note).map(v => esc(v.note)).join(' · ')}</span>` : ''}</div>`).join('')}
      ${r.notes ? `<h3>Driver notes</h3><div class="pre">${esc(r.notes)}</div>` : ''}
      <div class="actions"><button class="btn" data-act="cancel">Close</button></div></div>`;
    }
  }
  /* site panel extras: patrol/lone settings per post, checkpoints, tours */
  async function appendSiteSetup(sel) {
    const p = $('#panel .panel-in'); if (!p) return; const siteId = String(sel.id);
    const box = document.createElement('div'); box.id = 'site-setup'; box.innerHTML = '<h3>Checkpoints, tours &amp; patrol</h3><div class="small muted">Loading…</div>';
    const lastActions = [...p.children].filter(el => el.classList && el.classList.contains('actions')).pop(); if (lastActions) p.insertBefore(box, lastActions); else p.appendChild(box);
    if (!P.cp[siteId]) { try { const r = await API.get('/api/sites/' + siteId + '/checkpoints'); P.cp[siteId] = { checkpoints: r.checkpoints, tours: r.tours, dirty: false }; } catch (e) { box.innerHTML = '<div class="note bad">' + esc(e.message) + '</div>'; return; } }
    if (!P.patrol) { try { P.patrol = await API.get('/api/routes'); } catch (e) { P.patrol = { routes: [] }; } }
    renderSiteSetup(siteId);
  }
  function renderSiteSetup(siteId) {
    const box = $('#site-setup'); if (!box) return; const c = P.cp[siteId]; const site = S.sites.get(siteId) || { positions: [] };
    box.innerHTML = `<h3>Patrol &amp; lone-worker settings</h3>
    ${(site.positions || []).map(pos => `<div class="tpl"><span>${esc(pos.name)}</span><span></span><span class="who" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">Route <select data-patrol="route|${pos.id}"><option value="">none</option>${(P.patrol.routes || []).map(r => `<option value="${r.id}" ${pos.routeId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select> Check-in every <input type="number" min="0" step="5" style="width:60px" data-patrol="lone|${pos.id}" value="${pos.loneMinutes || 0}"> min (0 = off)</span></div>`).join('') || '<div class="small faint">No posts yet.</div>'}
    <h3>Checkpoints (${c.checkpoints.length})</h3>
    ${c.checkpoints.map((cp, i) => `<div class="tpl"><span><input data-cp="name|${i}" value="${esc(cp.name)}" style="width:100%;border:1px solid var(--line);border-radius:4px;padding:2px 6px;background:var(--surface);color:inherit"></span><span><code style="font-size:12px">${esc(cp.code)}</code> <button class="linkbtn" data-act2="cp-del" data-i="${i}">×</button></span><span class="who"><input data-cp="instructions|${i}" value="${esc(cp.instructions || '')}" placeholder="What to check here" style="width:100%;border:1px solid var(--line);border-radius:4px;padding:2px 6px;background:var(--surface);color:inherit;font-size:12px"></span></div>`).join('') || '<div class="small faint">None. Add checkpoints, print their QR codes and post them at the spots officers must visit.</div>'}
    <div class="actions"><button class="btn sm" data-act2="cp-add">+ Checkpoint</button>${c.checkpoints.length ? `<button class="btn sm" data-act2="cp-print">Print QR codes</button>` : ''}</div>
    <h3>Tours (${c.tours.length})</h3>
    ${c.tours.map((t, i) => `<div class="tpl"><span><input data-tour="name|${i}" value="${esc(t.name)}" style="width:100%;border:1px solid var(--line);border-radius:4px;padding:2px 6px;background:var(--surface);color:inherit"></span><span><input type="number" min="1" data-tour="perShift|${i}" value="${t.perShift}" style="width:50px" title="times per shift">× per shift <button class="linkbtn" data-act2="tour-del" data-i="${i}">×</button></span><span class="who">${c.checkpoints.map(cp => `<label class="chk small"><input type="checkbox" data-tourcp="${i}|${cp.id}" ${t.checkpointIds.includes(cp.id) ? 'checked' : ''}> ${esc(cp.name)}</label>`).join(' ') || '<span class="faint">add checkpoints first</span>'}</span></div>`).join('')}
    <div class="actions"><button class="btn sm" data-act2="tour-add">+ Tour</button><button class="btn sm primary" data-act2="cp-save" ${c.dirty ? '' : 'disabled'}>Save checkpoints &amp; tours</button></div>`;
  }
  function printQr(siteId) {
    const c = P.cp[siteId]; const site = S.sites.get(siteId) || {}; const w = window.open('', '_blank'); if (!w) { toast('Allow pop-ups to print'); return; }
    w.document.write(`<!doctype html><title>Checkpoints — ${esc(site.name || '')}</title><style>body{font-family:Arial,sans-serif;padding:20px}.qr{display:inline-block;width:220px;margin:12px;text-align:center;border:1px solid #ccc;padding:12px;page-break-inside:avoid}.qr b{display:block;font-size:16px;margin-top:8px}.qr small{color:#555}</style><h1>${esc(site.name || '')}</h1><p>Guard Pro checkpoints. Post each code at its location. Officers scan it with the Guard Pro app.</p><div id="w"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script><script>const cps=${JSON.stringify(c.checkpoints.map(x => ({ n: x.name, c: x.code })))};for(const cp of cps){const d=document.createElement('div');d.className='qr';const q=document.createElement('div');d.appendChild(q);d.insertAdjacentHTML('beforeend','<b>'+cp.n.replace(/</g,'&lt;')+'</b><small>'+cp.c+'</small>');document.getElementById('w').appendChild(d);new QRCode(q,{text:'GP:'+cp.c,width:180,height:180});}setTimeout(()=>window.print(),600);<\/script>`);
    w.document.close();
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act2],[data-report],[data-ts],[data-invoice],[data-rate],[data-route],[data-runsheet],[data-repstatus],[data-repkind],[data-paysub],[data-invstatus]'); if (!b) return;
    if (b.dataset.report) { S.sel = { type: 'report', id: b.dataset.report }; render(); return; }
    if (b.dataset.ts) { S.sel = { type: 'ts', emp: b.dataset.ts }; render(); return; }
    if (b.dataset.invoice) { S.sel = { type: 'invoice', id: b.dataset.invoice }; render(); return; }
    if (b.dataset.rate) { S.sel = { type: 'rate', id: b.dataset.rate }; render(); return; }
    if (b.dataset.route) { S.sel = { type: 'route', id: b.dataset.route }; render(); return; }
    if (b.dataset.runsheet) { S.sel = { type: 'runsheet', id: b.dataset.runsheet }; render(); return; }
    if (b.dataset.repstatus !== undefined) { P.repFilter.status = b.dataset.repstatus; renderSub(); loadReports(); return; }
    if (b.dataset.repkind !== undefined) { P.repFilter.kind = b.dataset.repkind; renderSub(); loadReports(); return; }
    if (b.dataset.paysub) { P.paySub = b.dataset.paysub; S.sel = null; render(); if (P.paySub === 'timesheets') loadTimesheets(); else if (P.paySub === 'rates') loadRates(); else loadInvoices(); return; }
    if (b.dataset.invstatus !== undefined) { P.invStatus = b.dataset.invstatus; renderSub(); loadInvoices(); return; }
    const a = b.dataset.act2; const sel = S.sel;
    try {
      if (a === 'reload-req') loadRequests();
      else if (a === 'req-approve' || a === 'req-decline') { const note = a === 'req-decline' ? (prompt('Reason for the officer (optional):') || '') : ''; try { await API.send('POST', '/api/requests/' + b.dataset.id + '/decide', { approve: a === 'req-approve', note }); } catch (err) { if (/override/.test(err.message) && confirm(err.message + '\n\nApprove anyway?')) await API.send('POST', '/api/requests/' + b.dataset.id + '/decide', { approve: true, force: true }); else throw err; } toast(a === 'req-approve' ? 'Approved' : 'Declined'); loadRequests(); loadBadges(); }
      else if (a === 'to-approve' || a === 'to-decline') { const note = a === 'to-decline' ? (prompt('Reason for the officer (optional):') || '') : ''; await API.send('POST', '/api/timeoff/' + b.dataset.id + '/decide', { approve: a === 'to-approve', note }); toast(a === 'to-approve' ? 'Time off approved' : 'Declined'); loadRequests(); loadBadges(); }
      else if (a === 'rep-review') { await API.send('POST', '/api/reports/' + sel.id + '/review'); toast('Marked reviewed'); loadReports(); loadBadges(); render(); }
      else if (a === 'rep-send') { const to = $('#panel [data-f2=sendto]').value.split(',').map(s => s.trim()).filter(Boolean); const r = await API.send('POST', '/api/reports/' + sel.id + '/send', { to }); toast(r.delivered ? 'Sent to ' + r.to.join(', ') : (r.note || 'Marked sent')); loadReports(); loadBadges(); render(); }
      else if (a === 'rep-shift') { const sh = b.dataset.shift; const r = await API.get('/api/reports/' + sel.id); const ws = iso(sundayOf(parseLocal((r.at || '').slice(0, 10)))); S.ws = ws; loadWeek(ws); S.sel = { type: 'shift', id: sh, ws }; setView('schedule'); }
      else if (a === 'ts-prev' || a === 'ts-next') { P.tsWs = iso(addDays(parseLocal(P.tsWs), a === 'ts-prev' ? -7 : 7)); S.sel = null; render(); loadTimesheets(); }
      else if (a === 'ts-approve-all') { const r = await API.send('POST', '/api/timesheets/' + P.tsWs + '/approve-all'); toast(`${r.approved} approved · ${r.skipped} skipped (already approved or missing clock data)`); loadTimesheets(); }
      else if (a === 'ts-save' || a === 'ts-approve') { await API.send('PUT', `/api/timesheets/${P.tsWs}/${sel.emp}`, { lines: sel.lines, approve: a === 'ts-approve' }); toast(a === 'ts-approve' ? 'Timesheet approved' : 'Saved'); await loadTimesheets(); render(); }
      else if (a === 'inv-generate') { const from = $('#inv-from').value, to = $('#inv-to').value; const r = await API.send('POST', '/api/invoices/generate', { from, to }); toast(`${r.created.length} invoice${r.created.length === 1 ? '' : 's'} created${r.skipped.length ? ' · ' + r.skipped.length + ' skipped' : ''}`); if (r.skipped.length) console.table(r.skipped); loadInvoices(); }
      else if (a === 'inv-line-add') { sel.lines.push({ type: 'adhoc', description: '', hours: null, rate: null, amount: 0 }); render(); }
      else if (a === 'inv-line-del') { sel.lines.splice(+b.dataset.i, 1); render(); }
      else if (a === 'inv-save') { const due = $('#panel [data-f2=due]'); await API.send('PUT', '/api/invoices/' + sel.id, { lines: sel.lines, dueDate: due ? due.value : undefined }); sel.lines = null; toast('Invoice saved'); loadInvoices(); render(); }
      else if (a === 'inv-credit') { const amt = $('#panel [data-f2=credit-amt]').value, note = $('#panel [data-f2=credit-note]').value; await API.send('POST', '/api/invoices/' + sel.id + '/credit', { amount: amt, note }); sel.lines = null; toast('Credit applied'); loadInvoices(); render(); }
      else if (a === 'inv-send') { const to = $('#panel [data-f2=inv-to]').value.split(',').map(s => s.trim()).filter(Boolean); const r = await API.send('POST', '/api/invoices/' + sel.id + '/send', { to }); toast(r.delivered ? 'Invoice sent' : 'Marked sent (email not configured yet)'); sel.lines = null; loadInvoices(); render(); }
      else if (a === 'inv-paid') { const amt = prompt('Amount received:', sel.data ? sel.data.total : ''); if (amt === null) return; await API.send('POST', '/api/invoices/' + sel.id + '/paid', { amount: amt }); toast('Marked paid'); sel.lines = null; loadInvoices(); render(); }
      else if (a === 'inv-void') { if (!confirm('Void this invoice?')) return; await API.send('POST', '/api/invoices/' + sel.id + '/void'); S.sel = null; loadInvoices(); render(); }
      else if (a === 'rate-new') { S.sel = { type: 'rate', id: 'new' }; render(); }
      else if (a === 'rate-save') { const d = sel.draft; if (!d.ref_id) return toast('Choose what the rate applies to'); await API.send('PUT', '/api/rates/' + sel.id, { scope: d.scope, refId: d.ref_id, billRate: d.bill_rate, payRate: d.pay_rate, otMultiplier: d.ot_multiplier, holidayMultiplier: d.holiday_multiplier, effectiveFrom: d.effective_from, note: d.note }); toast('Rate saved'); S.sel = null; loadRates(); render(); }
      else if (a === 'rate-del') { if (!confirm('Delete this rate?')) return; await API.send('DELETE', '/api/rates/' + sel.id); S.sel = null; loadRates(); render(); }
      else if (a === 'hol-add') { const date = $('#hol-date').value, name = $('#hol-name').value; if (!date) return toast('Pick a date'); await API.send('PUT', '/api/holidays', { holidays: [...P.rates.holidays, { date, name }] }); loadRates(); }
      else if (a === 'hol-del') { await API.send('PUT', '/api/holidays', { holidays: P.rates.holidays.filter(h => h.date !== b.dataset.date) }); loadRates(); }
      else if (a === 'route-new') { S.sel = { type: 'route', id: 'new', draft: P.routeDraft || undefined }; if (P.routeDraft) toast('Restored the route you were editing'); render(); }
      else if (a === 'stop-add') { sel.draft.stops.push({ siteId: '', windowFrom: '', windowTo: '', visits: 1, instructions: '' }); render(); }
      else if (a === 'stop-del') { sel.draft.stops.splice(+b.dataset.i, 1); render(); }
      else if (a === 'stop-up') { const i = +b.dataset.i; if (i > 0) { const s = sel.draft.stops.splice(i, 1)[0]; sel.draft.stops.splice(i - 1, 0, s); render(); } }
      else if (a === 'route-save') { const d = sel.draft; sel.error = !d.name ? 'Give the route a name.' : !d.stops.length ? 'Add at least one stop.' : d.stops.some(s => !s.siteId) ? 'Every stop needs a site.' : ''; if (sel.error) { render(); return; } await API.send('PUT', '/api/routes/' + sel.id, d); P.routeDraft = null; toast('Route saved'); S.sel = null; loadPatrol(); render(); }
      else if (a === 'route-del') { if (!confirm('Delete this route? Posts using it lose their runsheets.')) return; await API.send('DELETE', '/api/routes/' + sel.id); S.sel = null; loadPatrol(); render(); }
      else if (a === 'cp-add') { const c = P.cp[String(sel.id)]; c.checkpoints.push({ name: 'Checkpoint ' + (c.checkpoints.length + 1), code: '', instructions: '' }); c.dirty = true; renderSiteSetup(String(sel.id)); }
      else if (a === 'cp-del') { const c = P.cp[String(sel.id)]; c.checkpoints.splice(+b.dataset.i, 1); c.dirty = true; renderSiteSetup(String(sel.id)); }
      else if (a === 'tour-add') { const c = P.cp[String(sel.id)]; c.tours.push({ name: 'Tour ' + (c.tours.length + 1), checkpointIds: c.checkpoints.map(x => x.id).filter(Boolean), perShift: 1 }); c.dirty = true; renderSiteSetup(String(sel.id)); }
      else if (a === 'tour-del') { const c = P.cp[String(sel.id)]; c.tours.splice(+b.dataset.i, 1); c.dirty = true; renderSiteSetup(String(sel.id)); }
      else if (a === 'cp-save') { const id = String(sel.id); const c = P.cp[id]; const r = await API.send('PUT', '/api/sites/' + id + '/checkpoints', { checkpoints: c.checkpoints, tours: c.tours }); P.cp[id] = { checkpoints: r.checkpoints, tours: r.tours, dirty: false }; toast('Checkpoints saved'); renderSiteSetup(id); }
      else if (a === 'cp-print') printQr(String(sel.id));
    } catch (err) { toast(err.message); }
  });
  document.addEventListener('input', e => {
    const t = e.target; const sel = S.sel; if (!sel) return;
    if (t.dataset.tsPaid !== undefined) { sel.lines[+t.dataset.tsPaid].paid = t.value === '' ? null : +t.value; return; }
    if (t.dataset.tsNote !== undefined) { sel.lines[+t.dataset.tsNote].note = t.value; return; }
    if (t.dataset.inv) { const [k, i] = t.dataset.inv.split('|'); const l = sel.lines[+i]; if (k === 'description') l.description = t.value; else { l[k] = t.value === '' ? null : +t.value; if (k !== 'amount' && l.hours != null && l.rate != null) { l.amount = Math.round(l.hours * l.rate * 100) / 100; const amt = $(`#panel [data-inv="amount|${i}"]`); if (amt) amt.value = l.amount; } } return; }
    if (t.dataset.f2 && sel.type === 'rate') { const d = sel.draft; const k = t.dataset.f2; if (k === 'rate-ref') d.ref_id = t.value; if (k === 'rate-bill') d.bill_rate = t.value; if (k === 'rate-pay') d.pay_rate = t.value; if (k === 'rate-ot') d.ot_multiplier = +t.value; if (k === 'rate-hol') d.holiday_multiplier = +t.value; if (k === 'rate-from') d.effective_from = t.value; if (k === 'rate-note') d.note = t.value; return; }
    if (t.dataset.f2 && sel.type === 'route') { const d = sel.draft; const k = t.dataset.f2; if (k === 'route-name') d.name = t.value; if (k === 'route-vehicle') d.vehicle = t.value; if (k === 'route-notes') d.notes = t.value; return; }
    if (t.dataset.stop) { const [k, i] = t.dataset.stop.split('|'); sel.draft.stops[+i][k] = k === 'visits' ? +t.value : t.value; return; }
    if (t.dataset.cp) { const [k, i] = t.dataset.cp.split('|'); const c = P.cp[String(sel.id)]; c.checkpoints[+i][k] = t.value; c.dirty = true; $('#site-setup [data-act2=cp-save]').disabled = false; return; }
    if (t.dataset.tour) { const [k, i] = t.dataset.tour.split('|'); const c = P.cp[String(sel.id)]; c.tours[+i][k] = k === 'perShift' ? +t.value : t.value; c.dirty = true; $('#site-setup [data-act2=cp-save]').disabled = false; return; }
  });
  document.addEventListener('change', async e => {
    const t = e.target; const sel = S.sel; if (!sel) return;
    if (t.dataset.f2 === 'rate-scope' && sel.type === 'rate') { sel.draft.scope = t.value; sel.draft.ref_id = ''; render(); return; }
    if (t.dataset.f2 === 'route-active' && sel.type === 'route') { sel.draft.active = t.checked; return; }
    if (t.dataset.tourcp) { const [i, cpId] = t.dataset.tourcp.split('|'); const c = P.cp[String(sel.id)]; const tr = c.tours[+i]; tr.checkpointIds = t.checked ? [...new Set([...tr.checkpointIds, cpId])] : tr.checkpointIds.filter(x => x !== cpId); c.dirty = true; $('#site-setup [data-act2=cp-save]').disabled = false; return; }
    if (t.dataset.patrol) { const [k, posId] = t.dataset.patrol.split('|'); const site = S.sites.get(String(sel.id)); const pos = (site.positions || []).find(p => String(p.id) === posId); if (!pos) return; if (k === 'route') pos.routeId = t.value || null; else pos.loneMinutes = +t.value || 0; try { await API.send('PUT', '/api/positions/' + posId + '/patrol', { routeId: pos.routeId || null, loneMinutes: pos.loneMinutes || 0 }); toast('Patrol setting saved'); } catch (err) { toast(err.message); } return; }
    if (t.id === 'patrol-date') { P.patrolDate = t.value; loadPatrol(); }
  });
})();
