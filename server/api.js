// JSON API used by the dispatch board, the officer app and the client portal.
// Core routes live here; each later phase adds its own module.
const cfg = require('./config');
const D = require('./db');
const auth = require('./auth');
const T = require('./time');
const notify = require('./notify');
const R = require('./router');
const { add, err, ok, DISPATCH, ADMIN, OFFICER } = R;

class Bus {
  constructor() { this.clients = new Set(); }
  add(res) { this.clients.add(res); res.on('close', () => this.clients.delete(res)); }
  emit(obj) { const line = `event: change\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of this.clients) { try { c.write(line); } catch (e) { this.clients.delete(c); } } }
}
const bus = new Bus();

const toRad = x => x * Math.PI / 180;
function distanceMeters(a, b, c, d) { const Rm = 6371000; const dLat = toRad(c - a), dLng = toRad(d - b); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2; return 2 * Rm * Math.asin(Math.sqrt(h)); }
function clockOf(shiftId) { const clock = {}; for (const c of D.db.prepare('SELECT kind, at, flagged, distance_m, note FROM clockins WHERE shift_id=? ORDER BY at').all(shiftId)) clock[c.kind] = { at: c.at, flagged: !!c.flagged, distance: c.distance_m, note: c.note }; return clock; }
function officerShiftView(r) {
  const sh = D.shiftDoc(r); const site = D.siteLite(sh.site) || {}; const pos = D.db.prepare('SELECT name, armed, memo, lone_minutes, route_id FROM positions WHERE id=?').get(sh.pos) || {};
  return { ...sh, siteId: sh.site, posId: sh.pos, site: { id: site.id, name: site.name, address: site.address, phone: site.phone, lat: site.lat, lng: site.lng, postOrders: site.postOrders }, pos: { id: sh.pos, name: pos.name, armed: !!pos.armed, memo: pos.memo || '', loneMinutes: pos.lone_minutes || 0, routeId: pos.route_id || null }, clock: clockOf(sh.id) };
}

/* ---- auth ---- */
add('GET', '/api/me', null, ({ user }) => ok({ user: user ? auth.publicUser(user) : null, config: { lateAfterMinutes: cfg.lateAfterMinutes, geofenceMeters: cfg.geofenceMeters, timeZone: T.TZ, company: cfg.company || 'Guard Pro' } }));
add('POST', '/api/auth/login', null, ({ body }, ctx) => { const r = auth.loginPassword(body.email, body.password, ctx.ua); if (r.error) return err(401, r.error); return { status: 200, body: { user: r.user }, setCookie: r.token }; });
add('POST', '/api/auth/request-code', null, async ({ body }) => { const r = await auth.requestCode(body.phone); if (r.error) return err(400, r.error); return ok(r); });
add('POST', '/api/auth/verify', null, ({ body }, ctx) => { const r = auth.verifyCode(body.phone, body.code, ctx.ua); if (r.error) return err(401, r.error); return { status: 200, body: { user: r.user }, setCookie: r.token }; });
add('POST', '/api/auth/logout', null, ({ token }) => { auth.destroySession(token); return { status: 200, body: { ok: true }, clearCookie: true }; });
add('POST', '/api/me/password', R.ANY, ({ user, body }) => { if (!body.password || String(body.password).length < 8) return err(400, 'Use at least 8 characters'); auth.setPassword(user.id, String(body.password)); D.audit(user.id, 'password_changed'); return ok({ ok: true }); });
add('GET', '/api/events', [...R.ANY, 'client'], () => ({ sse: true }));

/* ---- officer: shifts, acknowledge, clock ---- */
add('GET', '/api/officer/shifts', OFFICER, ({ user }) => {
  const empId = user.employee_id; const from = T.addDays(T.localDate(), -1) + 'T00:00', to = T.addDays(T.localDate(), 15) + 'T00:00';
  const rows = D.db.prepare('SELECT * FROM shifts WHERE employee_id=? AND pub=1 AND s>=? AND s<? ORDER BY s').all(empId, from, to);
  return ok({ employee: D.getEmployee(empId), shifts: rows.map(r => officerShiftView(r)), now: T.localString() });
});
add('POST', '/api/officer/shifts/:id/ack', OFFICER, ({ user, params }) => {
  const sh = D.getShift(params.id); if (!sh || String(sh.emp) !== String(user.employee_id)) return err(404, 'That shift is not yours');
  D.db.prepare('UPDATE shifts SET ack_at=? WHERE id=?').run(D.now(), sh.id); D.audit(user.id, 'ack', { shift: sh.id }); bus.emit({ type: 'week', ws: T.sundayOf(sh.s.slice(0, 10)) });
  return ok({ ok: true, ack: D.now() });
});
add('POST', '/api/officer/shifts/:id/clock', OFFICER, ({ user, params, body }) => {
  const empId = user.employee_id; const sh = D.getShift(params.id); if (!sh || String(sh.emp) !== String(empId)) return err(404, 'That shift is not yours');
  const kind = body.kind === 'out' ? 'out' : 'in';
  const mins = T.minutesSince(sh.s), minsEnd = T.minutesSince(sh.e);
  if (kind === 'in' && mins < -90) return err(400, 'Too early — clock-in opens 90 minutes before the shift');
  if (kind === 'in' && minsEnd > 0) return err(400, 'This shift has already ended');
  if (D.db.prepare('SELECT 1 FROM clockins WHERE shift_id=? AND kind=?').get(sh.id, kind)) return err(400, `Already clocked ${kind}`);
  if (kind === 'out' && !D.db.prepare("SELECT 1 FROM clockins WHERE shift_id=? AND kind='in'").get(sh.id)) return err(400, 'Clock in first');
  const site = D.siteLite(sh.site); let dist = null, flagged = 0, note = '';
  const lat = Number(body.lat), lng = Number(body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && site && site.lat != null && site.lng != null) {
    dist = Math.round(distanceMeters(lat, lng, site.lat, site.lng)); const radius = site.radius || cfg.geofenceMeters || 250;
    if (dist > radius) { flagged = 1; note = `${dist} m from site (limit ${radius} m)`; }
  } else if (!Number.isFinite(lat)) { flagged = kind === 'in' ? 1 : 0; note = 'no location shared'; }
  D.db.prepare('INSERT INTO clockins(id,shift_id,employee_id,kind,at,lat,lng,accuracy_m,distance_m,flagged,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(D.uid(), sh.id, empId, kind, D.now(), Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, Number(body.accuracy) || null, dist, flagged, note);
  if (kind === 'in') D.db.prepare('UPDATE alerts SET resolved_at=? WHERE shift_id=? AND resolved_at IS NULL').run(D.now(), sh.id);
  D.audit(user.id, 'clock_' + kind, { shift: sh.id, dist, flagged });
  bus.emit({ type: 'week', ws: T.sundayOf(sh.s.slice(0, 10)) }); bus.emit({ type: 'live' });
  return ok({ ok: true, at: D.now(), distance: dist, flagged: !!flagged, note });
});

/* ---- dispatch: roster, weeks, live ---- */
add('GET', '/api/employees', DISPATCH, () => ok({ employees: D.listEmployees() }));
add('PUT', '/api/employees/:id', DISPATCH, ({ user, params, body }) => { const d = body; d.id = params.id; D.putEmployee(d); D.audit(user.id, 'employee_saved', { id: d.id, name: d.name }); bus.emit({ type: 'employees' }); return ok({ ok: true }); });
add('GET', '/api/sites', DISPATCH, () => ok({ sites: D.listSites() }));
add('PUT', '/api/sites/:id', DISPATCH, ({ user, params, body }) => { const d = body; d.id = params.id; if (!d.name) return err(400, 'Site needs a name'); D.putSite(d); D.audit(user.id, 'site_saved', { id: d.id, name: d.name }); bus.emit({ type: 'sites' }); return ok({ ok: true }); });
add('GET', '/api/weeks/:ws', DISPATCH, ({ params }) => ok(D.weekDoc(params.ws)));
add('PUT', '/api/weeks/:ws', DISPATCH, ({ user, params, body }) => { D.putWeek(params.ws, body, user.id); D.audit(user.id, 'week_saved', { ws: params.ws, shifts: (body.shifts || []).length }); bus.emit({ type: 'week', ws: params.ws, by: user.id }); return ok({ ok: true }); });
add('GET', '/api/live', DISPATCH, () => {
  const nowL = T.localString(); const from = T.localString(new Date(Date.now() - 14 * 3600e3)), to = T.localString(new Date(Date.now() + 4 * 3600e3));
  const rows = D.db.prepare('SELECT sh.*, p.name AS pos_name, s.name AS site_name FROM shifts sh JOIN positions p ON p.id=sh.position_id JOIN sites s ON s.id=sh.site_id WHERE sh.s>=? AND sh.s<=? AND sh.pto=0 ORDER BY sh.s').all(from, to);
  const out = rows.map(r => {
    const clock = clockOf(r.id); const emp = r.employee_id ? D.getEmployee(r.employee_id) : null;
    let state = 'upcoming';
    if (!emp) state = 'open'; else if (clock.out) state = 'done'; else if (clock.in) state = 'on_post';
    else if (r.s <= nowL && r.e > nowL) state = T.minutesSince(r.s) >= (cfg.lateAfterMinutes || 10) ? 'late' : 'due';
    else if (r.e <= nowL) state = 'no_show';
    return { id: r.id, s: r.s, e: r.e, site: r.site_name, siteId: r.site_id, pos: r.pos_name, emp: emp ? { id: emp.id, name: emp.name, phone: emp.phone } : null, ack: r.ack_at, clock, state, pub: !!r.pub };
  });
  return ok({ now: nowL, shifts: out });
});
add('GET', '/api/alerts', DISPATCH, () => ok({ alerts: D.db.prepare('SELECT a.*, sh.s, sh.e FROM alerts a JOIN shifts sh ON sh.id=a.shift_id WHERE a.at>=? ORDER BY a.at DESC').all(new Date(Date.now() - 7 * 864e5).toISOString()) }));
add('GET', '/api/users', ADMIN, () => ok({ users: auth.listUsers() }));
add('POST', '/api/users', ADMIN, ({ user, body }) => {
  if (!body.email || !body.password || !body.name) return err(400, 'Name, email and password are required');
  try { const id = auth.createDispatchUser(body); D.audit(user.id, 'user_created', { id, email: body.email, role: body.role }); return ok({ id }); } catch (e) { return err(400, 'That email already has a login'); }
});
add('POST', '/api/test-alert', DISPATCH, async () => ok({ slack: await notify.slack('Guard Pro test alert — the dispatch alert channel is connected.'), email: await notify.email('Guard Pro test alert', 'The dispatch alert email is connected.') }));

// later phases register their routes here
const shared = { add, err, ok, R, bus, D, T, cfg, notify, officerShiftView, clockOf, distanceMeters };
require('./phase2')(shared);
require('./phase3')(shared);
require('./phase4')(shared);
require('./phase5')(shared);

async function handle(req, ctx) { return R.dispatch(req, ctx); }
module.exports = { handle, bus };
