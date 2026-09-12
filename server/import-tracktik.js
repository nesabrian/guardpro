// One-time import of the TrackTik snapshot (the JSON documents produced for the Guard Pro Dispatch board).
// Expects data/import/{employees,sites,weeks}/*.json. Usage: node server/import-tracktik.js [--reset]
const fs = require('fs'), path = require('path');
const cfg = require('./config');
const { db, putEmployee, putSite, putWeek } = require('./db');

const IMPORT = path.join(cfg.root, 'data', 'import');
if (!fs.existsSync(IMPORT)) { console.error('No import folder at', IMPORT); process.exit(1); }
if (process.argv.includes('--reset')) {
  for (const t of ['clockins', 'alerts', 'reminders', 'shifts', 'templates', 'positions', 'sites', 'employees']) db.exec(`DELETE FROM ${t}`);
  console.log('cleared existing roster data');
}
const readAll = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];

let nE = 0, nS = 0, nP = 0, nW = 0, nSh = 0;
for (const e of readAll(path.join(IMPORT, 'employees'))) { putEmployee(e); nE++; }
for (const s of readAll(path.join(IMPORT, 'sites'))) { putSite(s); nS++; nP += (s.positions || []).length; }
for (const w of readAll(path.join(IMPORT, 'weeks'))) { putWeek(w.ws, w, 'import'); nW++; nSh += (w.shifts || []).length; }
console.log(`imported ${nE} officers, ${nS} sites, ${nP} posts, ${nSh} shifts across ${nW} weeks into ${cfg.dbPath}`);
