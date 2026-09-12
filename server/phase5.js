// Phase 5 — mobile patrol runsheets and lone-worker check-ins.
// A route is an ordered list of stops. A post can carry a route; every shift on that post gets a runsheet.
const mod = function ({ add, err, ok, R, bus, D, T, cfg, notify, distanceMeters }) {
  const { DISPATCH, OFFICER } = R; const db = D.db;
  const cols = db.prepare('PRAGMA table_info(positions)').all().map(c => c.name);
  if (!cols.includes('lone_minutes')) db.exec('ALTER TABLE positions ADD COLUMN lone_minutes INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('route_id')) db.exec('ALTER TABLE positions ADD COLUMN route_id TEXT');
  db.exec(`
  CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT, stops_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, notes TEXT);
  CREATE TABLE IF NOT EXISTS runsheets (id TEXT PRIMARY KEY, route_id TEXT NOT NULL, shift_id TEXT NOT NULL UNIQUE, employee_id TEXT, status TEXT NOT NULL DEFAULT 'planned', started_at TEXT, ended_at TEXT, vehicle TEXT, notes TEXT);
  CREATE TABLE IF NOT EXISTS runsheet_visits (id TEXT PRIMARY KEY, runsheet_id TEXT NOT NULL, stop_index INTEGER NOT NULL, visit_no INTEGER NOT NULL, arrived_at TEXT, departed_at TEXT, lat REAL, lng REAL, distance_m REAL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', UNIQUE(runsheet_id, stop_index, visit_no));
  CREATE TABLE IF NOT EXISTS breadcrumbs (runsheet_id TEXT NOT NULL, at TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS breadcrumbs_rs ON breadcrumbs(runsheet_id, at);
  CREATE TABLE IF NOT EXISTS lone_checkins (id TEXT PRIMARY KEY, shift_id TEXT NOT NULL, employee_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, lat REAL, lng REAL);
  CREATE INDEX IF NOT EXISTS lone_shift ON lone_checkins(shift_id, at);
  `);

  const routeView = r => ({ id: r.id, name: r.name, vehicle: r.vehicle || '', stops: JSON.parse(r.stops_json || '[]').map(s => ({ ...s, site: (D.siteLite(s.siteId) || {}).name, address: (D.siteLite(s.siteId) || {}).address })), active: !!r.active, notes: r.notes || '' });
  add('GET', '/api/routes', DISPATCH, () => ok({ routes: db.prepare('SELECT * FROM routes ORDER BY name').all().map(routeView) }));
  add('PUT', '/api/routes/:id', DISPATCH, ({ user, params, body }) => {
    const id = params.id === 'new' ? D.uid() : params.id; if (!body.name) return err(400, 'Route needs a name');
    const stops = (Array.isArray(body.stops) ? body.stops : []).map(s => ({ siteId: String(s.siteId), checkpointId: s.checkpointId || null, windowFrom: s.windowFrom || '', windowTo: s.windowTo || '', visits: Math.max(1, +s.visits || 1), instructions: (s.instructions || '').slice(0, 400), minutes: +s.minutes || 10 })).filter(s => D.siteLite(s.siteId));
    db.prepare(`INSERT INTO routes(id,name,vehicle,stops_json,active,notes) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,vehicle=excluded.vehicle,stops_json=excluded.stops_json,active=excluded.active,notes=excluded.notes`).run(id, String(body.name).slice(0, 80), (body.vehicle || '').slice(0, 60), JSON.stringify(stops), body.active === false ? 0 : 1, (body.notes || '').slice(0, 500));
    D.audit(user.id, 'route_saved', { id }); bus.emit({ type: 'routes' }); return ok({ id });
  });
  add('DELETE', '/api/routes/:id', DISPATCH, ({ user, params }) => { db.prepare('UPDATE positions SET route_id=NULL WHERE route_id=?').run(params.id); db.prepare('DELETE FROM routes WHERE id=?').run(params.id); D.audit(user.id, 'route_deleted', { id: params.id }); bus.emit({ type: 'routes' }); return ok({ ok: true }); });
  add('PUT', '/api/positions/:id/patrol', DISPATCH, ({ user, params, body }) => { db.prepare('UPDATE positions SET route_id=?, lone_minutes=? WHERE id=?').run(body.routeId || null, Math.max(0, +body.loneMinutes || 0), params.id); D.audit(user.id, 'position_patrol', { id: params.id }); bus.emit({ type: 'sites' }); return ok({ ok: true }); });

  /* ---------- runsheets ---------- */
  function ensureRunsheet(sh) {
    const pos = db.prepare('SELECT route_id FROM positions WHERE id=?').get(sh.pos); if (!pos || !pos.route_id) return null;
    let rs = db.prepare('SELECT * FROM runsheets WHERE shift_id=?').get(sh.id);
    if (!rs) { const route = db.prepare('SELECT * FROM routes WHERE id=?').get(pos.route_id); if (!route) return null; const id = D.uid(); db.prepare('INSERT INTO runsheets(id,route_id,shift_id,employee_id,status,vehicle) VALUES (?,?,?,?,?,?)').run(id, route.id, sh.id, sh.emp, 'planned', route.vehicle);
      JSON.parse(route.stops_json).forEach((s, i) => { for (let v = 1; v <= (s.visits || 1); v++) db.prepare('INSERT OR IGNORE INTO runsheet_visits(id,runsheet_id,stop_index,visit_no,status) VALUES (?,?,?,?,?)').run(D.uid(), id, i, v, 'pending'); });
      rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(id); }
    return rs;
  }
  function runsheetView(rs) {
    const route = routeView(db.prepare('SELECT * FROM routes WHERE id=?').get(rs.route_id)); const visits = db.prepare('SELECT * FROM runsheet_visits WHERE runsheet_id=? ORDER BY stop_index, visit_no').all(rs.id);
    const stops = route.stops.map((s, i) => ({ ...s, index: i, visits: visits.filter(v => v.stop_index === i).map(v => ({ id: v.id, no: v.visit_no, arrivedAt: v.arrived_at, departedAt: v.departed_at, status: v.status, note: v.note, distance: v.distance_m })) }));
    const next = stops.flatMap(s => s.visits.map(v => ({ stop: s, v }))).find(x => x.v.status === 'pending' || (x.v.arrivedAt && !x.v.departedAt));
    return { id: rs.id, shiftId: rs.shift_id, route: { id: route.id, name: route.name, vehicle: rs.vehicle || route.vehicle }, status: rs.status, startedAt: rs.started_at, endedAt: rs.ended_at, notes: rs.notes || '', stops, next: next ? { index: next.stop.index, visit: next.v.no, site: next.stop.site, address: next.stop.address, arrived: !!next.v.arrivedAt } : null, done: visits.filter(v => v.status === 'ok' || v.status === 'late').length, total: visits.length, missed: visits.filter(v => v.status === 'missed').length };
  }
  const myShift = (user, id) => { const sh = D.getShift(id); return sh && String(sh.emp) === String(user.employee_id) ? sh : null; };
  add('GET', '/api/officer/shifts/:id/runsheet', OFFICER, ({ user, params }) => { const sh = myShift(user, params.id); if (!sh) return err(404, 'That shift is not yours'); const rs = ensureRunsheet(sh); return ok({ runsheet: rs ? runsheetView(rs) : null }); });
  add('POST', '/api/officer/runsheets/:id/start', OFFICER, ({ user, params, body }) => { const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs || !myShift(user, rs.shift_id)) return err(404, 'Not your runsheet'); if (rs.status === 'done') return err(400, 'Runsheet already finished'); db.prepare("UPDATE runsheets SET status='active', started_at=COALESCE(started_at,?), vehicle=COALESCE(?,vehicle) WHERE id=?").run(D.now(), body.vehicle || null, rs.id); bus.emit({ type: 'runsheets' }); return ok(runsheetView(db.prepare('SELECT * FROM runsheets WHERE id=?').get(rs.id))); });
  add('POST', '/api/officer/runsheets/:id/arrive', OFFICER, ({ user, params, body }) => {
    const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs || !myShift(user, rs.shift_id)) return err(404, 'Not your runsheet');
    const v = db.prepare("SELECT * FROM runsheet_visits WHERE runsheet_id=? AND stop_index=? AND status='pending' ORDER BY visit_no LIMIT 1").get(rs.id, +body.stopIndex); if (!v) return err(400, 'No pending visit at that stop');
    const route = routeView(db.prepare('SELECT * FROM routes WHERE id=?').get(rs.route_id)); const stop = route.stops[+body.stopIndex]; const site = stop ? D.siteLite(stop.siteId) : null;
    const lat = Number(body.lat), lng = Number(body.lng); let dist = null; if (Number.isFinite(lat) && Number.isFinite(lng) && site && site.lat != null && site.lng != null) dist = Math.round(distanceMeters(lat, lng, site.lat, site.lng));
    const nowL = T.localString(); const late = stop && stop.windowTo && nowL.slice(11, 16) > stop.windowTo && !(stop.windowFrom > stop.windowTo && nowL.slice(11, 16) < stop.windowFrom);
    db.prepare("UPDATE runsheet_visits SET arrived_at=?, lat=?, lng=?, distance_m=?, status=? WHERE id=?").run(D.now(), Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, dist, late ? 'late' : 'ok', v.id);
    if (rs.status !== 'active') db.prepare("UPDATE runsheets SET status='active', started_at=COALESCE(started_at,?) WHERE id=?").run(D.now(), rs.id);
    bus.emit({ type: 'runsheets' }); return ok({ ok: true, late: !!late, distance: dist, runsheet: runsheetView(db.prepare('SELECT * FROM runsheets WHERE id=?').get(rs.id)) });
  });
  add('POST', '/api/officer/runsheets/:id/depart', OFFICER, ({ user, params, body }) => {
    const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs || !myShift(user, rs.shift_id)) return err(404, 'Not your runsheet');
    const v = db.prepare("SELECT * FROM runsheet_visits WHERE runsheet_id=? AND stop_index=? AND arrived_at IS NOT NULL AND departed_at IS NULL ORDER BY visit_no LIMIT 1").get(rs.id, +body.stopIndex); if (!v) return err(400, 'Arrive at the stop first');
    db.prepare('UPDATE runsheet_visits SET departed_at=?, note=? WHERE id=?').run(D.now(), (body.note || '').slice(0, 400), v.id);
    bus.emit({ type: 'runsheets' }); return ok(runsheetView(db.prepare('SELECT * FROM runsheets WHERE id=?').get(rs.id)));
  });
  add('POST', '/api/officer/runsheets/:id/skip', OFFICER, ({ user, params, body }) => { const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs || !myShift(user, rs.shift_id)) return err(404, 'Not your runsheet'); const v = db.prepare("SELECT * FROM runsheet_visits WHERE runsheet_id=? AND stop_index=? AND status='pending' ORDER BY visit_no LIMIT 1").get(rs.id, +body.stopIndex); if (!v) return err(400, 'Nothing to skip'); db.prepare("UPDATE runsheet_visits SET status='skipped', note=? WHERE id=?").run((body.note || 'skipped').slice(0, 400), v.id); bus.emit({ type: 'runsheets' }); return ok(runsheetView(rs)); });
  add('POST', '/api/officer/runsheets/:id/position', OFFICER, ({ user, params, body }) => { const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs || !myShift(user, rs.shift_id)) return err(404, 'Not your runsheet'); const lat = Number(body.lat), lng = Number(body.lng); if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err(400, 'lat/lng required'); db.prepare('INSERT INTO breadcrumbs(runsheet_id,at,lat,lng) VALUES (?,?,?,?)').run(rs.id, D.now(), lat, lng); return ok({ ok: true }); });
  add('POST', '/api/officer/runsheets/:id/end', OFFICER, ({ user, params, body }) => {
    const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs || !myShift(user, rs.shift_id)) return err(404, 'Not your runsheet');
    db.prepare("UPDATE runsheet_visits SET status='missed' WHERE runsheet_id=? AND status='pending'").run(rs.id);
    db.prepare("UPDATE runsheets SET status='done', ended_at=?, notes=? WHERE id=?").run(D.now(), (body.notes || '').slice(0, 1000), rs.id);
    const v = runsheetView(db.prepare('SELECT * FROM runsheets WHERE id=?').get(rs.id)); const sh = D.getShift(rs.shift_id);
    // patrol report per client site, delivered through the Phase 3 reports flow
    for (const stop of v.stops) {
      const lines = stop.visits.map(x => `Visit ${x.no}: ${x.arrivedAt ? 'arrived ' + x.arrivedAt.slice(11, 16) + 'Z' : 'not visited'}${x.departedAt ? ', left ' + x.departedAt.slice(11, 16) + 'Z' : ''} — ${x.status}${x.note ? ' — ' + x.note : ''}`).join('\n');
      db.prepare('INSERT INTO reports(id,kind,shift_id,employee_id,site_id,at,title,fields_json,photos_json,status,flagged) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(D.uid(), 'patrol', rs.shift_id, rs.employee_id, stop.siteId, D.now(), `Patrol visits — ${v.route.name}`, JSON.stringify({ route: v.route.name, vehicle: v.route.vehicle || '', visits: lines, officerNotes: body.notes || '' }), '[]', 'submitted', stop.visits.some(x => x.status === 'missed') ? 1 : 0);
    }
    D.audit(user.id, 'runsheet_done', { id: rs.id, missed: v.missed }); bus.emit({ type: 'runsheets' }); bus.emit({ type: 'reports' });
    return ok(v);
  });
  add('GET', '/api/runsheets', DISPATCH, ({ query }) => {
    const date = query.get('date') || T.localDate(); const rows = db.prepare('SELECT rs.* FROM runsheets rs JOIN shifts sh ON sh.id=rs.shift_id WHERE sh.s>=? AND sh.s<? ORDER BY sh.s').all(date + 'T00:00', T.addDays(date, 1) + 'T00:00');
    return ok({ date, runsheets: rows.map(rs => ({ ...runsheetView(rs), officer: (D.getEmployee(rs.employee_id) || {}).name, shift: D.getShift(rs.shift_id) })) });
  });
  add('GET', '/api/runsheets/:id', DISPATCH, ({ params }) => { const rs = db.prepare('SELECT * FROM runsheets WHERE id=?').get(params.id); if (!rs) return err(404, 'No such runsheet'); return ok({ ...runsheetView(rs), officer: (D.getEmployee(rs.employee_id) || {}).name, breadcrumbs: db.prepare('SELECT at, lat, lng FROM breadcrumbs WHERE runsheet_id=? ORDER BY at').all(rs.id) }); });

  /* ---------- lone worker ---------- */
  function loneStatus(sh) {
    const pos = db.prepare('SELECT lone_minutes FROM positions WHERE id=?').get(sh.pos); const every = pos ? pos.lone_minutes : 0; if (!every) return { enabled: false };
    const clockIn = db.prepare("SELECT at FROM clockins WHERE shift_id=? AND kind='in'").get(sh.id); const out = db.prepare("SELECT at FROM clockins WHERE shift_id=? AND kind='out'").get(sh.id);
    if (!clockIn || out) return { enabled: true, every, active: false };
    const last = db.prepare("SELECT at FROM lone_checkins WHERE shift_id=? AND kind='ok' ORDER BY at DESC LIMIT 1").get(sh.id); const base = last ? last.at : clockIn.at;
    const nextDue = new Date(new Date(base).getTime() + every * 60e3).toISOString(); return { enabled: true, every, active: true, lastAt: last ? last.at : null, nextDue, overdue: nextDue < D.now() };
  }
  add('GET', '/api/officer/shifts/:id/lone', OFFICER, ({ user, params }) => { const sh = myShift(user, params.id); if (!sh) return err(404, 'That shift is not yours'); return ok(loneStatus(sh)); });
  add('POST', '/api/officer/shifts/:id/checkin', OFFICER, ({ user, params, body }) => { const sh = myShift(user, params.id); if (!sh) return err(404, 'That shift is not yours'); const st = loneStatus(sh); if (!st.enabled || !st.active) return err(400, 'No check-in needed right now'); db.prepare('INSERT INTO lone_checkins(id,shift_id,employee_id,at,kind,lat,lng) VALUES (?,?,?,?,?,?,?)').run(D.uid(), sh.id, user.employee_id, D.now(), 'ok', Number(body.lat) || null, Number(body.lng) || null); db.prepare("UPDATE alerts SET resolved_at=? WHERE shift_id=? AND kind='lone' AND resolved_at IS NULL").run(D.now(), sh.id); return ok(loneStatus(sh)); });

  // called from jobs.js once a minute
  mod.tick = async function () {
    const nowL = T.localString(); const grace = cfg.loneGraceMinutes || 5;
    const active = db.prepare("SELECT sh.* FROM shifts sh JOIN positions p ON p.id=sh.position_id WHERE p.lone_minutes>0 AND sh.employee_id IS NOT NULL AND sh.s<=? AND sh.e>? ").all(nowL, nowL);
    for (const r of active) {
      const sh = D.shiftDoc(r); const st = loneStatus(sh); if (!st.active || !st.overdue) continue;
      if (Date.now() - new Date(st.nextDue).getTime() < grace * 60e3) continue;
      const already = db.prepare("SELECT 1 FROM lone_checkins WHERE shift_id=? AND kind='missed' AND at>?").get(sh.id, st.nextDue); if (already) continue;
      db.prepare('INSERT INTO lone_checkins(id,shift_id,employee_id,at,kind) VALUES (?,?,?,?,?)').run(D.uid(), sh.id, sh.emp, D.now(), 'missed');
      const emp = D.getEmployee(sh.emp), site = D.siteLite(sh.site); const text = `⚠️ *Lone-worker check-in missed* — ${emp ? emp.name : ''}${emp && emp.phone ? ' · ' + emp.phone : ''} · ${site ? site.name : ''} · due ${st.nextDue.slice(11, 16)}Z. Call the officer.`;
      db.prepare('INSERT OR REPLACE INTO alerts(id,shift_id,kind,at,sent,detail) VALUES (?,?,?,?,?,?)').run(D.uid(), sh.id, 'lone', D.now(), 0, text);
      if (cfg.alertsEnabled) { await notify.slack(text); await notify.email('Lone-worker check-in missed', text.replace(/\*/g, '')); }
      db.prepare('INSERT INTO notifications(id,scope,at,text,link) VALUES (?,?,?,?,?)').run(D.uid(), 'dispatch', D.now(), text.replace(/\*/g, ''), 'live'); bus.emit({ type: 'notify', scope: 'dispatch' }); bus.emit({ type: 'live' });
    }
    // runsheet stops whose window has passed without a visit
    const rss = db.prepare("SELECT rs.* FROM runsheets rs JOIN shifts sh ON sh.id=rs.shift_id WHERE rs.status='active' AND sh.e>?").all(nowL);
    for (const rs of rss) { const route = db.prepare('SELECT stops_json FROM routes WHERE id=?').get(rs.route_id); if (!route) continue; const stops = JSON.parse(route.stops_json);
      stops.forEach((s, i) => { if (!s.windowTo || s.windowFrom > s.windowTo) return; if (nowL.slice(11, 16) <= s.windowTo) return; const changed = db.prepare("UPDATE runsheet_visits SET status='missed' WHERE runsheet_id=? AND stop_index=? AND status='pending'").run(rs.id, i).changes; if (changed) { const site = D.siteLite(s.siteId); db.prepare('INSERT INTO notifications(id,scope,at,text,link) VALUES (?,?,?,?,?)').run(D.uid(), 'dispatch', D.now(), `Patrol stop missed: ${site ? site.name : s.siteId} (window ended ${s.windowTo})`, 'patrol'); bus.emit({ type: 'runsheets' }); } }); }
  };
  return { ensureRunsheet, runsheetView, loneStatus };
};
module.exports = mod;
