// Phase 4 — pay and bill: rates with effective dates, timesheets built from clock-ins with approval,
// payroll export, client invoices, credit memos and an aging list.
module.exports = function ({ add, err, ok, R, bus, D, T, cfg, notify }) {
  const { DISPATCH } = R; const db = D.db;
  db.exec(`
  CREATE TABLE IF NOT EXISTS rates (id TEXT PRIMARY KEY, scope TEXT NOT NULL, ref_id TEXT NOT NULL, bill_rate REAL, pay_rate REAL,
    ot_multiplier REAL NOT NULL DEFAULT 1.5, holiday_multiplier REAL NOT NULL DEFAULT 1.5, effective_from TEXT NOT NULL, note TEXT);
  CREATE INDEX IF NOT EXISTS rates_ref ON rates(scope, ref_id, effective_from);
  CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS timesheets (id TEXT PRIMARY KEY, ws TEXT NOT NULL, employee_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    lines_json TEXT NOT NULL DEFAULT '[]', approved_by TEXT, approved_at TEXT, note TEXT, UNIQUE(ws, employee_id));
  CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, number TEXT UNIQUE, site_id TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', lines_json TEXT NOT NULL DEFAULT '[]', subtotal REAL NOT NULL DEFAULT 0, credits REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, sent_at TEXT, sent_to TEXT, due_date TEXT, paid_at TEXT, paid_amount REAL, note TEXT);
  CREATE INDEX IF NOT EXISTS invoices_site ON invoices(site_id, period_from);
  `);
  const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
  const weeklyOt = cfg.overtimeWeeklyHours || 40;
  const roundMin = cfg.roundClockToMinutes || 15;

  /* ---------- rates ---------- */
  function rateFor(scope, refId, date) { return db.prepare('SELECT * FROM rates WHERE scope=? AND ref_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1').get(scope, String(refId), date); }
  function effectiveRates(shift) {
    const date = shift.s.slice(0, 10); const pos = rateFor('position', shift.pos, date); const site = rateFor('site', shift.site, date); const emp = shift.emp ? rateFor('employee', shift.emp, date) : null;
    const bill = pos && pos.bill_rate != null ? pos.bill_rate : site && site.bill_rate != null ? site.bill_rate : (cfg.defaultBillRate || 0);
    const pay = emp && emp.pay_rate != null ? emp.pay_rate : pos && pos.pay_rate != null ? pos.pay_rate : site && site.pay_rate != null ? site.pay_rate : (cfg.defaultPayRate || 0);
    const src = pos || site || {}; return { bill, pay, otMult: src.ot_multiplier || 1.5, holMult: src.holiday_multiplier || 1.5, holiday: !!db.prepare('SELECT 1 FROM holidays WHERE date=?').get(date), source: pos ? 'position' : site ? 'site' : 'default' };
  }
  add('GET', '/api/rates', DISPATCH, () => ok({ rates: db.prepare('SELECT * FROM rates ORDER BY scope, ref_id, effective_from DESC').all().map(r => ({ ...r, refName: r.scope === 'site' ? (D.siteLite(r.ref_id) || {}).name : r.scope === 'employee' ? (D.getEmployee(r.ref_id) || {}).name : (db.prepare('SELECT p.name, s.name AS site FROM positions p JOIN sites s ON s.id=p.site_id WHERE p.id=?').get(r.ref_id) || {}) })), holidays: db.prepare('SELECT * FROM holidays ORDER BY date').all(), defaults: { billRate: cfg.defaultBillRate || 0, payRate: cfg.defaultPayRate || 0, weeklyOt } }));
  add('PUT', '/api/rates/:id', DISPATCH, ({ user, params, body }) => {
    if (!['position', 'site', 'employee'].includes(body.scope) || !body.refId || !body.effectiveFrom) return err(400, 'scope, refId and effectiveFrom are required');
    db.prepare(`INSERT INTO rates(id,scope,ref_id,bill_rate,pay_rate,ot_multiplier,holiday_multiplier,effective_from,note) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,ref_id=excluded.ref_id,bill_rate=excluded.bill_rate,pay_rate=excluded.pay_rate,ot_multiplier=excluded.ot_multiplier,holiday_multiplier=excluded.holiday_multiplier,effective_from=excluded.effective_from,note=excluded.note`)
      .run(params.id === 'new' ? D.uid() : params.id, body.scope, String(body.refId), body.billRate === '' || body.billRate == null ? null : +body.billRate, body.payRate === '' || body.payRate == null ? null : +body.payRate, +body.otMultiplier || 1.5, +body.holidayMultiplier || 1.5, String(body.effectiveFrom).slice(0, 10), (body.note || '').slice(0, 200));
    D.audit(user.id, 'rate_saved', { scope: body.scope, ref: body.refId }); return ok({ ok: true });
  });
  add('DELETE', '/api/rates/:id', DISPATCH, ({ user, params }) => { db.prepare('DELETE FROM rates WHERE id=?').run(params.id); D.audit(user.id, 'rate_deleted', { id: params.id }); return ok({ ok: true }); });
  add('PUT', '/api/holidays', DISPATCH, ({ user, body }) => { db.prepare('DELETE FROM holidays').run(); for (const h of body.holidays || []) if (/^\d{4}-\d{2}-\d{2}$/.test(h.date)) db.prepare('INSERT OR REPLACE INTO holidays(date,name) VALUES (?,?)').run(h.date, (h.name || '').slice(0, 80)); D.audit(user.id, 'holidays_saved'); return ok({ ok: true }); });

  /* ---------- timesheets ---------- */
  const hrsBetween = (a, b) => Math.max(0, (T.toInstant(b) - T.toInstant(a)) / 36e5);
  function roundTo(iso) { const d = new Date(iso); const ms = roundMin * 60e3; return new Date(Math.round(d.getTime() / ms) * ms); }
  function computeLines(empId, ws) {
    const shifts = db.prepare('SELECT * FROM shifts WHERE employee_id=? AND ws=? ORDER BY s').all(empId, ws);
    const saved = db.prepare('SELECT * FROM timesheets WHERE employee_id=? AND ws=?').get(empId, ws); const adj = new Map((saved ? JSON.parse(saved.lines_json) : []).map(l => [l.shiftId, l]));
    let cum = 0;
    const lines = shifts.map(r => {
      const sh = D.shiftDoc(r); const clock = {}; for (const c of db.prepare('SELECT kind, at FROM clockins WHERE shift_id=? ORDER BY at').all(r.id)) clock[c.kind] = c.at;
      const sched = round(hrsBetween(sh.s, sh.e) - (sh.brk || 0) / 60, 2);
      let actual = null; if (clock.in && clock.out) actual = round(Math.max(0, (roundTo(clock.out) - roundTo(clock.in)) / 36e5 - (sh.brk || 0) / 60), 2);
      const a = adj.get(r.id) || {}; const paid = a.paid != null ? +a.paid : (sh.pto ? sched : actual != null ? actual : sched);
      const reg = Math.max(0, Math.min(paid, weeklyOt - cum)); const ot = round(paid - reg, 2); cum += paid;
      const rates = effectiveRates(sh); const site = D.siteLite(sh.site) || {}; const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(sh.pos) || {};
      return { shiftId: r.id, date: sh.s.slice(0, 10), s: sh.s, e: sh.e, site: site.name, siteId: sh.site, pos: pos.name, posId: sh.pos, pto: sh.pto, sched, actual, clockIn: clock.in || null, clockOut: clock.out || null, paid: round(paid, 2), reg: round(reg, 2), ot, holiday: rates.holiday, payRate: rates.pay, billRate: rates.bill, otMult: rates.otMult, holMult: rates.holMult, note: a.note || '', missing: !sh.pto && !(clock.in && clock.out) };
    });
    const total = round(lines.reduce((n, l) => n + l.paid, 0), 2); const ot = round(lines.reduce((n, l) => n + l.ot, 0), 2);
    const pay = round(lines.reduce((n, l) => n + l.reg * l.payRate * (l.holiday ? l.holMult : 1) + l.ot * l.payRate * l.otMult, 0), 2);
    return { employeeId: empId, ws, lines, total, ot, pay, status: saved ? saved.status : 'open', approvedAt: saved ? saved.approved_at : null, note: saved ? saved.note : '' };
  }
  add('GET', '/api/timesheets/:ws', DISPATCH, ({ params }) => {
    const ws = params.ws; const emps = db.prepare('SELECT DISTINCT employee_id FROM shifts WHERE ws=? AND employee_id IS NOT NULL').all(ws).map(r => r.employee_id);
    const sheets = emps.map(id => { const t = computeLines(id, ws); const e = D.getEmployee(id) || {}; return { ...t, employee: e.name || id, customId: e.customId || '', missing: t.lines.filter(l => l.missing).length }; }).sort((a, b) => (a.employee || '').localeCompare(b.employee || ''));
    return ok({ ws, sheets, totals: { hours: round(sheets.reduce((n, s) => n + s.total, 0), 2), ot: round(sheets.reduce((n, s) => n + s.ot, 0), 2), pay: round(sheets.reduce((n, s) => n + s.pay, 0), 2), approved: sheets.filter(s => s.status === 'approved').length } });
  });
  add('PUT', '/api/timesheets/:ws/:emp', DISPATCH, ({ user, params, body }) => {
    const lines = (Array.isArray(body.lines) ? body.lines : []).map(l => ({ shiftId: String(l.shiftId), paid: l.paid == null || l.paid === '' ? null : +l.paid, note: (l.note || '').slice(0, 200) })).filter(l => l.paid != null || l.note);
    const status = body.approve ? 'approved' : 'open';
    db.prepare(`INSERT INTO timesheets(id,ws,employee_id,status,lines_json,approved_by,approved_at,note) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(ws,employee_id) DO UPDATE SET status=excluded.status,lines_json=excluded.lines_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at,note=excluded.note`)
      .run(D.uid(), params.ws, params.emp, status, JSON.stringify(lines), body.approve ? user.id : null, body.approve ? D.now() : null, (body.note || '').slice(0, 300));
    D.audit(user.id, body.approve ? 'timesheet_approved' : 'timesheet_saved', { ws: params.ws, emp: params.emp }); bus.emit({ type: 'timesheets', ws: params.ws });
    return ok(computeLines(params.emp, params.ws));
  });
  add('POST', '/api/timesheets/:ws/approve-all', DISPATCH, ({ user, params }) => {
    const emps = db.prepare('SELECT DISTINCT employee_id FROM shifts WHERE ws=? AND employee_id IS NOT NULL').all(params.ws).map(r => r.employee_id); let n = 0;
    for (const id of emps) { const t = computeLines(id, params.ws); if (t.status === 'approved' || t.lines.some(l => l.missing)) continue; db.prepare(`INSERT INTO timesheets(id,ws,employee_id,status,lines_json,approved_by,approved_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(ws,employee_id) DO UPDATE SET status='approved',approved_by=excluded.approved_by,approved_at=excluded.approved_at`).run(D.uid(), params.ws, id, 'approved', '[]', user.id, D.now()); n++; }
    D.audit(user.id, 'timesheets_approved_all', { ws: params.ws, n }); bus.emit({ type: 'timesheets', ws: params.ws }); return ok({ approved: n, skipped: emps.length - n });
  });
  add('GET', '/api/timesheets/:ws/payroll.csv', DISPATCH, ({ params }) => {
    const ws = params.ws; const rows = [['Employee #', 'Officer', 'Week start', 'Regular hours', 'OT hours', 'Holiday hours', 'PTO hours', 'Total hours', 'Pay rate', 'Gross pay', 'Status']];
    for (const id of db.prepare('SELECT DISTINCT employee_id FROM shifts WHERE ws=? AND employee_id IS NOT NULL').all(ws).map(r => r.employee_id)) {
      const t = computeLines(id, ws); const e = D.getEmployee(id) || {}; const hol = round(t.lines.filter(l => l.holiday).reduce((n, l) => n + l.paid, 0), 2); const pto = round(t.lines.filter(l => l.pto).reduce((n, l) => n + l.paid, 0), 2);
      rows.push([e.customId || '', e.name || id, ws, round(t.total - t.ot, 2), t.ot, hol, pto, t.total, t.lines[0] ? t.lines[0].payRate : '', t.pay, t.status]);
    }
    return { csv: rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n'), filename: `payroll-${ws}.csv` };
  });

  /* ---------- invoices ---------- */
  function nextNumber() { const y = T.localDate().slice(0, 4); const last = db.prepare("SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(`INV-${y}-%`); const n = last ? +last.number.split('-')[2] + 1 : 1; return `INV-${y}-${String(n).padStart(4, '0')}`; }
  const invoiceView = r => ({ ...r, lines: JSON.parse(r.lines_json || '[]'), site: (D.siteLite(r.site_id) || {}).name, siteEmail: (D.siteLite(r.site_id) || {}).email, daysOverdue: r.status === 'sent' && r.due_date && r.due_date < T.localDate() ? Math.round((T.toInstant(T.localDate() + 'T00:00') - T.toInstant(r.due_date + 'T00:00')) / 864e5) : 0 });
  function buildLines(siteId, from, to) {
    const shifts = db.prepare('SELECT * FROM shifts WHERE site_id=? AND s>=? AND s<? AND employee_id IS NOT NULL AND pto=0 ORDER BY s').all(siteId, from + 'T00:00', T.addDays(to, 1) + 'T00:00');
    const byKey = new Map(); let unapproved = 0;
    for (const r of shifts) {
      const ws = r.ws; const t = computeLines(r.employee_id, ws); const line = t.lines.find(l => l.shiftId === r.id); if (!line) continue;
      if (t.status !== 'approved') unapproved++;
      const k = `${line.posId}|${line.holiday ? 'H' : 'R'}`; const cur = byKey.get(k) || { posId: line.posId, description: `${line.pos}${line.holiday ? ' (holiday)' : ''}`, rate: round(line.billRate * (line.holiday ? line.holMult : 1), 2), hours: 0, otHours: 0, otRate: round(line.billRate * line.otMult, 2) };
      cur.hours = round(cur.hours + line.reg, 2); cur.otHours = round(cur.otHours + line.ot, 2); byKey.set(k, cur);
    }
    const lines = [];
    for (const l of byKey.values()) { if (l.hours) lines.push({ type: 'service', description: l.description, hours: l.hours, rate: l.rate, amount: round(l.hours * l.rate, 2) }); if (l.otHours) lines.push({ type: 'service', description: l.description + ' — overtime', hours: l.otHours, rate: l.otRate, amount: round(l.otHours * l.otRate, 2) }); }
    return { lines, unapproved, shifts: shifts.length };
  }
  function totals(lines) { const subtotal = round(lines.filter(l => l.type !== 'credit').reduce((n, l) => n + (l.amount || 0), 0), 2); const credits = round(lines.filter(l => l.type === 'credit').reduce((n, l) => n + Math.abs(l.amount || 0), 0), 2); return { subtotal, credits, total: round(subtotal - credits, 2) }; }
  add('GET', '/api/invoices', DISPATCH, ({ query }) => { const st = query.get('status'); const rows = st ? db.prepare('SELECT * FROM invoices WHERE status=? ORDER BY created_at DESC LIMIT 300').all(st) : db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 300').all(); return ok({ invoices: rows.map(invoiceView) }); });
  add('GET', '/api/invoices/aging', DISPATCH, () => {
    const open = db.prepare("SELECT * FROM invoices WHERE status='sent' ORDER BY due_date").all().map(invoiceView); const today = T.localDate();
    const bucket = inv => !inv.due_date || inv.due_date >= today ? 'current' : inv.daysOverdue <= 30 ? '1-30' : inv.daysOverdue <= 60 ? '31-60' : inv.daysOverdue <= 90 ? '61-90' : '90+';
    const sums = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }; for (const i of open) sums[bucket(i)] = round(sums[bucket(i)] + i.total, 2);
    return ok({ open: open.map(i => ({ ...i, bucket: bucket(i) })), sums, total: round(open.reduce((n, i) => n + i.total, 0), 2) });
  });
  add('POST', '/api/invoices/generate', DISPATCH, ({ user, body }) => {
    const from = String(body.from || '').slice(0, 10), to = String(body.to || '').slice(0, 10); if (!from || !to || to < from) return err(400, 'Pick a valid period');
    const siteIds = body.siteId ? [String(body.siteId)] : db.prepare('SELECT DISTINCT site_id FROM shifts WHERE s>=? AND s<? AND employee_id IS NOT NULL AND pto=0').all(from + 'T00:00', T.addDays(to, 1) + 'T00:00').map(r => r.site_id);
    const created = [], skipped = [];
    for (const siteId of siteIds) {
      if (db.prepare("SELECT 1 FROM invoices WHERE site_id=? AND period_from=? AND period_to=? AND status<>'void'").get(siteId, from, to)) { skipped.push({ siteId, why: 'already invoiced' }); continue; }
      const b = buildLines(siteId, from, to); if (!b.lines.length) { skipped.push({ siteId, why: 'no billable hours' }); continue; }
      if (b.unapproved && !body.allowUnapproved) { skipped.push({ siteId, why: `${b.unapproved} shift(s) on unapproved timesheets` }); continue; }
      const t = totals(b.lines); const id = D.uid(); const due = T.addDays(to, cfg.invoiceTermsDays || 30);
      db.prepare('INSERT INTO invoices(id,number,site_id,period_from,period_to,status,lines_json,subtotal,credits,total,created_at,due_date,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, nextNumber(), siteId, from, to, 'draft', JSON.stringify(b.lines), t.subtotal, t.credits, t.total, D.now(), due, '');
      created.push(id);
    }
    D.audit(user.id, 'invoices_generated', { from, to, created: created.length }); bus.emit({ type: 'invoices' });
    return ok({ created, skipped: skipped.map(s => ({ ...s, site: (D.siteLite(s.siteId) || {}).name })) });
  });
  add('GET', '/api/invoices/:id', DISPATCH, ({ params }) => { const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(params.id); if (!r) return err(404, 'No such invoice'); return ok(invoiceView(r)); });
  add('PUT', '/api/invoices/:id', DISPATCH, ({ user, params, body }) => {
    const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(params.id); if (!r) return err(404, 'No such invoice'); if (r.status === 'paid') return err(400, 'Paid invoices cannot be edited');
    const lines = (Array.isArray(body.lines) ? body.lines : JSON.parse(r.lines_json)).map(l => ({ type: l.type === 'credit' ? 'credit' : l.type === 'adhoc' ? 'adhoc' : 'service', description: String(l.description || '').slice(0, 200), hours: l.hours == null ? null : +l.hours, rate: l.rate == null ? null : +l.rate, amount: round(+l.amount || (l.hours && l.rate ? l.hours * l.rate : 0), 2) }));
    const t = totals(lines);
    db.prepare('UPDATE invoices SET lines_json=?, subtotal=?, credits=?, total=?, note=?, due_date=COALESCE(?, due_date) WHERE id=?').run(JSON.stringify(lines), t.subtotal, t.credits, t.total, (body.note || r.note || '').slice(0, 500), body.dueDate ? String(body.dueDate).slice(0, 10) : null, r.id);
    D.audit(user.id, 'invoice_edited', { id: r.id }); bus.emit({ type: 'invoices' }); return ok(invoiceView(db.prepare('SELECT * FROM invoices WHERE id=?').get(r.id)));
  });
  add('POST', '/api/invoices/:id/credit', DISPATCH, ({ user, params, body }) => {
    const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(params.id); if (!r) return err(404, 'No such invoice'); const amt = Math.abs(+body.amount || 0); if (!amt) return err(400, 'Enter a credit amount');
    const lines = JSON.parse(r.lines_json); lines.push({ type: 'credit', description: 'Credit memo: ' + (body.note || '').slice(0, 160), hours: null, rate: null, amount: -amt }); const t = totals(lines);
    db.prepare('UPDATE invoices SET lines_json=?, subtotal=?, credits=?, total=? WHERE id=?').run(JSON.stringify(lines), t.subtotal, t.credits, t.total, r.id);
    D.audit(user.id, 'credit_memo', { id: r.id, amt }); bus.emit({ type: 'invoices' }); return ok(invoiceView(db.prepare('SELECT * FROM invoices WHERE id=?').get(r.id)));
  });
  add('POST', '/api/invoices/:id/send', DISPATCH, async ({ user, params, body }) => {
    const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(params.id); if (!r) return err(404, 'No such invoice'); const v = invoiceView(r);
    const to = (body.to && body.to.length ? body.to : [v.siteEmail]).filter(Boolean); if (!to.length) return err(400, 'The site has no billing email — enter one');
    const text = `Invoice ${v.number} from ${cfg.company || 'Guard Pro'}\nSite: ${v.site}\nPeriod: ${v.period_from} to ${v.period_to}\nDue: ${v.due_date}\n\n` + v.lines.map(l => `${l.description}${l.hours ? ` — ${l.hours} h × $${l.rate}` : ''}: $${l.amount.toFixed(2)}`).join('\n') + `\n\nTotal due: $${v.total.toFixed(2)}\n\nView online: ${cfg.baseUrl}/invoices/${v.id}`;
    const sent = await notify.email(`Invoice ${v.number} — ${v.site}`, text, to);
    db.prepare("UPDATE invoices SET status='sent', sent_at=?, sent_to=? WHERE id=?").run(D.now(), to.join(', '), r.id);
    D.audit(user.id, 'invoice_sent', { id: r.id, to }); bus.emit({ type: 'invoices' }); return ok({ ok: true, delivered: sent, to });
  });
  add('POST', '/api/invoices/:id/paid', DISPATCH, ({ user, params, body }) => { const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(params.id); if (!r) return err(404, 'No such invoice'); db.prepare("UPDATE invoices SET status='paid', paid_at=?, paid_amount=? WHERE id=?").run(D.now(), body.amount != null ? +body.amount : r.total, r.id); D.audit(user.id, 'invoice_paid', { id: r.id }); bus.emit({ type: 'invoices' }); return ok({ ok: true }); });
  add('POST', '/api/invoices/:id/void', DISPATCH, ({ user, params }) => { db.prepare("UPDATE invoices SET status='void' WHERE id=? AND status<>'paid'").run(params.id); D.audit(user.id, 'invoice_void', { id: params.id }); bus.emit({ type: 'invoices' }); return ok({ ok: true }); });
  // printable invoice page
  add('GET', '/invoices/:id', null, ({ params, user }) => {
    const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(params.id); if (!r) return { status: 404, html: '<h1>Invoice not found</h1>' };
    if (!user || !['dispatch', 'admin', 'client'].includes(user.role)) return { status: 401, html: '<h1>Sign in to view this invoice</h1><p><a href="/dispatch/">Dispatch sign in</a> · <a href="/client/">Client portal</a></p>' };
    const v = invoiceView(r); const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return { status: 200, html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.number)}</title><style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;color:#131C33}h1{font-size:28px;margin:0}.hd{display:flex;justify-content:space-between;border-bottom:3px solid #0A1F44;padding-bottom:12px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}td.n,th.n{text-align:right}.tot td{font-weight:bold;border-top:2px solid #0A1F44}.muted{color:#5D6780}@media print{body{margin:0}}</style></head><body>
<div class="hd"><div><h1>${esc(cfg.company || 'Guard Pro')}</h1><div class="muted">${esc(cfg.companyAddress || '')}</div></div><div style="text-align:right"><div style="font-size:22px;font-weight:bold">${esc(v.number)}</div><div>Issued ${esc(v.created_at.slice(0, 10))}</div><div>Due ${esc(v.due_date || '')}</div><div><b>${esc(v.status.toUpperCase())}</b></div></div></div>
<p><b>Bill to:</b> ${esc(v.site)}<br>Period: ${esc(v.period_from)} to ${esc(v.period_to)}</p>
<table><tr><th>Description</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr>${v.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="n">${l.hours ?? ''}</td><td class="n">${l.rate != null ? '$' + l.rate.toFixed(2) : ''}</td><td class="n">$${l.amount.toFixed(2)}</td></tr>`).join('')}
<tr><td colspan="3" class="n">Subtotal</td><td class="n">$${v.subtotal.toFixed(2)}</td></tr>${v.credits ? `<tr><td colspan="3" class="n">Credits</td><td class="n">-$${v.credits.toFixed(2)}</td></tr>` : ''}<tr class="tot"><td colspan="3" class="n">Total due</td><td class="n">$${v.total.toFixed(2)}</td></tr></table>
${v.note ? `<p class="muted">${esc(v.note)}</p>` : ''}<p class="muted">Thank you for your business.</p></body></html>` };
  });

  return { computeLines, effectiveRates };
};
