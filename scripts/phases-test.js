// End-to-end checks for Phases 2–5 against a running server. Creates its own test site, post, shifts,
// route and checkpoints (prefixed "ZZ TEST") and removes them at the end.
// Usage: node scripts/phases-test.js [baseUrl]
const base = process.argv[2] || 'http://localhost:8080';
const cfg = require('../server/config');
const { db } = require('../server/db');
const T = require('../server/time');
let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error('FAIL:', m); } else console.log('ok  ', m); };
async function client() { let cookie = ''; return { async call(method, path, body) { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const ct = r.headers.get('content-type') || ''; const j = ct.includes('json') ? await r.json().catch(() => ({})) : { text: await r.text() }; return { status: r.status, body: j }; } }; }

(async () => {
  const d = await client(); let r;
  r = await d.call('POST', '/api/auth/login', { email: cfg.admin.email, password: cfg.admin.password }); assert(r.status === 200, 'dispatch login');
  // ---- fixtures: two officers with phones, a test site with a post, a route with one stop
  const emps = db.prepare("SELECT * FROM employees WHERE status='ACTIVE' AND phone<>'' ORDER BY id LIMIT 60").all().filter(e => e.phone.replace(/\D/g, '').length >= 10);
  const E1 = emps[0], E2 = emps[1]; assert(E1 && E2, `two officers with phones (${E1 && E1.name}, ${E2 && E2.name})`);
  const siteId = 'zztest-site'; const posId = 'zztest-pos';
  // leftovers from an earlier interrupted run
  db.prepare("DELETE FROM shift_requests WHERE shift_id LIKE 'zztest-%'").run(); db.prepare("DELETE FROM time_off_requests WHERE note='vacation' AND status='pending'").run();
  for (const t of ['clockins', 'checkpoint_scans', 'lone_checkins', 'alerts', 'reminders']) db.prepare(`DELETE FROM ${t} WHERE shift_id LIKE 'zztest-%'`).run();
  db.prepare("DELETE FROM runsheet_visits WHERE runsheet_id IN (SELECT id FROM runsheets WHERE shift_id LIKE 'zztest-%')").run(); db.prepare("DELETE FROM runsheets WHERE shift_id LIKE 'zztest-%'").run();
  db.prepare("DELETE FROM shifts WHERE site_id=?").run(siteId); db.prepare("DELETE FROM reports WHERE site_id=?").run(siteId); db.prepare("DELETE FROM invoices WHERE site_id=?").run(siteId); db.prepare("DELETE FROM rates WHERE ref_id=?").run(posId);
  db.prepare("DELETE FROM routes WHERE name='ZZ TEST ROUTE'").run(); db.prepare("DELETE FROM checkpoints WHERE site_id=?").run(siteId); db.prepare("DELETE FROM tours WHERE site_id=?").run(siteId);
  r = await d.call('PUT', '/api/sites/' + siteId, { name: 'ZZ TEST SITE', customId: 'ZZ', phone: '', email: 'client@example.com', address: '1 Test St, Boston', lat: 42.36, lng: -71.06, radius: 300, postOrders: 'Test post orders', positions: [{ id: posId, name: 'UNARMED GUARD', armed: false, active: true, templates: [] }] });
  assert(r.status === 200, 'test site and post created');
  const day = T.addDays(T.localDate(), 2); const ws = T.sundayOf(day);
  const nowL = T.localString(); const startNow = T.localString(new Date(Date.now() - 20 * 60e3)), endNow = T.localString(new Date(Date.now() + 6 * 3600e3));
  const wk = (await d.call('GET', '/api/weeks/' + ws)).body; const wkNow = (await d.call('GET', '/api/weeks/' + T.sundayOf(startNow.slice(0, 10)))).body;
  const openShift = { id: 'zztest-open', pos: posId, site: siteId, emp: null, s: day + 'T08:00', e: day + 'T16:00', brk: 0, pub: true, vac: true, board: true, pto: false, att: '', note: '' };
  const e1Shift = { id: 'zztest-e1', pos: posId, site: siteId, emp: E1.id, s: day + 'T16:00', e: day + 'T23:00', brk: 0, pub: true, vac: false, board: false, pto: false, att: '', note: '' };
  const liveShift = { id: 'zztest-live', pos: posId, site: siteId, emp: E1.id, s: startNow, e: endNow, brk: 0, pub: true, vac: false, board: false, pto: false, att: '', note: '' };
  const sameWeek = ws === T.sundayOf(startNow.slice(0, 10));
  if (sameWeek) { wk.shifts.push(openShift, e1Shift, liveShift); r = await d.call('PUT', '/api/weeks/' + ws, wk); }
  else { wk.shifts.push(openShift, e1Shift); r = await d.call('PUT', '/api/weeks/' + ws, wk); wkNow.shifts.push(liveShift); r = await d.call('PUT', '/api/weeks/' + T.sundayOf(startNow.slice(0, 10)), wkNow); }
  assert(r.status === 200, 'test shifts saved (open, assigned, live)');

  // ---- officer logins
  async function officer(emp) { const o = await client(); const c = await o.call('POST', '/api/auth/request-code', { phone: emp.phone }); const v = await o.call('POST', '/api/auth/verify', { phone: emp.phone, code: c.body.devCode }); assert(v.status === 200, `officer ${emp.name} signed in`); return o; }
  const o1 = await officer(E1), o2 = await officer(E2);

  // ---- Phase 2: pickup request, approve; drop request; time off; availability; notifications
  r = await o2.call('GET', '/api/officer/open'); const found = r.body.shifts.find(s => s.id === 'zztest-open'); assert(found, `officer 2 sees the open shift (${r.body.shifts.length} open)`);
  r = await o2.call('POST', '/api/officer/requests', { kind: 'pickup', shiftId: 'zztest-open', note: 'happy to' }); assert(r.status === 200 || /Not eligible/.test(r.body.error), 'officer 2 requests pickup: ' + (r.body.error || 'ok')); const reqId = r.body.id;
  if (reqId) {
    r = await d.call('GET', '/api/requests?status=pending'); assert(r.body.requests.some(x => x.id === reqId), 'dispatch sees the pending pickup');
    r = await d.call('POST', '/api/requests/' + reqId + '/decide', { approve: true, force: true }); assert(r.status === 200, 'dispatch approves pickup');
    assert(db.prepare('SELECT employee_id FROM shifts WHERE id=?').get('zztest-open').employee_id === E2.id, 'shift is now assigned to officer 2');
    r = await o2.call('GET', '/api/notifications'); assert(r.body.unread >= 1, 'officer 2 got a notification');
  }
  r = await o1.call('POST', '/api/officer/requests', { kind: 'drop', shiftId: 'zztest-e1', note: 'sick' }); assert(r.status === 200, 'officer 1 asks to drop a shift');
  r = await d.call('POST', '/api/requests/' + r.body.id + '/decide', { approve: true }); assert(r.status === 200 && db.prepare('SELECT employee_id FROM shifts WHERE id=?').get('zztest-e1').employee_id === null, 'drop approved, shift is open again');
  r = await o1.call('POST', '/api/officer/timeoff', { from: T.addDays(T.localDate(), 10), to: T.addDays(T.localDate(), 11), note: 'vacation' }); assert(r.status === 200, 'time-off request sent'); const toId = r.body.id;
  r = await d.call('POST', '/api/timeoff/' + toId + '/decide', { approve: true }); assert(r.status === 200, 'time off approved');
  assert(db.prepare('SELECT off_json FROM employees WHERE id=?').get(E1.id).off_json.includes('vacation'), 'time off recorded on the officer');
  const origAvail = db.prepare('SELECT avail_json FROM employees WHERE id=?').get(E1.id).avail_json;
  r = await o1.call('PUT', '/api/officer/availability', { avail: [{ d: 0, f: 0, t: 86400, a: 'N' }] }); assert(r.status === 200 && r.body.avail.length === 1, 'officer updated availability');
  db.prepare('UPDATE employees SET avail_json=? WHERE id=?').run(origAvail, E1.id);
  r = await d.call('GET', '/api/notifications'); assert(r.body.unread >= 2, `dispatch notifications (${r.body.unread} unread)`);

  // ---- Phase 3: clock in on the live shift, checkpoints, scan, reports, client portal
  r = await d.call('PUT', '/api/sites/' + siteId + '/checkpoints', { checkpoints: [{ name: 'Front gate', instructions: 'Check lock' }, { name: 'Rear door' }], tours: [{ name: 'Hourly', perShift: 2, checkpointIds: [] }] });
  assert(r.status === 200 && r.body.checkpoints.length === 2 && r.body.checkpoints[0].code.length === 8, 'checkpoints created with codes');
  const code = r.body.checkpoints[0].code; const cpIds = r.body.checkpoints.map(c => c.id);
  r = await d.call('PUT', '/api/sites/' + siteId + '/checkpoints', { checkpoints: r.body.checkpoints, tours: [{ name: 'Hourly', perShift: 2, checkpointIds: cpIds }] }); assert(r.body.tours[0].checkpointIds.length === 2, 'tour covers both checkpoints');
  r = await o1.call('POST', '/api/officer/scan', { shiftId: 'zztest-live', code }); assert(r.status === 400, 'scan refused before clock-in');
  r = await o1.call('POST', '/api/officer/shifts/zztest-live/clock', { kind: 'in', lat: 42.3601, lng: -71.06 }); assert(r.status === 200 && !r.body.flagged, 'clocked in inside the geofence (' + r.body.distance + ' m)');
  r = await o1.call('POST', '/api/officer/scan', { shiftId: 'zztest-live', code: 'GP:' + code.toLowerCase(), method: 'qr', lat: 42.3601, lng: -71.06 }); assert(r.status === 200 && r.body.checkpoint === 'Front gate', 'QR scan accepted (case and prefix tolerant)');
  r = await o1.call('POST', '/api/officer/scan', { shiftId: 'zztest-live', code }); assert(r.status === 400, 'duplicate scan within a minute refused');
  r = await o1.call('GET', '/api/officer/shifts/zztest-live/checkpoints'); assert(r.body.expected === 4 && r.body.done === 1, 'tour progress 1 of 4');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await o1.call('POST', '/api/officer/photos', { data: png, name: 'x.png', siteId }); assert(r.status === 200 && r.body.id, 'photo uploaded'); const photoId = r.body.id;
  r = await o1.call('POST', '/api/officer/reports', { kind: 'incident', shiftId: 'zztest-live', fields: { type: 'Theft', description: 'Bike taken from rack, police called', location: 'Rear lot' }, photos: [photoId] }); assert(r.status === 200, 'incident report submitted'); const repId = r.body.id;
  r = await d.call('GET', '/api/reports?status=submitted'); const rep = r.body.reports.find(x => x.id === repId); assert(rep && rep.flagged && rep.photos.length === 1, 'dispatch sees the flagged incident with its photo');
  r = await d.call('GET', '/api/photos/' + photoId); assert(r.status === 200, 'dispatch can open the photo');
  r = await o2.call('GET', '/api/photos/' + photoId); assert(r.status === 403, 'another officer cannot open it');
  r = await d.call('POST', '/api/reports/' + repId + '/send', { to: ['client@example.com'] }); assert(r.status === 200, 'report marked sent to client (email ' + (r.body.delivered ? 'delivered' : 'not configured') + ')');
  r = await d.call('POST', '/api/clients', { name: 'Test Client', email: 'zzclient@example.com', siteIds: [siteId] }); assert(r.status === 200, 'client portal user created'); const clientUid = r.body.id;
  const c = await client(); r = await c.call('POST', '/api/client/request-code', { email: 'zzclient@example.com' }); r = await c.call('POST', '/api/client/verify', { email: 'zzclient@example.com', code: r.body.devCode }); assert(r.status === 200 && r.body.user.role === 'client', 'client signed in with emailed code');
  r = await c.call('GET', '/api/client/overview'); assert(r.status === 200 && r.body.sites.length === 1 && r.body.sites[0].shifts.some(s => s.state === 'on_post') && r.body.reports.some(x => x.id === repId), 'client sees coverage and the sent report');
  r = await c.call('GET', '/api/employees'); assert(r.status === 403, 'client cannot read the roster');
  r = await d.call('GET', '/api/tours/compliance?ws=' + T.sundayOf(startNow.slice(0, 10))); assert(r.body.shifts.some(s => s.shiftId === 'zztest-live' && s.done === 1), 'tour compliance lists the live shift');

  // ---- Phase 4: rates, timesheet, approval, payroll csv, invoice, credit, send, paid, aging
  r = await d.call('PUT', '/api/rates/new', { scope: 'position', refId: posId, billRate: 40, payRate: 22, effectiveFrom: '2026-01-01' }); assert(r.status === 200, 'post rate saved');
  r = await d.call('PUT', '/api/holidays', { holidays: [{ date: '2026-12-25', name: 'Christmas' }] }); assert(r.status === 200, 'holidays saved');
  r = await o1.call('POST', '/api/officer/shifts/zztest-live/clock', { kind: 'out', lat: 42.3601, lng: -71.06 }); assert(r.status === 200, 'clocked out');
  const wsLive = T.sundayOf(startNow.slice(0, 10));
  r = await d.call('GET', '/api/timesheets/' + wsLive); const sheet = r.body.sheets.find(s => s.employeeId === E1.id); const line = sheet && sheet.lines.find(l => l.shiftId === 'zztest-live');
  assert(line && line.actual != null && line.payRate === 22 && line.billRate === 40, `timesheet line built from clock data (actual ${line && line.actual} h, pay $${line && line.payRate})`);
  r = await d.call('PUT', `/api/timesheets/${wsLive}/${E1.id}`, { lines: [{ shiftId: 'zztest-live', paid: 6, note: 'test adjustment' }], approve: true }); assert(r.status === 200 && r.body.status === 'approved' && r.body.lines.find(l => l.shiftId === 'zztest-live').paid === 6, 'timesheet adjusted and approved');
  r = await d.call('GET', `/api/timesheets/${wsLive}/payroll.csv`); assert(r.status === 200 && r.body.text.includes(E1.name), 'payroll CSV includes the officer');
  r = await d.call('POST', '/api/invoices/generate', { siteId, from: startNow.slice(0, 10), to: startNow.slice(0, 10), allowUnapproved: true }); assert(r.status === 200 && r.body.created.length === 1, 'invoice generated for the test site'); const invId = r.body.created[0];
  r = await d.call('GET', '/api/invoices/' + invId); assert(r.body.number.startsWith('INV-') && r.body.total === 240, `invoice ${r.body.number} totals 6 h × $40 = $${r.body.total}`);
  r = await d.call('POST', '/api/invoices/' + invId + '/credit', { amount: 40, note: 'one hour goodwill' }); assert(r.body.total === 200, 'credit memo applied, total now $' + r.body.total);
  r = await d.call('POST', '/api/invoices/' + invId + '/send', { to: ['billing@example.com'] }); assert(r.status === 200, 'invoice marked sent');
  r = await d.call('GET', '/invoices/' + invId); assert(r.status === 200 && r.body.text.includes('Total due'), 'printable invoice page renders');
  r = await d.call('GET', '/api/invoices/aging'); assert(r.body.open.some(i => i.id === invId), 'aging list shows the sent invoice');
  r = await d.call('POST', '/api/invoices/' + invId + '/paid', { amount: 200 }); assert(r.status === 200, 'invoice marked paid');

  // ---- Phase 5: route, patrol post, runsheet flow, lone worker
  r = await d.call('PUT', '/api/routes/new', { name: 'ZZ TEST ROUTE', vehicle: 'Patrol 9', stops: [{ siteId, windowFrom: '00:00', windowTo: '23:59', visits: 1, instructions: 'check gate' }] }); assert(r.status === 200, 'route created'); const routeId = r.body.id;
  r = await d.call('PUT', '/api/positions/' + posId + '/patrol', { routeId, loneMinutes: 30 }); assert(r.status === 200, 'post set to patrol route + 30-min lone-worker check-ins');
  r = await d.call('GET', '/api/sites'); const tsite = r.body.sites.find(s => s.id === siteId); assert(tsite && tsite.positions[0].routeId === routeId && tsite.positions[0].loneMinutes === 30, 'site doc carries route and lone settings');
  // a fresh live shift for the runsheet (the first one is clocked out)
  const live2 = { id: 'zztest-live2', pos: posId, site: siteId, emp: E2.id, s: startNow, e: endNow, brk: 0, pub: true, vac: false, board: false, pto: false, att: '', note: '' };
  const w2 = (await d.call('GET', '/api/weeks/' + wsLive)).body; w2.shifts.push(live2); r = await d.call('PUT', '/api/weeks/' + wsLive, w2); assert(r.status === 200, 'second live shift saved for officer 2');
  r = await o2.call('GET', '/api/officer/shifts/zztest-live2/runsheet'); assert(r.status === 200 && r.body.runsheet && r.body.runsheet.total === 1, 'runsheet created from the route'); const rsId = r.body.runsheet.id;
  r = await o2.call('POST', `/api/officer/runsheets/${rsId}/start`, {}); assert(r.body.status === 'active', 'runsheet started');
  r = await o2.call('POST', `/api/officer/runsheets/${rsId}/position`, { lat: 42.35, lng: -71.05 }); assert(r.status === 200, 'breadcrumb recorded');
  r = await o2.call('POST', `/api/officer/runsheets/${rsId}/arrive`, { stopIndex: 0, lat: 42.36, lng: -71.06 }); assert(r.status === 200 && !r.body.late, 'arrived at stop inside window');
  r = await o2.call('POST', `/api/officer/runsheets/${rsId}/depart`, { stopIndex: 0, note: 'gate secure' }); assert(r.body.done === 1, 'departed stop, visit complete');
  r = await o2.call('POST', `/api/officer/runsheets/${rsId}/end`, { notes: 'quiet night' }); assert(r.body.status === 'done', 'runsheet finished');
  assert(db.prepare("SELECT COUNT(*) c FROM reports WHERE kind='patrol' AND shift_id='zztest-live2'").get().c === 1, 'patrol report generated for the client site');
  r = await d.call('GET', '/api/runsheets/' + rsId); assert(r.body.breadcrumbs.length === 1 && r.body.officer === E2.name, 'dispatch sees runsheet with GPS trail');
  r = await o2.call('POST', '/api/officer/shifts/zztest-live2/clock', { kind: 'in', lat: 42.36, lng: -71.06 }); assert(r.status === 200, 'officer 2 clocked in (lone-worker post)');
  r = await o2.call('GET', '/api/officer/shifts/zztest-live2/lone'); assert(r.body.enabled && r.body.active && !r.body.overdue, 'lone-worker timer running, next due ' + r.body.nextDue);
  db.prepare("UPDATE clockins SET at=? WHERE shift_id='zztest-live2' AND kind='in'").run(new Date(Date.now() - 40 * 60e3).toISOString());
  r = await o2.call('GET', '/api/officer/shifts/zztest-live2/lone'); assert(r.body.overdue, 'check-in shows overdue after 40 minutes');
  require('../server/api'); const p5 = require('../server/phase5'); await p5.tick(); assert(db.prepare("SELECT COUNT(*) c FROM lone_checkins WHERE shift_id='zztest-live2' AND kind='missed'").get().c === 1, 'server raised a missed check-in alert');
  r = await o2.call('POST', '/api/officer/shifts/zztest-live2/checkin', { lat: 42.36, lng: -71.06 }); assert(r.status === 200 && !r.body.overdue, 'officer checked in, timer reset');

  // ---- cleanup
  db.prepare("DELETE FROM shift_requests WHERE shift_id LIKE 'zztest-%'").run();
  db.prepare('DELETE FROM time_off_requests WHERE id=?').run(toId);
  const emp1 = db.prepare('SELECT off_json FROM employees WHERE id=?').get(E1.id); db.prepare('UPDATE employees SET off_json=? WHERE id=?').run(JSON.stringify(JSON.parse(emp1.off_json).filter(o => o.note !== 'vacation')), E1.id);
  for (const t of ['clockins', 'checkpoint_scans', 'lone_checkins', 'alerts', 'reminders']) db.prepare(`DELETE FROM ${t} WHERE shift_id IN ('zztest-open','zztest-e1','zztest-live','zztest-live2')`).run();
  db.prepare("DELETE FROM runsheet_visits WHERE runsheet_id=?").run(rsId); db.prepare('DELETE FROM breadcrumbs WHERE runsheet_id=?').run(rsId); db.prepare('DELETE FROM runsheets WHERE id=?').run(rsId);
  db.prepare("DELETE FROM shifts WHERE id IN ('zztest-open','zztest-e1','zztest-live','zztest-live2')").run();
  db.prepare("DELETE FROM reports WHERE site_id=?").run(siteId); db.prepare('DELETE FROM photos WHERE id=?').run(photoId); try { require('fs').unlinkSync(require('path').join(cfg.root, 'data', 'uploads', photoId + '.png')); } catch (e) {}
  db.prepare('DELETE FROM timesheets WHERE employee_id=? AND ws=?').run(E1.id, wsLive); db.prepare('DELETE FROM invoices WHERE site_id=?').run(siteId); db.prepare("DELETE FROM rates WHERE ref_id=?").run(posId); db.prepare('DELETE FROM holidays').run();
  db.prepare('DELETE FROM routes WHERE id=?').run(routeId); db.prepare('DELETE FROM checkpoints WHERE site_id=?').run(siteId); db.prepare('DELETE FROM tours WHERE site_id=?').run(siteId);
  db.prepare('DELETE FROM client_sites WHERE user_id=?').run(clientUid); db.prepare('DELETE FROM sessions WHERE user_id=?').run(clientUid); db.prepare('DELETE FROM users WHERE id=?').run(clientUid);
  db.prepare('DELETE FROM templates WHERE position_id=?').run(posId); db.prepare('DELETE FROM positions WHERE id=?').run(posId); db.prepare('DELETE FROM sites WHERE id=?').run(siteId);
  db.prepare("DELETE FROM notifications WHERE text LIKE '%ZZ TEST%'").run();
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall phase checks passed; test data removed');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
