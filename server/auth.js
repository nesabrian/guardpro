// Logins. Dispatch users: email + password. Officers: phone number + six-digit text code.
const crypto = require('crypto');
const cfg = require('./config');
const { db, now, uid, audit } = require('./db');
const notify = require('./notify');

const normPhone = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const hashPassword = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const checkPassword = (pw, stored) => { if (!stored) return false; const [salt, h] = stored.split(':'); const c = crypto.scryptSync(pw, salt, 32).toString('hex'); return c.length === h.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(h)); };

function createSession(userId, ua) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + cfg.sessionDays * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at,ua) VALUES (?,?,?,?,?)').run(token, userId, now(), exp, (ua || '').slice(0, 200));
  db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), userId);
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s || s.expires_at < now()) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) || null;
}
function destroySession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); }

function loginPassword(email, password, ua) {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
  if (!u || !checkPassword(password || '', u.pass_hash)) return { error: 'Wrong email or password' };
  audit(u.id, 'login', { how: 'password' });
  return { token: createSession(u.id, ua), user: publicUser(u) };
}

async function requestCode(phone) {
  const p = normPhone(phone);
  if (p.length !== 10) return { error: 'Enter a 10-digit phone number' };
  let u = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  if (!u) {
    // First login: match the phone to an officer record and create the login on the fly.
    const emps = db.prepare("SELECT * FROM employees WHERE status='ACTIVE'").all().filter(e => normPhone(e.phone) === p);
    if (emps.length !== 1) return { error: emps.length ? 'That number is on more than one officer record — call dispatch' : 'That number is not on file — call dispatch' };
    const e = emps[0];
    u = { id: uid(), role: 'officer', name: e.name, email: null, phone: p, employee_id: e.id };
    db.prepare('INSERT INTO users(id,role,name,email,phone,pass_hash,employee_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(u.id, 'officer', u.name, null, p, null, e.id, now());
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('INSERT INTO login_codes(phone,code,expires_at,attempts) VALUES (?,?,?,0) ON CONFLICT(phone) DO UPDATE SET code=excluded.code,expires_at=excluded.expires_at,attempts=0')
    .run(p, code, new Date(Date.now() + 10 * 60e3).toISOString());
  const sent = await notify.sms(p, `Guard Pro login code: ${code}. It expires in 10 minutes.`);
  audit(u.id, 'code_requested', { sent });
  return { ok: true, devCode: cfg.devShowCodes && !sent ? code : undefined };
}
function verifyCode(phone, code, ua) {
  const p = normPhone(phone);
  const row = db.prepare('SELECT * FROM login_codes WHERE phone=?').get(p);
  if (!row || row.expires_at < now()) return { error: 'Code expired — request a new one' };
  if (row.attempts >= 5) return { error: 'Too many tries — request a new code' };
  if (String(code || '').trim() !== row.code) { db.prepare('UPDATE login_codes SET attempts=attempts+1 WHERE phone=?').run(p); return { error: 'That code is not right' }; }
  db.prepare('DELETE FROM login_codes WHERE phone=?').run(p);
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  if (!u) return { error: 'No login for that number' };
  audit(u.id, 'login', { how: 'sms' });
  return { token: createSession(u.id, ua), user: publicUser(u) };
}
function publicUser(u) { return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, employeeId: u.employee_id }; }

function ensureAdmin() {
  const a = cfg.admin; if (!a || !a.email) return;
  const email = a.email.toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (u) return;
  db.prepare('INSERT INTO users(id,role,name,email,phone,pass_hash,employee_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid(), 'admin', a.name || 'Admin', email, null, hashPassword(a.password || 'change-me'), null, now());
  console.log(`[auth] created admin login ${email} (password from ${cfg.configFile})`);
}
function createDispatchUser({ name, email, password, role }) {
  const id = uid();
  db.prepare('INSERT INTO users(id,role,name,email,phone,pass_hash,employee_id,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, role === 'admin' ? 'admin' : 'dispatch', name, String(email).toLowerCase(), null, hashPassword(password), null, now());
  return id;
}
function setPassword(userId, password) { db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(password), userId); }
function listUsers() { return db.prepare('SELECT id,role,name,email,phone,employee_id,created_at,last_login_at FROM users ORDER BY role,name').all(); }

module.exports = { normPhone, loginPassword, requestCode, verifyCode, userFromToken, destroySession, publicUser, ensureAdmin, createDispatchUser, setPassword, listUsers, createSession };
