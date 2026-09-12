// Database layer. Uses Node's built-in SQLite for local and small deployments.
// The SQL is kept plain so the same schema moves to PostgreSQL for hosted use.
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE,
  pass_hash TEXT, employee_id TEXT, created_at TEXT NOT NULL, last_login_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ua TEXT);
CREATE TABLE IF NOT EXISTS login_codes (
  phone TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, custom_id TEXT, first TEXT, last TEXT, name TEXT, title TEXT, phone TEXT, email TEXT,
  status TEXT, armed INTEGER NOT NULL DEFAULT 0, max_hours REAL NOT NULL DEFAULT 40, source TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]', avail_json TEXT NOT NULL DEFAULT '[]', off_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT);
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, custom_id TEXT, name TEXT NOT NULL, type TEXT, phone TEXT, email TEXT, status TEXT,
  address TEXT, lat REAL, lng REAL, radius_m INTEGER, post_orders TEXT, source TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, custom_id TEXT, armed INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, memo TEXT, begin TEXT, end TEXT, sort INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS positions_site ON positions(site_id);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, position_id TEXT NOT NULL, sd INTEGER, st TEXT, ed INTEGER, et TEXT, emp TEXT,
  vacant INTEGER, board INTEGER, brk INTEGER, begin TEXT, end TEXT, every INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS templates_pos ON templates(position_id);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY, ws TEXT NOT NULL, position_id TEXT NOT NULL, site_id TEXT NOT NULL, employee_id TEXT,
  s TEXT NOT NULL, e TEXT NOT NULL, brk INTEGER NOT NULL DEFAULT 0, pub INTEGER NOT NULL DEFAULT 0,
  vac INTEGER NOT NULL DEFAULT 0, board INTEGER NOT NULL DEFAULT 0, pto INTEGER NOT NULL DEFAULT 0,
  att TEXT, note TEXT, ack_at TEXT, updated_at TEXT, updated_by TEXT);
CREATE INDEX IF NOT EXISTS shifts_ws ON shifts(ws);
CREATE INDEX IF NOT EXISTS shifts_emp ON shifts(employee_id, s);
CREATE INDEX IF NOT EXISTS shifts_s ON shifts(s);
CREATE TABLE IF NOT EXISTS clockins (
  id TEXT PRIMARY KEY, shift_id TEXT NOT NULL, employee_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL,
  lat REAL, lng REAL, accuracy_m REAL, distance_m REAL, flagged INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE INDEX IF NOT EXISTS clockins_shift ON clockins(shift_id);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, shift_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT, detail TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_unique ON alerts(shift_id, kind);
CREATE TABLE IF NOT EXISTS reminders (shift_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(shift_id, kind));
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT);
`);

const now = () => new Date().toISOString();
const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const b = v => (v ? 1 : 0);

function audit(userId, action, detail) {
  db.prepare('INSERT INTO audit(at,user_id,action,detail) VALUES (?,?,?,?)').run(now(), userId || null, action, detail ? JSON.stringify(detail).slice(0, 4000) : null);
}

/* ---------- employees ---------- */
function employeeDoc(r) {
  return { id: r.id, customId: r.custom_id || '', first: r.first || '', last: r.last || '', name: r.name || '', title: r.title || '',
    phone: r.phone || '', email: r.email || '', status: r.status || 'ACTIVE', armed: !!r.armed, maxHours: r.max_hours,
    skills: JSON.parse(r.skills_json || '[]'), avail: JSON.parse(r.avail_json || '[]'), off: JSON.parse(r.off_json || '[]'), source: r.source || '' };
}
function listEmployees() { return db.prepare('SELECT * FROM employees ORDER BY last, first').all().map(employeeDoc); }
function getEmployee(id) { const r = db.prepare('SELECT * FROM employees WHERE id=?').get(id); return r ? employeeDoc(r) : null; }
function putEmployee(d) {
  db.prepare(`INSERT INTO employees(id,custom_id,first,last,name,title,phone,email,status,armed,max_hours,source,skills_json,avail_json,off_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET custom_id=excluded.custom_id,first=excluded.first,last=excluded.last,name=excluded.name,title=excluded.title,
    phone=excluded.phone,email=excluded.email,status=excluded.status,armed=excluded.armed,max_hours=excluded.max_hours,source=excluded.source,
    skills_json=excluded.skills_json,avail_json=excluded.avail_json,off_json=excluded.off_json,updated_at=excluded.updated_at`)
    .run(String(d.id), d.customId || '', d.first || '', d.last || '', d.name || ((d.first || '') + ' ' + (d.last || '')).trim(), d.title || '', d.phone || '', (d.email || '').toLowerCase(),
      d.status || 'ACTIVE', b(d.armed), Number(d.maxHours) || 40, d.source || 'guardpro', JSON.stringify(d.skills || []), JSON.stringify(d.avail || []), JSON.stringify(d.off || []), now());
}

/* ---------- sites, positions, templates ---------- */
function siteDoc(r, positions) {
  return { id: r.id, customId: r.custom_id || '', name: r.name, type: r.type || '', phone: r.phone || '', email: r.email || '', status: r.status || 'ACTIVE',
    address: r.address || '', lat: r.lat, lng: r.lng, radius: r.radius_m, postOrders: r.post_orders || '', source: r.source || '', positions };
}
function positionDoc(p, templates) {
  return { id: p.id, name: p.name, customId: p.custom_id || '', armed: !!p.armed, active: !!p.active, memo: p.memo || '', begin: p.begin || '', end: p.end || '', routeId: p.route_id || null, loneMinutes: p.lone_minutes || 0, templates };
}
function templateDoc(t) {
  return { id: t.id, sd: t.sd, st: t.st, ed: t.ed, et: t.et, emp: t.emp, vacant: !!t.vacant, board: !!t.board, brk: t.brk || 0, begin: t.begin || '', end: t.end || '', every: t.every };
}
function listSites() {
  const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
  const poss = db.prepare('SELECT * FROM positions ORDER BY site_id, active DESC, sort, name').all();
  const tpls = db.prepare('SELECT * FROM templates ORDER BY position_id, sd, st').all();
  const tByPos = new Map(); for (const t of tpls) (tByPos.get(t.position_id) || tByPos.set(t.position_id, []).get(t.position_id)).push(templateDoc(t));
  const pBySite = new Map(); for (const p of poss) (pBySite.get(p.site_id) || pBySite.set(p.site_id, []).get(p.site_id)).push(positionDoc(p, tByPos.get(p.id) || []));
  return sites.map(s => siteDoc(s, pBySite.get(s.id) || []));
}
function getSite(id) { const all = listSites(); return all.find(s => s.id === String(id)) || null; }
function siteLite(id) { const r = db.prepare('SELECT * FROM sites WHERE id=?').get(id); return r ? siteDoc(r, []) : null; }
const putSite = (d) => {
  const tx = db.prepare('BEGIN'); tx.run();
  try {
    db.prepare(`INSERT INTO sites(id,custom_id,name,type,phone,email,status,address,lat,lng,radius_m,post_orders,source,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET custom_id=excluded.custom_id,name=excluded.name,type=excluded.type,phone=excluded.phone,email=excluded.email,status=excluded.status,
      address=excluded.address,lat=excluded.lat,lng=excluded.lng,radius_m=excluded.radius_m,post_orders=excluded.post_orders,source=excluded.source,updated_at=excluded.updated_at`)
      .run(String(d.id), d.customId || '', d.name, d.type || 'CLIENT', d.phone || '', (d.email || '').toLowerCase(), d.status || 'ACTIVE', d.address || '',
        d.lat == null || d.lat === '' ? null : Number(d.lat), d.lng == null || d.lng === '' ? null : Number(d.lng), d.radius ? Number(d.radius) : null, d.postOrders || '', d.source || 'guardpro', now());
    const keepPos = new Set();
    (d.positions || []).forEach((p, i) => {
      keepPos.add(String(p.id));
      db.prepare(`INSERT INTO positions(id,site_id,name,custom_id,armed,active,memo,begin,end,sort) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET site_id=excluded.site_id,name=excluded.name,custom_id=excluded.custom_id,armed=excluded.armed,active=excluded.active,memo=excluded.memo,begin=excluded.begin,end=excluded.end,sort=excluded.sort`)
        .run(String(p.id), String(d.id), p.name, p.customId || '', b(p.armed), p.active === false ? 0 : 1, p.memo || '', p.begin || '', p.end || '', i);
      const keepT = new Set();
      for (const t of p.templates || []) {
        keepT.add(String(t.id));
        db.prepare(`INSERT INTO templates(id,position_id,sd,st,ed,et,emp,vacant,board,brk,begin,end,every) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET position_id=excluded.position_id,sd=excluded.sd,st=excluded.st,ed=excluded.ed,et=excluded.et,emp=excluded.emp,vacant=excluded.vacant,board=excluded.board,brk=excluded.brk,begin=excluded.begin,end=excluded.end,every=excluded.every`)
          .run(String(t.id), String(p.id), Number(t.sd), t.st, Number(t.ed), t.et, t.emp ? String(t.emp) : null, b(t.vacant || !t.emp), b(t.board), Number(t.brk) || 0, t.begin || '', t.end || '', Number(t.every ?? 1));
      }
      const old = db.prepare('SELECT id FROM templates WHERE position_id=?').all(String(p.id));
      for (const o of old) if (!keepT.has(o.id)) db.prepare('DELETE FROM templates WHERE id=?').run(o.id);
    });
    const oldP = db.prepare('SELECT id FROM positions WHERE site_id=?').all(String(d.id));
    for (const o of oldP) if (!keepPos.has(o.id)) { db.prepare('DELETE FROM templates WHERE position_id=?').run(o.id); db.prepare('DELETE FROM positions WHERE id=?').run(o.id); }
    db.prepare('COMMIT').run();
  } catch (e) { db.prepare('ROLLBACK').run(); throw e; }
};

/* ---------- shifts / weeks ---------- */
function shiftDoc(r) {
  return { id: r.id, pos: r.position_id, site: r.site_id, emp: r.employee_id, s: r.s, e: r.e, brk: r.brk, pub: !!r.pub, vac: !!r.vac, board: !!r.board, pto: !!r.pto,
    att: r.att || '', note: r.note || '', ack: r.ack_at || null };
}
function weekDoc(ws) {
  const rows = db.prepare('SELECT * FROM shifts WHERE ws=? ORDER BY s').all(ws);
  const ids = rows.map(r => r.id);
  const clock = new Map();
  if (ids.length) {
    // chunk to stay under SQLite's parameter limit
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const c of db.prepare(`SELECT shift_id, kind, at, flagged FROM clockins WHERE shift_id IN (${part.map(() => '?').join(',')}) ORDER BY at`).all(...part))
        (clock.get(c.shift_id) || clock.set(c.shift_id, {}).get(c.shift_id))[c.kind] = { at: c.at, flagged: !!c.flagged };
    }
  }
  return { ws, shifts: rows.map(r => Object.assign(shiftDoc(r), { clock: clock.get(r.id) || null })), updatedAt: now() };
}
function putWeek(ws, doc, userId) {
  db.prepare('BEGIN').run();
  try {
    const keep = new Set();
    for (const s of doc.shifts || []) {
      if (!s.id || !s.pos || !s.site || !s.s || !s.e) continue;
      keep.add(String(s.id));
      db.prepare(`INSERT INTO shifts(id,ws,position_id,site_id,employee_id,s,e,brk,pub,vac,board,pto,att,note,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET ws=excluded.ws,position_id=excluded.position_id,site_id=excluded.site_id,employee_id=excluded.employee_id,s=excluded.s,e=excluded.e,brk=excluded.brk,
        pub=excluded.pub,vac=excluded.vac,board=excluded.board,pto=excluded.pto,att=excluded.att,note=excluded.note,updated_at=excluded.updated_at,updated_by=excluded.updated_by,
        ack_at=CASE WHEN shifts.employee_id IS excluded.employee_id AND shifts.s=excluded.s AND shifts.e=excluded.e THEN shifts.ack_at ELSE NULL END`)
        .run(String(s.id), ws, String(s.pos), String(s.site), s.emp ? String(s.emp) : null, s.s, s.e, Number(s.brk) || 0, b(s.pub), b(!s.emp), b(s.board), b(s.pto), s.att || '', s.note || '', now(), userId || null);
    }
    for (const o of db.prepare('SELECT id FROM shifts WHERE ws=?').all(ws)) if (!keep.has(o.id)) db.prepare('DELETE FROM shifts WHERE id=?').run(o.id);
    db.prepare('COMMIT').run();
  } catch (e) { db.prepare('ROLLBACK').run(); throw e; }
}
function getShift(id) { const r = db.prepare('SELECT * FROM shifts WHERE id=?').get(id); return r ? shiftDoc(r) : null; }

module.exports = { db, now, uid, audit, listEmployees, getEmployee, putEmployee, listSites, getSite, siteLite, putSite, weekDoc, putWeek, getShift, shiftDoc };
