// Phase 2 — filling the roster: open-shift pickups, drop and swap requests, time-off requests,
// officer-edited availability, and in-app notifications (a stand-in for push until messaging is set up).
module.exports = function ({ add, err, ok, R, bus, D, T, cfg, notify, officerShiftView }) {
  const { DISPATCH, OFFICER } = R; const db = D.db;

  db.exec(`
  CREATE TABLE IF NOT EXISTS shift_requests (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, shift_id TEXT NOT NULL, employee_id TEXT NOT NULL, target_employee_id TEXT,
    note TEXT, status TEXT NOT NULL DEFAULT 'pending', at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, decision_note TEXT);
  CREATE INDEX IF NOT EXISTS shift_requests_status ON shift_requests(status);
  CREATE TABLE IF NOT EXISTS time_off_requests (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, note TEXT,
    status TEXT NOT NULL DEFAULT 'pending', at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, decision_note TEXT);
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL, link TEXT, read_at TEXT);
  CREATE INDEX IF NOT EXISTS notifications_scope ON notifications(scope, read_at);
  `);

  /* ---------- helpers ---------- */
  const overlaps = (a, b) => a.s < b.e && b.s < a.e;
  function empShifts(empId, from, to) { return db.prepare('SELECT * FROM shifts WHERE employee_id=? AND e>? AND s<?').all(empId, from, to); }
  function weekHours(empId, ws) { const we = T.addDays(ws, 7) + 'T00:00'; return db.prepare("SELECT s,e,brk FROM shifts WHERE employee_id=? AND pto=0 AND ws=?").all(empId, ws).reduce((h, r) => h + Math.max(0, (T.toInstant(r.e) - T.toInstant(r.s)) / 36e5 - (r.brk || 0) / 60), 0); }
  function availabilityIssue(emp, sh) {
    if (!emp.avail || !emp.avail.length) return null;
    let s = T.toInstant(sh.s), e = T.toInstant(sh.e), worst = null;
    while (s < e) {
      const p = T.parts(s); const dayStart = T.toInstant(`${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T00:00`); const dayEnd = new Date(dayStart.getTime() + 864e5);
      const segEnd = e < dayEnd ? e : dayEnd; const f = (s - dayStart) / 1000, t = (segEnd - dayStart) / 1000, wd = p.wd;
      for (const a of emp.avail) { if (a.d !== wd) continue; if (a.f < t && f < a.t) { if (a.a === 'N') return 'unavailable'; worst = 'maybe'; } }
      s = segEnd;
    }
    return worst;
  }
  function eligibility(emp, sh) {
    const reasons = [];
    const pos = db.prepare('SELECT armed FROM positions WHERE id=?').get(sh.pos);
    if (pos && pos.armed && !emp.armed) reasons.push('armed post');
    if (empShifts(emp.id, sh.s, sh.e).some(o => o.id !== sh.id)) reasons.push('overlaps another shift');
    const av = availabilityIssue(emp, sh); if (av === 'unavailable') reasons.push('marked unavailable');
    const d = sh.s.slice(0, 10), d2 = sh.e.slice(0, 10); if ((emp.off || []).some(o => o.from <= d2 && d <= o.to)) reasons.push('time off');
    const ws = T.sundayOf(d); const hrs = Math.max(0, (T.toInstant(sh.e) - T.toInstant(sh.s)) / 36e5 - (sh.brk || 0) / 60);
    const projected = weekHours(emp.id, ws) + hrs; const ot = projected > (emp.maxHours || 40);
    return { eligible: reasons.length === 0, reasons, projected: Math.round(projected * 4) / 4, ot };
  }
  function notifyEmp(empId, text, link) { db.prepare('INSERT INTO notifications(id,scope,at,text,link) VALUES (?,?,?,?,?)').run(D.uid(), 'emp:' + empId, D.now(), text, link || null); bus.emit({ type: 'notify', scope: 'emp:' + empId }); }
  function notifyDispatch(text, link) { db.prepare('INSERT INTO notifications(id,scope,at,text,link) VALUES (?,?,?,?,?)').run(D.uid(), 'dispatch', D.now(), text, link || null); bus.emit({ type: 'notify', scope: 'dispatch' }); }
  const empName = id => (D.getEmployee(id) || {}).name || 'Officer';
  function shiftLabel(sh) { const site = D.siteLite(sh.site); const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(sh.pos); return `${site ? site.name : '?'} · ${pos ? pos.name : '?'} · ${T.fmtTime(sh.s)}–${T.fmtTime(sh.e)} ${sh.s.slice(5, 10)}`; }
  function requestView(r) { const sh = D.getShift(r.shift_id); return { ...r, employee: empName(r.employee_id), target: r.target_employee_id ? empName(r.target_employee_id) : null, shift: sh ? { ...sh, label: shiftLabel(sh) } : null }; }

  /* ---------- officer: open-shift board ---------- */
  add('GET', '/api/officer/open', OFFICER, ({ user }) => {
    const emp = D.getEmployee(user.employee_id); if (!emp) return err(404, 'No officer record');
    const from = T.localString(), to = T.addDays(T.localDate(), 15) + 'T00:00';
    const rows = db.prepare('SELECT * FROM shifts WHERE employee_id IS NULL AND pto=0 AND pub=1 AND s>=? AND s<? ORDER BY s').all(from, to);
    const mine = new Map(db.prepare("SELECT shift_id, status FROM shift_requests WHERE employee_id=? AND kind='pickup' AND status='pending'").all(emp.id).map(r => [r.shift_id, r.status]));
    const shifts = rows.map(r => { const v = officerShiftView(r); const el = eligibility(emp, D.shiftDoc(r)); return { ...v, eligible: el.eligible, reasons: el.reasons, projected: el.projected, ot: el.ot, requested: mine.has(r.id) }; });
    return ok({ shifts, now: T.localString() });
  });
  add('GET', '/api/officer/requests', OFFICER, ({ user }) => ok({ requests: db.prepare('SELECT * FROM shift_requests WHERE employee_id=? ORDER BY at DESC LIMIT 50').all(user.employee_id).map(requestView),
    timeOff: db.prepare('SELECT * FROM time_off_requests WHERE employee_id=? ORDER BY at DESC LIMIT 50').all(user.employee_id) }));
  add('POST', '/api/officer/requests', OFFICER, ({ user, body }) => {
    const emp = D.getEmployee(user.employee_id); const sh = D.getShift(body.shiftId); if (!sh) return err(404, 'Shift not found');
    const kind = ['pickup', 'drop', 'swap'].includes(body.kind) ? body.kind : null; if (!kind) return err(400, 'Unknown request type');
    if (kind === 'pickup') { if (sh.emp) return err(400, 'That shift is no longer open'); const el = eligibility(emp, sh); if (!el.eligible) return err(400, 'Not eligible: ' + el.reasons.join(', ')); }
    else { if (String(sh.emp) !== String(emp.id)) return err(400, 'That shift is not yours'); if (sh.s <= T.localString()) return err(400, 'That shift has already started'); }
    let target = null;
    if (kind === 'swap') { target = D.getEmployee(body.targetEmployeeId); if (!target) return err(400, 'Pick the officer to swap with'); const el = eligibility(target, sh); if (!el.eligible) return err(400, `${target.name} cannot take it: ${el.reasons.join(', ')}`); }
    if (db.prepare("SELECT 1 FROM shift_requests WHERE shift_id=? AND employee_id=? AND status='pending'").get(sh.id, emp.id)) return err(400, 'You already have a pending request on that shift');
    const id = D.uid();
    db.prepare('INSERT INTO shift_requests(id,kind,shift_id,employee_id,target_employee_id,note,status,at) VALUES (?,?,?,?,?,?,?,?)').run(id, kind, sh.id, emp.id, target ? target.id : null, (body.note || '').slice(0, 500), 'pending', D.now());
    D.audit(user.id, 'request_' + kind, { shift: sh.id });
    notifyDispatch(`${emp.name} asks to ${kind === 'pickup' ? 'pick up' : kind === 'drop' ? 'drop' : 'swap'} ${shiftLabel(sh)}${target ? ' with ' + target.name : ''}`, 'requests');
    bus.emit({ type: 'requests' });
    return ok({ id });
  });
  add('DELETE', '/api/officer/requests/:id', OFFICER, ({ user, params }) => {
    const r = db.prepare("SELECT * FROM shift_requests WHERE id=? AND employee_id=? AND status='pending'").get(params.id, user.employee_id); if (!r) return err(404, 'No pending request with that id');
    db.prepare("UPDATE shift_requests SET status='cancelled', decided_at=? WHERE id=?").run(D.now(), r.id); bus.emit({ type: 'requests' }); return ok({ ok: true });
  });
  add('GET', '/api/officer/colleagues', OFFICER, () => ok({ officers: D.listEmployees().filter(e => e.status === 'ACTIVE').map(e => ({ id: e.id, name: e.name, armed: e.armed })) }));

  /* ---------- officer: time off + availability ---------- */
  add('POST', '/api/officer/timeoff', OFFICER, ({ user, body }) => {
    const from = String(body.from || '').slice(0, 10), to = String(body.to || from).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return err(400, 'Pick valid dates');
    if (from < T.localDate()) return err(400, 'Time off cannot start in the past');
    const id = D.uid(); db.prepare('INSERT INTO time_off_requests(id,employee_id,from_date,to_date,note,status,at) VALUES (?,?,?,?,?,?,?)').run(id, user.employee_id, from, to, (body.note || '').slice(0, 300), 'pending', D.now());
    const conflicts = db.prepare("SELECT COUNT(*) c FROM shifts WHERE employee_id=? AND s<? AND e>?").get(user.employee_id, T.addDays(to, 1) + 'T00:00', from + 'T00:00').c;
    notifyDispatch(`${empName(user.employee_id)} requests time off ${from}${to !== from ? ' to ' + to : ''}${conflicts ? ` (${conflicts} scheduled shift${conflicts > 1 ? 's' : ''} affected)` : ''}`, 'requests');
    bus.emit({ type: 'requests' }); return ok({ id, conflicts });
  });
  add('DELETE', '/api/officer/timeoff/:id', OFFICER, ({ user, params }) => { const n = db.prepare("UPDATE time_off_requests SET status='cancelled', decided_at=? WHERE id=? AND employee_id=? AND status='pending'").run(D.now(), params.id, user.employee_id).changes; if (!n) return err(404, 'No pending request'); bus.emit({ type: 'requests' }); return ok({ ok: true }); });
  add('PUT', '/api/officer/availability', OFFICER, ({ user, body }) => {
    const emp = D.getEmployee(user.employee_id); if (!emp) return err(404, 'No officer record');
    const avail = (Array.isArray(body.avail) ? body.avail : []).map(a => ({ d: +a.d, f: +a.f, t: +a.t, a: a.a === 'M' ? 'M' : 'N' })).filter(a => a.d >= 0 && a.d <= 6 && a.f >= 0 && a.t <= 86400 && a.t > a.f).slice(0, 40);
    emp.avail = avail; D.putEmployee(emp); D.audit(user.id, 'availability_updated', { n: avail.length }); bus.emit({ type: 'employees' }); return ok({ ok: true, avail });
  });

  /* ---------- notifications ---------- */
  add('GET', '/api/notifications', [...R.ANY], ({ user }) => {
    const scope = user.role === 'officer' ? 'emp:' + user.employee_id : 'dispatch';
    return ok({ notifications: db.prepare('SELECT * FROM notifications WHERE scope=? ORDER BY at DESC LIMIT 30').all(scope), unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE scope=? AND read_at IS NULL').get(scope).c });
  });
  add('POST', '/api/notifications/read', [...R.ANY], ({ user }) => { const scope = user.role === 'officer' ? 'emp:' + user.employee_id : 'dispatch'; db.prepare('UPDATE notifications SET read_at=? WHERE scope=? AND read_at IS NULL').run(D.now(), scope); return ok({ ok: true }); });

  /* ---------- dispatch: review requests ---------- */
  add('GET', '/api/requests', DISPATCH, ({ query }) => {
    const status = query.get('status') || 'pending';
    const reqs = db.prepare('SELECT * FROM shift_requests WHERE status=? ORDER BY at DESC LIMIT 200').all(status).map(requestView);
    const timeOff = db.prepare('SELECT * FROM time_off_requests WHERE status=? ORDER BY at DESC LIMIT 200').all(status).map(r => ({ ...r, employee: empName(r.employee_id),
      conflicts: db.prepare('SELECT id, s, e, site_id FROM shifts WHERE employee_id=? AND s<? AND e>?').all(r.employee_id, T.addDays(r.to_date, 1) + 'T00:00', r.from_date + 'T00:00').map(s => ({ ...s, site: (D.siteLite(s.site_id) || {}).name })) }));
    return ok({ requests: reqs, timeOff, pending: db.prepare("SELECT (SELECT COUNT(*) FROM shift_requests WHERE status='pending') + (SELECT COUNT(*) FROM time_off_requests WHERE status='pending') n").get().n });
  });
  add('POST', '/api/requests/:id/decide', DISPATCH, ({ user, params, body }) => {
    const r = db.prepare("SELECT * FROM shift_requests WHERE id=? AND status='pending'").get(params.id); if (!r) return err(404, 'Request is no longer pending');
    const approve = !!body.approve; const sh = D.getShift(r.shift_id); if (!sh) return err(404, 'Shift no longer exists');
    if (approve) {
      const emp = D.getEmployee(r.employee_id);
      if (r.kind === 'pickup') {
        if (sh.emp) return err(400, 'Shift was filled by someone else');
        const el = eligibility(emp, sh); if (!el.eligible && !body.force) return err(400, 'Officer is no longer eligible: ' + el.reasons.join(', ') + ' (send force:true to override)');
        db.prepare('UPDATE shifts SET employee_id=?, vac=0, ack_at=NULL, updated_at=?, updated_by=? WHERE id=?').run(emp.id, D.now(), user.id, sh.id);
        for (const other of db.prepare("SELECT id, employee_id FROM shift_requests WHERE shift_id=? AND kind='pickup' AND status='pending' AND id<>?").all(sh.id, r.id)) { db.prepare("UPDATE shift_requests SET status='declined', decided_at=?, decided_by=?, decision_note='filled by another officer' WHERE id=?").run(D.now(), user.id, other.id); notifyEmp(other.employee_id, `${shiftLabel(sh)} went to another officer.`, 'open'); }
        notifyEmp(emp.id, `Approved: you are on ${shiftLabel(sh)}. Please acknowledge it.`, 'shifts');
      } else if (r.kind === 'drop') {
        db.prepare('UPDATE shifts SET employee_id=NULL, vac=1, ack_at=NULL, board=1, updated_at=?, updated_by=? WHERE id=?').run(D.now(), user.id, sh.id);
        notifyEmp(emp.id, `Approved: you are off ${shiftLabel(sh)}.`, 'shifts');
      } else if (r.kind === 'swap') {
        const target = D.getEmployee(r.target_employee_id); if (!target) return err(400, 'Swap partner no longer exists');
        const el = eligibility(target, sh); if (!el.eligible && !body.force) return err(400, `${target.name} is no longer eligible: ${el.reasons.join(', ')}`);
        db.prepare('UPDATE shifts SET employee_id=?, vac=0, ack_at=NULL, updated_at=?, updated_by=? WHERE id=?').run(target.id, D.now(), user.id, sh.id);
        notifyEmp(emp.id, `Approved: ${target.name} takes ${shiftLabel(sh)}.`, 'shifts'); notifyEmp(target.id, `You now have ${shiftLabel(sh)} (swap from ${emp.name}). Please acknowledge it.`, 'shifts');
      }
    } else notifyEmp(r.employee_id, `Declined: ${r.kind} request for ${shiftLabel(sh)}${body.note ? ' — ' + body.note : ''}.`, 'requests');
    db.prepare('UPDATE shift_requests SET status=?, decided_at=?, decided_by=?, decision_note=? WHERE id=?').run(approve ? 'approved' : 'declined', D.now(), user.id, (body.note || '').slice(0, 300), r.id);
    D.audit(user.id, 'request_' + (approve ? 'approved' : 'declined'), { id: r.id, kind: r.kind, shift: sh.id });
    bus.emit({ type: 'requests' }); bus.emit({ type: 'week', ws: sh.s ? T.sundayOf(sh.s.slice(0, 10)) : null });
    return ok({ ok: true });
  });
  add('POST', '/api/timeoff/:id/decide', DISPATCH, ({ user, params, body }) => {
    const r = db.prepare("SELECT * FROM time_off_requests WHERE id=? AND status='pending'").get(params.id); if (!r) return err(404, 'Request is no longer pending');
    const approve = !!body.approve; const emp = D.getEmployee(r.employee_id); if (!emp) return err(404, 'Officer not found');
    if (approve) { emp.off = [...(emp.off || []), { from: r.from_date, to: r.to_date, note: r.note || '' }].sort((a, b) => a.from.localeCompare(b.from)); D.putEmployee(emp); }
    db.prepare('UPDATE time_off_requests SET status=?, decided_at=?, decided_by=?, decision_note=? WHERE id=?').run(approve ? 'approved' : 'declined', D.now(), user.id, (body.note || '').slice(0, 300), r.id);
    notifyEmp(emp.id, `${approve ? 'Approved' : 'Declined'}: time off ${r.from_date}${r.to_date !== r.from_date ? ' to ' + r.to_date : ''}${body.note ? ' — ' + body.note : ''}.`, 'requests');
    D.audit(user.id, 'timeoff_' + (approve ? 'approved' : 'declined'), { id: r.id });
    bus.emit({ type: 'requests' }); bus.emit({ type: 'employees' });
    return ok({ ok: true });
  });

  return { eligibility, notifyEmp, notifyDispatch, shiftLabel };
};
