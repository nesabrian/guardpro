// Dashboard: KPI tiles, an activity feed built from every event table, and dispatcher clock-in/out.
module.exports = function ({ add, err, ok, R, bus, D, T, cfg, clockOf }) {
  const { DISPATCH } = R; const db = D.db;
  const empName = id => (id && D.getEmployee(id) || {}).name || 'Open shift';
  const siteName = id => (D.siteLite(id) || {}).name || '';
  const shiftInfo = id => { const sh = D.getShift(id); if (!sh) return { label: 'shift', site: '', ws: null }; const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(sh.pos) || {}; return { label: `${siteName(sh.site)} · ${pos.name || ''} · ${T.fmtTime(sh.s)}–${T.fmtTime(sh.e)}`, site: siteName(sh.site), ws: T.sundayOf(sh.s.slice(0, 10)), emp: sh.emp, sh }; };

  function activity(hours, limit) {
    const since = new Date(Date.now() - hours * 3600e3).toISOString(); const ev = [];
    for (const c of db.prepare('SELECT * FROM clockins WHERE at>=? ORDER BY at DESC LIMIT 400').all(since)) { const i = shiftInfo(c.shift_id); ev.push({ at: c.at, kind: c.kind === 'in' ? (c.flagged ? 'clock_in_flagged' : 'clock_in') : 'clock_out', icon: c.kind === 'in' ? (c.flagged ? '⚠️' : '🟢') : '⚪', text: `${empName(c.employee_id)} clocked ${c.kind} · ${i.label}${c.note ? ' · ' + c.note : ''}`, shiftId: c.shift_id, ws: i.ws }); }
    for (const a of db.prepare('SELECT * FROM alerts WHERE at>=? ORDER BY at DESC LIMIT 200').all(since)) { const i = shiftInfo(a.shift_id); ev.push({ at: a.at, kind: 'alert_' + a.kind, icon: a.kind === 'late' ? '🚨' : a.kind === 'missed' ? '❌' : '⚠️', text: `${a.kind === 'late' ? 'Late clock-in' : a.kind === 'missed' ? 'Missed shift' : 'Lone-worker check-in missed'} · ${a.detail || i.label}${a.resolved_at ? ' · resolved' : ''}`, shiftId: a.shift_id, ws: i.ws, attention: !a.resolved_at }); }
    for (const r of db.prepare('SELECT * FROM reports WHERE at>=? ORDER BY at DESC LIMIT 200').all(since)) ev.push({ at: r.at, kind: 'report_' + r.kind, icon: r.kind === 'incident' ? (r.flagged ? '🚨' : '📝') : r.kind === 'patrol' ? '🚗' : '📋', text: `${r.kind === 'incident' ? 'Incident report' : r.kind === 'patrol' ? 'Patrol report' : 'Daily report'} · ${siteName(r.site_id)} · ${empName(r.employee_id)} · ${r.title}${r.status !== 'submitted' ? ' · ' + r.status : ''}`, reportId: r.id, attention: r.status === 'submitted' && (r.kind === 'incident' || r.flagged) });
    for (const s of db.prepare('SELECT s.*, c.name AS cp_name FROM checkpoint_scans s JOIN checkpoints c ON c.id=s.checkpoint_id WHERE s.at>=? ORDER BY s.at DESC LIMIT 400').all(since)) ev.push({ at: s.at, kind: 'scan', icon: '📍', text: `${empName(s.employee_id)} scanned ${s.cp_name} · ${shiftInfo(s.shift_id).site}`, shiftId: s.shift_id });
    for (const q of db.prepare('SELECT * FROM shift_requests WHERE at>=? OR decided_at>=? ORDER BY at DESC LIMIT 200').all(since, since)) { const i = shiftInfo(q.shift_id); const kind = { pickup: 'pick up', drop: 'drop', swap: 'swap' }[q.kind] || q.kind; ev.push({ at: q.at, kind: 'request', icon: '✉️', text: `${empName(q.employee_id)} asked to ${kind} ${i.label}${q.note ? ' · "' + q.note + '"' : ''}`, attention: q.status === 'pending' }); if (q.decided_at && q.decided_at >= since) ev.push({ at: q.decided_at, kind: 'request_' + q.status, icon: q.status === 'approved' ? '✅' : '🚫', text: `${q.kind} request ${q.status} · ${empName(q.employee_id)} · ${i.label}` }); }
    for (const q of db.prepare('SELECT * FROM time_off_requests WHERE at>=? OR decided_at>=? ORDER BY at DESC LIMIT 100').all(since, since)) { ev.push({ at: q.at, kind: 'timeoff', icon: '🏖️', text: `${empName(q.employee_id)} requested time off ${q.from_date}${q.to_date !== q.from_date ? ' to ' + q.to_date : ''}`, attention: q.status === 'pending' }); if (q.decided_at && q.decided_at >= since) ev.push({ at: q.decided_at, kind: 'timeoff_' + q.status, icon: q.status === 'approved' ? '✅' : '🚫', text: `Time off ${q.status} · ${empName(q.employee_id)} · ${q.from_date}` }); }
    for (const rs of db.prepare('SELECT rs.*, r.name AS route FROM runsheets rs JOIN routes r ON r.id=rs.route_id WHERE rs.started_at>=? OR rs.ended_at>=? ORDER BY rs.started_at DESC LIMIT 100').all(since, since)) { if (rs.started_at >= since) ev.push({ at: rs.started_at, kind: 'runsheet_start', icon: '🚗', text: `${empName(rs.employee_id)} started patrol ${rs.route}${rs.vehicle ? ' in ' + rs.vehicle : ''}` }); if (rs.ended_at && rs.ended_at >= since) ev.push({ at: rs.ended_at, kind: 'runsheet_end', icon: '🏁', text: `${empName(rs.employee_id)} finished patrol ${rs.route}` }); }
    for (const v of db.prepare('SELECT v.*, rs.employee_id, r.stops_json FROM runsheet_visits v JOIN runsheets rs ON rs.id=v.runsheet_id JOIN routes r ON r.id=rs.route_id WHERE v.arrived_at>=? ORDER BY v.arrived_at DESC LIMIT 300').all(since)) { const stop = (JSON.parse(v.stops_json)[v.stop_index] || {}); ev.push({ at: v.arrived_at, kind: 'visit', icon: v.status === 'late' ? '🕒' : '📍', text: `${empName(v.employee_id)} arrived at ${siteName(stop.siteId)}${v.status === 'late' ? ' (late)' : ''}${v.note ? ' · ' + v.note : ''}` }); }
    for (const l of db.prepare("SELECT * FROM lone_checkins WHERE at>=? ORDER BY at DESC LIMIT 200").all(since)) ev.push({ at: l.at, kind: 'lone_' + l.kind, icon: l.kind === 'ok' ? '🙋' : '⚠️', text: `${empName(l.employee_id)} ${l.kind === 'ok' ? 'checked in OK' : 'missed a lone-worker check-in'} · ${shiftInfo(l.shift_id).site}`, shiftId: l.shift_id, attention: l.kind === 'missed' });
    for (const a of db.prepare("SELECT a.*, u.name AS who FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.at>=? AND a.action IN ('week_saved','site_saved','employee_saved','invoice_sent','timesheet_approved','report_sent','user_created','client_saved') ORDER BY a.id DESC LIMIT 100").all(since)) { const d = a.detail ? JSON.parse(a.detail) : {}; const label = { week_saved: `saved the schedule for the week of ${d.ws}`, site_saved: `saved site ${d.name || ''}`, employee_saved: `saved officer ${d.name || ''}`, invoice_sent: 'sent an invoice', timesheet_approved: `approved a timesheet (week of ${d.ws})`, report_sent: 'sent a report to a client', user_created: `created a login for ${d.email || ''}`, client_saved: `set up a client portal login for ${d.email || ''}` }[a.action]; ev.push({ at: a.at, kind: 'admin', icon: '🖊️', text: `${a.who || 'Dispatch'} ${label}` }); }
    ev.sort((x, y) => y.at.localeCompare(x.at));
    return ev.slice(0, limit);
  }
  add('GET', '/api/activity', DISPATCH, ({ query }) => ok({ events: activity(Math.min(168, +query.get('hours') || 24), Math.min(500, +query.get('limit') || 200)), now: T.localString() }));
  add('GET', '/api/dashboard', DISPATCH, () => {
    const nowL = T.localString(); const today = T.localDate(); const ws = T.sundayOf(today);
    const current = db.prepare('SELECT sh.* FROM shifts sh WHERE sh.s<=? AND sh.e>? AND sh.pto=0').all(nowL, nowL);
    let onPost = 0, late = 0, due = 0, openNow = 0; for (const r of current) { if (!r.employee_id) { openNow++; continue; } const c = clockOf(r.id); if (c.in && !c.out) onPost++; else if (!c.in) { if (T.minutesSince(r.s) >= (cfg.lateAfterMinutes || 10)) late++; else due++; } }
    const openToday = db.prepare('SELECT COUNT(*) c FROM shifts WHERE employee_id IS NULL AND pto=0 AND s>=? AND s<?').get(today + 'T00:00', T.addDays(today, 1) + 'T00:00').c;
    const openWeek = db.prepare('SELECT COUNT(*) c FROM shifts WHERE employee_id IS NULL AND pto=0 AND ws=? AND s>=?').get(ws, nowL).c;
    const unreviewed = db.prepare("SELECT COUNT(*) c FROM reports WHERE status='submitted'").get().c;
    const incidents = db.prepare("SELECT COUNT(*) c FROM reports WHERE status='submitted' AND kind='incident'").get().c;
    const pending = db.prepare("SELECT (SELECT COUNT(*) FROM shift_requests WHERE status='pending') + (SELECT COUNT(*) FROM time_off_requests WHERE status='pending') n").get().n;
    const unacked = db.prepare("SELECT COUNT(*) c FROM shifts WHERE pub=1 AND employee_id IS NOT NULL AND ack_at IS NULL AND s>=? AND s<?").get(nowL, T.addDays(today, 2) + 'T00:00').c;
    const patrols = db.prepare("SELECT COUNT(*) c FROM runsheets WHERE status='active'").get().c;
    const missedStops = db.prepare("SELECT COUNT(*) c FROM runsheet_visits v JOIN runsheets rs ON rs.id=v.runsheet_id JOIN shifts sh ON sh.id=rs.shift_id WHERE v.status='missed' AND sh.s>=?").get(today + 'T00:00').c;
    const unresolved = db.prepare("SELECT COUNT(*) c FROM alerts WHERE resolved_at IS NULL AND at>=?").get(new Date(Date.now() - 12 * 3600e3).toISOString()).c;
    return ok({ now: nowL, tiles: { onPost, late, due, openNow, openToday, openWeek, unreviewed, incidents, pending, unacked, patrols, missedStops, unresolved }, feed: activity(24, 120) });
  });

  /* dispatcher clock-in / clock-out on an officer's behalf */
  add('POST', '/api/shifts/:id/clock', DISPATCH, ({ user, params, body }) => {
    const sh = D.getShift(params.id); if (!sh) return err(404, 'No such shift'); if (!sh.emp) return err(400, 'Assign an officer first');
    const kind = body.kind === 'out' ? 'out' : 'in';
    if (body.undo) { const n = db.prepare('DELETE FROM clockins WHERE shift_id=? AND kind=?').run(sh.id, kind).changes; if (kind === 'in') db.prepare('DELETE FROM clockins WHERE shift_id=? AND kind=?').run(sh.id, 'out'); D.audit(user.id, 'clock_undo', { shift: sh.id, kind }); bus.emit({ type: 'week', ws: T.sundayOf(sh.s.slice(0, 10)) }); bus.emit({ type: 'live' }); return ok({ ok: true, removed: n }); }
    if (db.prepare('SELECT 1 FROM clockins WHERE shift_id=? AND kind=?').get(sh.id, kind)) return err(400, `Already clocked ${kind}`);
    if (kind === 'out' && !db.prepare("SELECT 1 FROM clockins WHERE shift_id=? AND kind='in'").get(sh.id)) return err(400, 'Clock in first');
    let at = D.now();
    if (body.at) { const t = /^\d{2}:\d{2}$/.test(body.at) ? T.toInstant(sh.s.slice(0, 10) + 'T' + body.at) : new Date(body.at); if (isNaN(t)) return err(400, 'Bad time'); if (t.getTime() > Date.now() + 60e3) return err(400, 'Cannot clock in the future'); at = t.toISOString(); }
    const note = `by dispatch (${user.name || user.email})${body.note ? ': ' + String(body.note).slice(0, 200) : ''}`;
    db.prepare('INSERT INTO clockins(id,shift_id,employee_id,kind,at,lat,lng,accuracy_m,distance_m,flagged,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(D.uid(), sh.id, sh.emp, kind, at, null, null, null, null, 0, note);
    if (kind === 'in') db.prepare('UPDATE alerts SET resolved_at=? WHERE shift_id=? AND resolved_at IS NULL').run(D.now(), sh.id);
    D.audit(user.id, 'dispatch_clock_' + kind, { shift: sh.id, at });
    bus.emit({ type: 'week', ws: T.sundayOf(sh.s.slice(0, 10)) }); bus.emit({ type: 'live' });
    return ok({ ok: true, at, note });
  });
};
