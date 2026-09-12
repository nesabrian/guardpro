// Background checks that run inside the server once a minute:
//  - late: a shift started N minutes ago, has an officer, and nobody clocked in -> alert once
//  - missed: still no clock-in M minutes after start -> second alert once
//  - reminders: text the officer the evening before and a couple of hours before a published shift
const cfg = require('./config');
const { db, now, uid, siteLite, getEmployee } = require('./db');
const notify = require('./notify');
const T = require('./time');

let bus = null;
function setBus(b) { bus = b; }

function shiftLabel(sh, emp, site, pos) {
  return `${emp ? emp.name : 'OPEN'}${emp && emp.phone ? ' · ' + emp.phone : ''} · ${site ? site.name : '?'} · ${pos ? pos.name : '?'} · scheduled ${T.fmtTime(sh.s)}`;
}

async function checkLate() {
  const nowLocal = T.localString();
  const windowStart = T.localString(new Date(Date.now() - 12 * 3600e3));
  const rows = db.prepare(`SELECT sh.*, p.name AS pos_name FROM shifts sh JOIN positions p ON p.id = sh.position_id
    WHERE sh.employee_id IS NOT NULL AND sh.pto = 0 AND sh.s <= ? AND sh.s >= ? AND sh.e > ?
      AND NOT EXISTS (SELECT 1 FROM clockins c WHERE c.shift_id = sh.id AND c.kind = 'in')`).all(nowLocal, windowStart, nowLocal);
  const newAlerts = [];
  for (const sh of rows) {
    const mins = T.minutesSince(sh.s);
    for (const [kind, threshold] of [['late', cfg.lateAfterMinutes || 10], ['missed', cfg.missedAfterMinutes || 60]]) {
      if (mins < threshold) continue;
      const exists = db.prepare('SELECT 1 FROM alerts WHERE shift_id=? AND kind=?').get(sh.id, kind);
      if (exists) continue;
      const emp = getEmployee(sh.employee_id), site = siteLite(sh.site_id);
      const detail = shiftLabel(sh, emp, site, { name: sh.pos_name });
      db.prepare('INSERT INTO alerts(id,shift_id,kind,at,sent,detail) VALUES (?,?,?,?,0,?)').run(uid(), sh.id, kind, now(), detail);
      newAlerts.push({ kind, sh, detail, mins: Math.round(mins) });
    }
  }
  if (!newAlerts.length) return;
  const lines = newAlerts.map(a => a.kind === 'late' ? `🚨 *Late clock-in* — ${a.detail} · ${a.mins} min late` : `❌ *Missed shift* — ${a.detail}`);
  const text = lines.join('\n') + `\n_Checked ${T.fmtTime(nowLocal)} · Guard Pro_`;
  const ok1 = await notify.slack(text);
  const subject = newAlerts.length === 1 ? `${newAlerts[0].kind === 'late' ? 'Late clock-in' : 'Missed shift'}: ${newAlerts[0].detail.split(' · ')[0]}` : `Late/missed clock-ins: ${newAlerts.length} shifts`;
  const ok2 = await notify.email(subject, lines.map(l => l.replace(/\*/g, '')).join('\n') + `\n\nChecked ${T.fmtTime(nowLocal)}. Sent automatically by Guard Pro.`);
  if (ok1 || ok2) for (const a of newAlerts) db.prepare('UPDATE alerts SET sent=1 WHERE shift_id=? AND kind=?').run(a.sh.id, a.kind);
  if (bus) bus.emit({ type: 'alerts' });
}

async function sendReminders() {
  const r = cfg.reminders || {}; const p = T.parts();
  const today = T.localDate(); const tomorrow = T.addDays(today, 1);
  const due = [];
  // Evening-before reminder, once, at the configured hour.
  if (p.h === (r.eveningBeforeHour ?? 18)) {
    for (const sh of db.prepare("SELECT * FROM shifts WHERE pub=1 AND pto=0 AND employee_id IS NOT NULL AND s >= ? AND s < ?").all(tomorrow + 'T00:00', T.addDays(tomorrow, 1) + 'T00:00'))
      if (!db.prepare("SELECT 1 FROM reminders WHERE shift_id=? AND kind='evening'").get(sh.id)) due.push(['evening', sh]);
  }
  // Hours-before reminder.
  const hb = r.hoursBefore ?? 2;
  const from = T.localString(new Date(Date.now() + (hb - 0.5) * 3600e3)), to = T.localString(new Date(Date.now() + (hb + 0.5) * 3600e3));
  for (const sh of db.prepare("SELECT * FROM shifts WHERE pub=1 AND pto=0 AND employee_id IS NOT NULL AND s >= ? AND s < ?").all(from, to))
    if (!db.prepare("SELECT 1 FROM reminders WHERE shift_id=? AND kind='soon'").get(sh.id)) due.push(['soon', sh]);
  for (const [kind, sh] of due) {
    const emp = getEmployee(sh.employee_id), site = siteLite(sh.site_id);
    if (emp && emp.phone) {
      const when = kind === 'evening' ? `tomorrow ${T.fmtTime(sh.s)}` : `today ${T.fmtTime(sh.s)}`;
      await notify.sms(emp.phone.replace(/\D/g, '').slice(-10), `Guard Pro: you are on post at ${site ? site.name : 'your site'} ${when} to ${T.fmtTime(sh.e)}. Open the app to acknowledge and clock in.`);
    }
    db.prepare('INSERT OR IGNORE INTO reminders(shift_id,kind,at) VALUES (?,?,?)').run(sh.id, kind, now());
  }
}

function start() {
  // Both switches default OFF so a parallel run beside TrackTik does not alert on every shift
  // that was clocked in elsewhere. Turn them on in config.json once officers clock in here.
  const tick = async () => { try { if (cfg.alertsEnabled) await checkLate(); if (cfg.remindersEnabled) await sendReminders(); } catch (e) { console.error('[jobs]', e); } };
  if (!cfg.alertsEnabled) console.log('[jobs] late/missed alerts are OFF (alertsEnabled: false)');
  if (!cfg.remindersEnabled) console.log('[jobs] shift reminders are OFF (remindersEnabled: false)');
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000);
  console.log(`[jobs] late after ${cfg.lateAfterMinutes || 10} min, missed after ${cfg.missedAfterMinutes || 60} min, checking every minute`);
}

module.exports = { start, checkLate, setBus };
