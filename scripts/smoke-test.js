// End-to-end check against a running server: dispatch login, live view, officer code login, shift list, ack, clock-in.
// Usage: node scripts/smoke-test.js [baseUrl]
const base = process.argv[2] || 'http://localhost:8080';
const cfg = require('../server/config');
const { db } = require('../server/db');
const T = require('../server/time');

async function client() {
  let cookie = '';
  return {
    async call(method, path, body) {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    }
  };
}
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  ', m); };

(async () => {
  const d = await client();
  let r = await d.call('POST', '/api/auth/login', { email: cfg.admin.email, password: cfg.admin.password });
  assert(r.status === 200 && r.body.user.role === 'admin', 'dispatch login as ' + cfg.admin.email);
  r = await d.call('GET', '/api/sites'); assert(r.status === 200 && r.body.sites.length > 300, `sites loaded (${r.body.sites.length})`);
  r = await d.call('GET', '/api/employees'); assert(r.status === 200 && r.body.employees.length > 200, `officers loaded (${r.body.employees.length})`);
  r = await d.call('GET', '/api/live'); assert(r.status === 200, `live view: ${r.body.shifts.length} shifts in window`);
  const counts = {}; for (const s of r.body.shifts) counts[s.state] = (counts[s.state] || 0) + 1; console.log('     states', counts);

  // pick an officer who has a shift running right now (or the next one starting) and a phone on file
  const nowL = T.localString();
  const cand = db.prepare(`SELECT sh.*, e.phone, e.name FROM shifts sh JOIN employees e ON e.id = sh.employee_id
     WHERE sh.pub=1 AND sh.pto=0 AND sh.e > ? AND e.phone <> '' ORDER BY sh.s LIMIT 40`).all(nowL)
    .find(x => x.phone.replace(/\D/g, '').length >= 10);
  assert(cand, 'found an officer with an upcoming published shift');
  if (!cand) return;
  console.log(`     testing as ${cand.name} — shift ${cand.s} to ${cand.e}`);
  const o = await client();
  r = await o.call('POST', '/api/auth/request-code', { phone: cand.phone });
  assert(r.status === 200 && r.body.devCode, 'officer code requested (dev code shown because texting is off)');
  r = await o.call('POST', '/api/auth/verify', { phone: cand.phone, code: r.body.devCode });
  assert(r.status === 200 && r.body.user.role === 'officer', 'officer signed in with code');
  r = await o.call('GET', '/api/officer/shifts');
  assert(r.status === 200 && r.body.shifts.some(s => s.id === cand.id), `officer sees own shifts (${r.body.shifts.length})`);
  r = await o.call('GET', '/api/employees'); assert(r.status === 403, 'officer cannot read the full roster');
  r = await o.call('POST', `/api/officer/shifts/${cand.id}/ack`); assert(r.status === 200, 'officer acknowledged the shift');
  r = await o.call('POST', `/api/officer/shifts/${cand.id}/clock`, { kind: 'in', lat: 42.36, lng: -71.06, accuracy: 20 });
  const early = T.minutesSince(cand.s) < -90;
  assert(early ? r.status === 400 : r.status === 200, early ? 'clock-in refused because the shift is more than 90 minutes away' : 'officer clocked in (' + (r.body.note || 'no site coordinates yet, so no distance check') + ')');
  if (r.status === 200) {
    r = await o.call('POST', `/api/officer/shifts/${cand.id}/clock`, { kind: 'in' }); assert(r.status === 400, 'second clock-in refused');
    r = await d.call('GET', '/api/live'); const row = r.body.shifts.find(s => s.id === cand.id); assert(row && row.state === 'on_post' && row.ack, 'dispatch live view shows the officer on post and acknowledged');
    // clean up the test clock-in so the roster is not polluted
    db.prepare('DELETE FROM clockins WHERE shift_id=?').run(cand.id); db.prepare('UPDATE shifts SET ack_at=NULL WHERE id=?').run(cand.id);
    console.log('     test clock-in removed again');
  }
  r = await o.call('POST', '/api/auth/logout'); assert(r.status === 200, 'officer signed out');
})().catch(e => { console.error(e); process.exitCode = 1; });
