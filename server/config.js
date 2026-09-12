// Loads config.json (falls back to config.example.json) and resolves paths relative to the project root.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const file = fs.existsSync(path.join(ROOT, 'config.json')) ? 'config.json' : 'config.example.json';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
cfg.root = ROOT;
cfg.configFile = file;
cfg.dbPath = path.isAbsolute(cfg.dbFile) ? cfg.dbFile : path.join(ROOT, cfg.dbFile);
fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
module.exports = cfg;
