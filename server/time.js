// Wall-clock helpers. Shifts are stored as local New York times ("2026-09-06T08:00") with no offset,
// which is how dispatch thinks about them. These helpers convert between that and real instants.
const cfg = require('./config');
const TZ = cfg.timeZone || 'America/New_York';
const pad = n => String(n).padStart(2, '0');

// Local wall-clock parts of an instant in the configured zone.
function parts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
const localString = (date = new Date()) => { const p = parts(date); return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; };
const localDate = (date = new Date()) => localString(date).slice(0, 10);

// Instant for a local wall-clock string. Works by finding the UTC time whose local rendering matches.
function toInstant(local) {
  const [d, t = '00:00'] = local.split('T'); const [y, m, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
  let guess = Date.UTC(y, m - 1, da, h, mi);
  for (let i = 0; i < 3; i++) { const p = parts(new Date(guess)); const want = Date.UTC(y, m - 1, da, h, mi); const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi); guess += want - got; if (want === got) break; }
  return new Date(guess);
}
const minutesSince = local => (Date.now() - toInstant(local).getTime()) / 60000;
function sundayOf(localDateStr) { const [y, m, d] = localDateStr.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); return dt.toISOString().slice(0, 10); }
function addDays(localDateStr, n) { const [y, m, d] = localDateStr.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); }
const fmtTime = local => { const [h, mi] = local.slice(11, 16).split(':').map(Number); return `${h % 12 || 12}:${pad(mi)}${h < 12 ? 'am' : 'pm'}`; };

module.exports = { TZ, parts, localString, localDate, toInstant, minutesSince, sundayOf, addDays, fmtTime };
