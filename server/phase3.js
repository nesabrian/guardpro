// Phase 3 — reports and tours: daily activity and incident reports with photos, site checkpoints
// scanned from the officer app, tour compliance, and a read-only client portal.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = function ({ add, err, ok, R, bus, D, T, cfg, notify, officerShiftView, clockOf, distanceMeters }) {
  const { DISPATCH, OFFICER, CLIENT } = R; const db = D.db;
  const UPLOADS = path.join(cfg.root, 'data', 'uploads'); fs.mkdirSync(UPLOADS, { recursive: true });

  db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, shift_id TEXT, employee_id TEXT, site_id TEXT NOT NULL, at TEXT NOT NULL,
    title TEXT, fields_json TEXT NOT NULL DEFAULT '{}', photos_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'submitted',
    reviewed_by TEXT, reviewed_at TEXT, sent_at TEXT, sent_to TEXT, flagged INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS reports_site ON reports(site_id, at);
  CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, employee_id TEXT, site_id TEXT, at TEXT NOT NULL, name TEXT, type TEXT, bytes INTEGER);
  CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, lat REAL, lng REAL, sort INTEGER NOT NULL DEFAULT 0, instructions TEXT);
  CREATE INDEX IF NOT EXISTS checkpoints_site ON checkpoints(site_id);
  CREATE TABLE IF NOT EXISTS tours (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, checkpoint_ids_json TEXT NOT NULL DEFAULT '[]', per_shift INTEGER NOT NULL DEFAULT 1, interval_minutes INTEGER);
  CREATE TABLE IF NOT EXISTS checkpoint_scans (id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, shift_id TEXT, employee_id TEXT NOT NULL, at TEXT NOT NULL, lat REAL, lng REAL, method TEXT, distance_m REAL, note TEXT);
  CREATE INDEX IF NOT EXISTS scans_shift ON checkpoint_scans(shift_id);
  CREATE TABLE IF NOT EXISTS client_sites (user_id TEXT NOT NULL, site_id TEXT NOT NULL, PRIMARY KEY(user_id, site_id));
  `);

  const reportView = r => ({ id: r.id, kind: r.kind, shiftId: r.shift_id, employeeId: r.employee_id, employee: r.employee_id ? (D.getEmployee(r.employee_id) || {}).name : '', siteId: r.site_id, site: (D.siteLite(r.site_id) || {}).name,
    at: r.at, title: r.title, fields: JSON.parse(r.fields_json || '{}'), photos: JSON.parse(r.photos_json || '[]'), status: r.status, reviewedAt: r.reviewed_at, sentAt: r.sent_at, sentTo: r.sent_to, flagged: !!r.flagged });
  const newCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  function clientSiteIds(user) { return db.prepare('SELECT site_id FROM client_sites WHERE user_id=?').all(user.id).map(r => r.site_id); }

  /* ---------- photos (JSON upload, base64) ---------- */
  add('POST', '/api/officer/photos', OFFICER, ({ user, body }) => {
    const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(String(body.data || '')); if (!m) return err(400, 'Send a JPEG, PNG or WebP image');
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 6e6) return err(400, 'Photo is too large (6 MB max)');
    const id = D.uid(); const ext = m[2] === 'jpeg' ? 'jpg' : m[2]; fs.writeFileSync(path.join(UPLOADS, id + '.' + ext), buf);
    db.prepare('INSERT INTO photos(id,employee_id,site_id,at,name,type,bytes) VALUES (?,?,?,?,?,?,?)').run(id, user.employee_id, body.siteId ? String(body.siteId) : null, D.now(), (body.name || '').slice(0, 120), m[1], buf.length);
    return ok({ id, url: '/api/photos/' + id });
  });
  add('GET', '/api/photos/:id', [...R.ANY, 'client'], ({ user, params }) => {
    const p = db.prepare('SELECT * FROM photos WHERE id=?').get(params.id); if (!p) return err(404, 'No such photo');
    if (user.role === 'officer' && p.employee_id !== user.employee_id) return err(403, 'Not your photo');
    if (user.role === 'client' && !clientSiteIds(user).includes(p.site_id)) return err(403, 'Not your site');
    const ext = p.type === 'image/jpeg' ? 'jpg' : p.type.split('/')[1]; return { file: path.join(UPLOADS, p.id + '.' + ext), type: p.type };
  });

  /* ---------- officer: reports ---------- */
  add('POST', '/api/officer/reports', OFFICER, ({ user, body }) => {
    const kind = ['daily', 'incident'].includes(body.kind) ? body.kind : null; if (!kind) return err(400, 'Report type must be daily or incident');
    const sh = body.shiftId ? D.getShift(body.shiftId) : null; if (body.shiftId && (!sh || String(sh.emp) !== String(user.employee_id))) return err(400, 'That shift is not yours');
    const siteId = sh ? sh.site : String(body.siteId || ''); if (!D.siteLite(siteId)) return err(400, 'Pick a site');
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
    if (kind === 'incident' && !(fields.description || '').trim()) return err(400, 'Describe what happened');
    const photos = (Array.isArray(body.photos) ? body.photos : []).map(String).filter(id => db.prepare('SELECT 1 FROM photos WHERE id=? AND employee_id=?').get(id, user.employee_id)).slice(0, 12);
    const id = D.uid(); const title = (body.title || (kind === 'incident' ? 'Incident: ' + (fields.type || 'general') : 'Daily activity report')).slice(0, 140);
    const flagged = kind === 'incident' && ['police', 'fire', 'medical', 'injury', 'assault', 'theft', 'weapon'].some(w => JSON.stringify(fields).toLowerCase().includes(w)) ? 1 : 0;
    db.prepare('INSERT INTO reports(id,kind,shift_id,employee_id,site_id,at,title,fields_json,photos_json,status,flagged) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, kind, sh ? sh.id : null, user.employee_id, siteId, D.now(), title, JSON.stringify(fields), JSON.stringify(photos), 'submitted', flagged);
    D.audit(user.id, 'report_' + kind, { id, site: siteId });
    const site = D.siteLite(siteId); const emp = D.getEmployee(user.employee_id);
    db.prepare('INSERT INTO notifications(id,scope,at,text,link) VALUES (?,?,?,?,?)').run(D.uid(), 'dispatch', D.now(), `${kind === 'incident' ? (flagged ? '🚨 ' : '') + 'Incident report' : 'Daily report'} from ${emp ? emp.name : 'officer'} at ${site ? site.name : siteId}: ${title}`, 'reports');
    if (kind === 'incident') notify.slack(`${flagged ? '🚨' : '📝'} *Incident report* — ${site ? site.name : siteId} · ${emp ? emp.name : ''} · ${title}\n${(fields.description || '').slice(0, 400)}`);
    bus.emit({ type: 'reports' }); bus.emit({ type: 'notify', scope: 'dispatch' });
    return ok({ id });
  });
  add('GET', '/api/officer/reports', OFFICER, ({ user }) => ok({ reports: db.prepare('SELECT * FROM reports WHERE employee_id=? ORDER BY at DESC LIMIT 40').all(user.employee_id).map(reportView) }));

  /* ---------- officer: checkpoints and scans ---------- */
  function siteCheckpoints(siteId) { return db.prepare('SELECT * FROM checkpoints WHERE site_id=? ORDER BY sort, name').all(siteId); }
  function siteTours(siteId) { return db.prepare('SELECT * FROM tours WHERE site_id=?').all(siteId).map(t => ({ id: t.id, name: t.name, checkpointIds: JSON.parse(t.checkpoint_ids_json || '[]'), perShift: t.per_shift, intervalMinutes: t.interval_minutes })); }
  function shiftScanSummary(sh) {
    const cps = siteCheckpoints(sh.site); const tours = siteTours(sh.site); const scans = db.prepare('SELECT * FROM checkpoint_scans WHERE shift_id=? ORDER BY at').all(sh.id);
    const byCp = {}; for (const s of scans) byCp[s.checkpoint_id] = (byCp[s.checkpoint_id] || 0) + 1;
    const expected = tours.reduce((n, t) => n + t.checkpointIds.length * (t.perShift || 1), 0);
    return { checkpoints: cps.map(c => ({ id: c.id, name: c.name, code: c.code, instructions: c.instructions || '', scans: byCp[c.id] || 0, lat: c.lat, lng: c.lng })), tours, expected, done: scans.length, scans: scans.map(s => ({ checkpointId: s.checkpoint_id, at: s.at, method: s.method, distance: s.distance_m })) };
  }
  add('GET', '/api/officer/shifts/:id/checkpoints', OFFICER, ({ user, params }) => { const sh = D.getShift(params.id); if (!sh || String(sh.emp) !== String(user.employee_id)) return err(404, 'That shift is not yours'); return ok(shiftScanSummary(sh)); });
  add('POST', '/api/officer/scan', OFFICER, ({ user, body }) => {
    const sh = D.getShift(body.shiftId); if (!sh || String(sh.emp) !== String(user.employee_id)) return err(404, 'That shift is not yours');
    if (!clockOf(sh.id).in) return err(400, 'Clock in before scanning checkpoints');
    const code = String(body.code || '').trim().toUpperCase().replace(/^GP:/, '');
    const cp = body.checkpointId ? db.prepare('SELECT * FROM checkpoints WHERE id=?').get(String(body.checkpointId)) : db.prepare('SELECT * FROM checkpoints WHERE code=?').get(code);
    if (!cp) return err(404, 'Checkpoint code not recognised');
    if (cp.site_id !== sh.site) return err(400, 'That checkpoint belongs to a different site');
    const last = db.prepare('SELECT at FROM checkpoint_scans WHERE checkpoint_id=? AND shift_id=? ORDER BY at DESC LIMIT 1').get(cp.id, sh.id);
    if (last && Date.now() - new Date(last.at).getTime() < 60e3) return err(400, 'Already scanned a moment ago');
    const lat = Number(body.lat), lng = Number(body.lng); let dist = null;
    if (Number.isFinite(lat) && Number.isFinite(lng) && cp.lat != null && cp.lng != null) dist = Math.round(distanceMeters(lat, lng, cp.lat, cp.lng));
    const method = body.checkpointId ? 'manual' : (body.method === 'qr' ? 'qr' : body.method === 'nfc' ? 'nfc' : 'code');
    db.prepare('INSERT INTO checkpoint_scans(id,checkpoint_id,shift_id,employee_id,at,lat,lng,method,distance_m,note) VALUES (?,?,?,?,?,?,?,?,?,?)').run(D.uid(), cp.id, sh.id, user.employee_id, D.now(), Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, method, dist, (body.note || '').slice(0, 300));
    bus.emit({ type: 'scans', shift: sh.id });
    return ok({ ok: true, checkpoint: cp.name, instructions: cp.instructions || '', distance: dist, summary: shiftScanSummary(sh) });
  });

  /* ---------- dispatch: reports ---------- */
  add('GET', '/api/reports', DISPATCH, ({ query }) => {
    const days = +query.get('days') || 14; const since = new Date(Date.now() - days * 864e5).toISOString();
    let sql = 'SELECT * FROM reports WHERE at>=?'; const args = [since];
    if (query.get('status')) { sql += ' AND status=?'; args.push(query.get('status')); }
    if (query.get('site')) { sql += ' AND site_id=?'; args.push(query.get('site')); }
    if (query.get('kind')) { sql += ' AND kind=?'; args.push(query.get('kind')); }
    return ok({ reports: db.prepare(sql + ' ORDER BY at DESC LIMIT 300').all(...args).map(reportView), unreviewed: db.prepare("SELECT COUNT(*) c FROM reports WHERE status='submitted'").get().c });
  });
  add('GET', '/api/reports/:id', DISPATCH, ({ params }) => { const r = db.prepare('SELECT * FROM reports WHERE id=?').get(params.id); if (!r) return err(404, 'No such report'); return ok(reportView(r)); });
  add('POST', '/api/reports/:id/review', DISPATCH, ({ user, params }) => { db.prepare("UPDATE reports SET status=CASE WHEN status='submitted' THEN 'reviewed' ELSE status END, reviewed_by=?, reviewed_at=? WHERE id=?").run(user.id, D.now(), params.id); bus.emit({ type: 'reports' }); return ok({ ok: true }); });
  add('POST', '/api/reports/:id/send', DISPATCH, async ({ user, params, body }) => {
    const r = db.prepare('SELECT * FROM reports WHERE id=?').get(params.id); if (!r) return err(404, 'No such report');
    const v = reportView(r); const site = D.siteLite(r.site_id) || {}; const to = (body.to && body.to.length ? body.to : [site.email]).filter(Boolean);
    if (!to.length) return err(400, 'The site has no email on file — enter one');
    const text = `${v.title}\n${v.site} · ${v.employee} · ${v.at.slice(0, 16).replace('T', ' ')}\n\n` + Object.entries(v.fields).map(([k, val]) => `${k}: ${val}`).join('\n') + (v.photos.length ? `\n\n${v.photos.length} photo(s) attached in the Guard Pro portal.` : '') + `\n\nSent by ${cfg.company || 'Guard Pro'} dispatch.`;
    const sent = await notify.email(`${v.kind === 'incident' ? 'Incident report' : 'Daily activity report'} — ${v.site}`, text, to);
    db.prepare("UPDATE reports SET status='sent', sent_at=?, sent_to=?, reviewed_by=COALESCE(reviewed_by,?), reviewed_at=COALESCE(reviewed_at,?) WHERE id=?").run(D.now(), to.join(', '), user.id, D.now(), r.id);
    D.audit(user.id, 'report_sent', { id: r.id, to }); bus.emit({ type: 'reports' });
    return ok({ ok: true, delivered: sent, to, note: sent ? '' : 'Email is not configured on this server yet; the report is marked sent and visible in the client portal.' });
  });

  /* ---------- dispatch: checkpoints, tours, compliance ---------- */
  add('GET', '/api/sites/:id/checkpoints', DISPATCH, ({ params }) => ok({ checkpoints: siteCheckpoints(params.id), tours: siteTours(params.id) }));
  add('PUT', '/api/sites/:id/checkpoints', DISPATCH, ({ user, params, body }) => {
    const siteId = params.id; const keep = new Set();
    (Array.isArray(body.checkpoints) ? body.checkpoints : []).forEach((c, i) => {
      const id = c.id || D.uid(); keep.add(id); const code = (c.code || newCode()).toUpperCase();
      db.prepare(`INSERT INTO checkpoints(id,site_id,name,code,lat,lng,sort,instructions) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,lat=excluded.lat,lng=excluded.lng,sort=excluded.sort,instructions=excluded.instructions`)
        .run(id, siteId, String(c.name || 'Checkpoint').slice(0, 80), code, c.lat == null || c.lat === '' ? null : +c.lat, c.lng == null || c.lng === '' ? null : +c.lng, i, (c.instructions || '').slice(0, 500));
    });
    for (const o of db.prepare('SELECT id FROM checkpoints WHERE site_id=?').all(siteId)) if (!keep.has(o.id)) db.prepare('DELETE FROM checkpoints WHERE id=?').run(o.id);
    const keepT = new Set();
    (Array.isArray(body.tours) ? body.tours : []).forEach(t => {
      const id = t.id || D.uid(); keepT.add(id);
      db.prepare(`INSERT INTO tours(id,site_id,name,checkpoint_ids_json,per_shift,interval_minutes) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,checkpoint_ids_json=excluded.checkpoint_ids_json,per_shift=excluded.per_shift,interval_minutes=excluded.interval_minutes`)
        .run(id, siteId, String(t.name || 'Tour').slice(0, 80), JSON.stringify((t.checkpointIds || []).filter(x => keep.has(x))), Math.max(1, +t.perShift || 1), t.intervalMinutes ? +t.intervalMinutes : null);
    });
    for (const o of db.prepare('SELECT id FROM tours WHERE site_id=?').all(siteId)) if (!keepT.has(o.id)) db.prepare('DELETE FROM tours WHERE id=?').run(o.id);
    D.audit(user.id, 'checkpoints_saved', { site: siteId }); bus.emit({ type: 'sites' });
    return ok({ checkpoints: siteCheckpoints(siteId), tours: siteTours(siteId) });
  });
  add('GET', '/api/tours/compliance', DISPATCH, ({ query }) => {
    const ws = query.get('ws') || T.sundayOf(T.localDate()); const nowL = T.localString();
    const rows = db.prepare('SELECT sh.* FROM shifts sh WHERE sh.ws=? AND sh.s<=? AND sh.employee_id IS NOT NULL AND sh.pto=0 ORDER BY sh.s').all(ws, nowL);
    const out = [];
    for (const r of rows) { const tours = siteTours(r.site_id); if (!tours.length) continue; const sum = shiftScanSummary(D.shiftDoc(r)); out.push({ shiftId: r.id, s: r.s, e: r.e, site: (D.siteLite(r.site_id) || {}).name, employee: (D.getEmployee(r.employee_id) || {}).name, expected: sum.expected, done: sum.done, complete: sum.done >= sum.expected, ended: r.e <= nowL }); }
    return ok({ ws, shifts: out });
  });
  add('GET', '/api/shifts/:id/scans', DISPATCH, ({ params }) => { const sh = D.getShift(params.id); if (!sh) return err(404, 'No such shift'); return ok(shiftScanSummary(sh)); });

  /* ---------- client users (created by dispatch) and portal ---------- */
  add('GET', '/api/clients', DISPATCH, () => ok({ clients: db.prepare("SELECT id,name,email,created_at,last_login_at FROM users WHERE role='client' ORDER BY name").all().map(u => ({ ...u, siteIds: db.prepare('SELECT site_id FROM client_sites WHERE user_id=?').all(u.id).map(r => r.site_id) })) }));
  add('POST', '/api/clients', DISPATCH, ({ user, body }) => {
    const email = String(body.email || '').toLowerCase().trim(); if (!email.includes('@') || !body.name) return err(400, 'Name and email are required');
    const siteIds = (body.siteIds || []).map(String).filter(id => D.siteLite(id)); if (!siteIds.length) return err(400, 'Pick at least one site');
    let u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (u && u.role !== 'client') return err(400, 'That email belongs to a staff login');
    if (!u) { u = { id: D.uid() }; db.prepare('INSERT INTO users(id,role,name,email,phone,pass_hash,employee_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(u.id, 'client', String(body.name).slice(0, 120), email, null, null, null, D.now()); }
    db.prepare('DELETE FROM client_sites WHERE user_id=?').run(u.id); for (const s of siteIds) db.prepare('INSERT INTO client_sites(user_id,site_id) VALUES (?,?)').run(u.id, s);
    D.audit(user.id, 'client_saved', { id: u.id, email, siteIds }); return ok({ id: u.id });
  });
  add('DELETE', '/api/clients/:id', DISPATCH, ({ user, params }) => { db.prepare("DELETE FROM client_sites WHERE user_id=?").run(params.id); db.prepare("DELETE FROM sessions WHERE user_id=?").run(params.id); db.prepare("DELETE FROM users WHERE id=? AND role='client'").run(params.id); D.audit(user.id, 'client_removed', { id: params.id }); return ok({ ok: true }); });
  // client sign-in: email + emailed code (reuses the login_codes table with an "email:" key)
  add('POST', '/api/client/request-code', null, async ({ body }) => {
    const email = String(body.email || '').toLowerCase().trim(); const u = db.prepare("SELECT * FROM users WHERE email=? AND role='client'").get(email); if (!u) return err(400, 'That email is not set up for the portal — contact dispatch');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('INSERT INTO login_codes(phone,code,expires_at,attempts) VALUES (?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code=excluded.code,expires_at=excluded.expires_at,attempts=0').run('email:' + email, code, new Date(Date.now() + 15 * 60e3).toISOString());
    const sent = await notify.email('Your Guard Pro portal code', `Your sign-in code is ${code}. It expires in 15 minutes.`, [email]);
    return ok({ ok: true, devCode: cfg.devShowCodes && !sent ? code : undefined });
  });
  add('POST', '/api/client/verify', null, ({ body }, ctx) => {
    const email = String(body.email || '').toLowerCase().trim(); const row = db.prepare('SELECT * FROM login_codes WHERE phone=?').get('email:' + email);
    if (!row || row.expires_at < D.now()) return err(401, 'Code expired — request a new one');
    if (row.attempts >= 5) return err(401, 'Too many tries — request a new code');
    if (String(body.code || '').trim() !== row.code) { db.prepare('UPDATE login_codes SET attempts=attempts+1 WHERE phone=?').run('email:' + email); return err(401, 'That code is not right'); }
    db.prepare('DELETE FROM login_codes WHERE phone=?').run('email:' + email);
    const u = db.prepare("SELECT * FROM users WHERE email=? AND role='client'").get(email); if (!u) return err(401, 'No portal login for that email');
    const auth = require('./auth'); const token = auth.createSession ? auth.createSession(u.id, ctx.ua) : null;
    return { status: 200, body: { user: auth.publicUser(u) }, setCookie: token };
  });
  add('GET', '/api/client/overview', CLIENT, ({ user }) => {
    const ids = clientSiteIds(user); const today = T.localDate(); const nowL = T.localString();
    const sites = ids.map(id => D.siteLite(id)).filter(Boolean).map(s => {
      const shifts = db.prepare('SELECT sh.*, p.name AS pos_name FROM shifts sh JOIN positions p ON p.id=sh.position_id WHERE sh.site_id=? AND sh.s>=? AND sh.s<? AND sh.pub=1 ORDER BY sh.s').all(s.id, T.addDays(today, -1) + 'T00:00', T.addDays(today, 7) + 'T00:00');
      return { id: s.id, name: s.name, address: s.address, shifts: shifts.map(r => { const clock = clockOf(r.id); const emp = r.employee_id ? D.getEmployee(r.employee_id) : null; return { id: r.id, s: r.s, e: r.e, post: r.pos_name, officer: emp ? emp.name : null, clockIn: clock.in ? clock.in.at : null, clockOut: clock.out ? clock.out.at : null, state: !emp ? 'open' : clock.out ? 'done' : clock.in ? 'on_post' : (r.s <= nowL && r.e > nowL) ? 'due' : r.e <= nowL ? 'no_show' : 'upcoming', scans: db.prepare('SELECT COUNT(*) c FROM checkpoint_scans WHERE shift_id=?').get(r.id).c }; }) };
    });
    const reports = ids.length ? db.prepare(`SELECT * FROM reports WHERE site_id IN (${ids.map(() => '?').join(',')}) AND status IN ('reviewed','sent') ORDER BY at DESC LIMIT 50`).all(...ids).map(reportView) : [];
    return ok({ client: { name: user.name, email: user.email }, sites, reports, now: nowL });
  });
  add('GET', '/api/client/reports/:id', CLIENT, ({ user, params }) => { const r = db.prepare("SELECT * FROM reports WHERE id=? AND status IN ('reviewed','sent')").get(params.id); if (!r || !clientSiteIds(user).includes(r.site_id)) return err(404, 'No such report'); return ok(reportView(r)); });

  return { reportView, siteCheckpoints, siteTours, shiftScanSummary };
};
