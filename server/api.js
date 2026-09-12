// JSON API used by the dispatch board and the officer app.
const cfg = require('./config');
const D = require('./db');
const auth = require('./auth');
const T = require('./time');
const notify = require('./notify');

class Bus {
  constructor() { this.clients = new Set(); }
  add(res) { this.clients.add(res); res.on('close', () => this.clients.delete(res)); }
  emit(obj) { const line = `event: change\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of this.clients) { try { c.write(line); } catch (e) { this.clients.delete(c); } } }
}
const bus = new Bus();

const err = (status, message) => ({ status, body: { error: message } });
const ok = body => ({ status: 200, body });
const toRad = x => x * Math.PI / 180;
function distanceMeters(a, b, c, d) { const R = 6371000; const dLat = toRad(c - a), dLng = toRad(d - b); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const isDispatch = u => u && (u.role === 'dispatch' || u.role === 'admin');

async function handle(req, ctx) {
  const { method, path, body, user, token } = req;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  /* ---- auth ---- */
  if (path === '/api/me' && method === 'GET') return ok({ user: user ? auth.publicUser(user) : null, config: { lateAfterMinutes: cfg.lateAfterMinutes, geofenceMeters: cfg.geofenceMeters, timeZone: T.TZ } });
  if (path === '/api/auth/login' && method === 'POST') { const r = auth.loginPassword(body.email, body.password, ctx.ua); if (r.error) return err(401, r.error); return { status: 200, body: { user: r.user }, setCookie: r.token }; }
  if (path === '/api/auth/request-code' && method === 'POST') { const r = await auth.requestCode(body.phone); if (r.error) return err(400, r.error); return ok(r); }
  if (path === '/api/auth/verify' && method === 'POST') { const r = auth.verifyCode(body.phone, body.code, ctx.ua); if (r.error) return err(401, r.error); return { status: 200, body: { user: r.user }, setCookie: r.token }; }
  if (path === '/api/auth/logout' && method === 'POST') { auth.destroySession(token); return { status: 200, body: { ok: true }, clearCookie: true }; }
  if (!user) return err(401, 'Sign in first');
  if (path === '/api/me/password' && method === 'POST') { if (!body.password || String(body.password).length < 8) return err(400, 'Use at least 8 characters'); auth.setPassword(user.id, String(body.password)); D.audit(user.id, 'password_changed'); return ok({ ok: true }); }
  if (path === '/api/events' && method === 'GET') return { sse: true };

  /* ---- officer ---- */
  if (seg[1] === 'officer') {
    if (user.role !== 'officer' || !user.employee_id) return err(403, 'Officer login required');
    const empId = user.employee_id;
    if (seg[2] === 'shifts' && seg.length === 3 && method === 'GET') {
      const from = T.addDays(T.localDate(), -1) + 'T00:00', to = T.addDays(T.localDate(), 15) + 'T00:00';
      const rows = D.db.prepare('SELECT * FROM shifts WHERE employee_id=? AND pub=1 AND s>=? AND s<? ORDER BY s').all(empId, from, to);
      const shifts = rows.map(r => {
        const sh = D.shiftDoc(r); const site = D.siteLite(sh.site) || {}; const pos = D.db.prepare('SELECT name, armed, memo FROM positions WHERE id=?').get(sh.pos) || {};
        const clock = {}; for (const c of D.db.prepare('SELECT kind, at, flagged, distance_m FROM clockins WHERE shift_id=? ORDER BY at').all(sh.id)) clock[c.kind] = { at: c.at, flagged: !!c.flagged, distance: c.distance_m };
        return { ...sh, site: { id: site.id, name: site.name, address: site.address, phone: site.phone, lat: site.lat, lng: site.lng, postOrders: site.postOrders }, pos: { name: pos.name, armed: !!pos.armed, memo: pos.memo || '' }, clock };
      });
      return ok({ employee: D.getEmployee(empId), shifts, now: T.localString() });
    }
    if (seg[2] === 'shifts' && seg.length === 5 && method === 'POST') {
      const sh = D.getShift(seg[3]); if (!sh || String(sh.emp) !== String(empId)) return err(404, 'That shift is not yours');
      if (seg[4] === 'ack') { D.db.prepare('UPDATE shifts SET ack_at=? WHERE id=?').run(D.now(), sh.id); D.audit(user.id, 'ack', { shift: sh.id }); bus.emit({ type: 'week', ws: T.sundayOf(sh.s.slice(0, 10)) }); return ok({ ok: true, ack: D.now() }); }
      if (seg[4] === 'clock') {
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
        if (kind === 'in') D.db.prepare("UPDATE alerts SET resolved_at=? WHERE shift_id=? AND resolved_at IS NULL").run(D.now(), sh.id);
        D.audit(user.id, 'clock_' + kind, { shift: sh.id, dist, flagged });
        bus.emit({ type: 'week', ws: T.sundayOf(sh.s.slice(0, 10)) }); bus.emit({ type: 'live' });
        return ok({ ok: true, at: D.now(), distance: dist, flagged: !!flagged, note });
      }
    }
    return err(404, 'Not found');
  }

  /* ---- dispatch ---- */
  if (!isDispatch(user)) return err(403, 'Dispatch login required');
  if (seg[1] === 'employees' && method === 'GET') return ok({ employees: D.listEmployees() });
  if (seg[1] === 'employees' && seg[2] && method === 'PUT') { const d = body; d.id = seg[2]; D.putEmployee(d); D.audit(user.id, 'employee_saved', { id: d.id, name: d.name }); bus.emit({ type: 'employees' }); return ok({ ok: true }); }
  if (seg[1] === 'sites' && method === 'GET') return ok({ sites: D.listSites() });
  if (seg[1] === 'sites' && seg[2] && method === 'PUT') { const d = body; d.id = seg[2]; if (!d.name) return err(400, 'Site needs a name'); D.putSite(d); D.audit(user.id, 'site_saved', { id: d.id, name: d.name }); bus.emit({ type: 'sites' }); return ok({ ok: true }); }
  if (seg[1] === 'weeks' && seg[2] && method === 'GET') return ok(D.weekDoc(seg[2]));
  if (seg[1] === 'weeks' && seg[2] && method === 'PUT') { D.putWeek(seg[2], body, user.id); D.audit(user.id, 'week_saved', { ws: seg[2], shifts: (body.shifts || []).length }); bus.emit({ type: 'week', ws: seg[2], by: user.id }); return ok({ ok: true }); }
  if (path === '/api/live' && method === 'GET') {
    const nowL = T.localString(); const from = T.localString(new Date(Date.now() - 14 * 3600e3)), to = T.localString(new Date(Date.now() + 4 * 3600e3));
    const rows = D.db.prepare('SELECT sh.*, p.name AS pos_name, s.name AS site_name FROM shifts sh JOIN positions p ON p.id=sh.position_id JOIN sites s ON s.id=sh.site_id WHERE sh.s>=? AND sh.s<=? AND sh.pto=0 ORDER BY sh.s').all(from, to);
    const out = rows.map(r => {
      const clock = {}; for (const c of D.db.prepare('SELECT kind, at, flagged, distance_m, note FROM clockins WHERE shift_id=? ORDER BY at').all(r.id)) clock[c.kind] = { at: c.at, flagged: !!c.flagged, distance: c.distance_m, note: c.note };
      const emp = r.employee_id ? D.getEmployee(r.employee_id) : null;
      let state = 'upcoming';
      if (!emp) state = 'open';
      else if (clock.out) state = 'done';
      else if (clock.in) state = 'on_post';
      else if (r.s <= nowL && r.e > nowL) state = T.minutesSince(r.s) >= (cfg.lateAfterMinutes || 10) ? 'late' : 'due';
      else if (r.e <= nowL) state = 'no_show';
      return { id: r.id, s: r.s, e: r.e, site: r.site_name, siteId: r.site_id, pos: r.pos_name, emp: emp ? { id: emp.id, name: emp.name, phone: emp.phone } : null, ack: r.ack_at, clock, state, pub: !!r.pub };
    });
    return ok({ now: nowL, shifts: out });
  }
  if (path === '/api/alerts' && method === 'GET') {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    return ok({ alerts: D.db.prepare('SELECT a.*, sh.s, sh.e FROM alerts a JOIN shifts sh ON sh.id=a.shift_id WHERE a.at>=? ORDER BY a.at DESC').all(since) });
  }
  if (path === '/api/users' && method === 'GET') { if (user.role !== 'admin') return err(403, 'Admin only'); return ok({ users: auth.listUsers() }); }
  if (path === '/api/users' && method === 'POST') {
    if (user.role !== 'admin') return err(403, 'Admin only');
    if (!body.email || !body.password || !body.name) return err(400, 'Name, email and password are required');
    try { const id = auth.createDispatchUser(body); D.audit(user.id, 'user_created', { id, email: body.email, role: body.role }); return ok({ id }); } catch (e) { return err(400, 'That email already has a login'); }
  }
  if (path === '/api/test-alert' && method === 'POST') { const r1 = await notify.slack('Guard Pro test alert — the dispatch alert channel is connected.'); const r2 = await notify.email('Guard Pro test alert', 'The dispatch alert email is connected.'); return ok({ slack: r1, email: r2 }); }
  return err(404, 'Not found');
}

module.exports = { handle, bus };
