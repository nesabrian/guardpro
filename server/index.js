// Guard Pro server: serves the dispatch board, officer app and client portal, and the JSON API behind them.
const http = require('http'), fs = require('fs'), path = require('path');
const cfg = require('./config');
const auth = require('./auth');
const api = require('./api');
const jobs = require('./jobs');

const WEB = path.join(cfg.root, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const COOKIE = 'gp_session';
const API_PREFIXES = ['/api/', '/invoices/'];

function parseCookies(h) { const o = {}; (h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 12e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function send(res, status, body, extra = {}) {
  const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra);
  res.writeHead(status, headers); res.end(JSON.stringify(body));
}
function serveStatic(req, res, urlPath) {
  let p = urlPath;
  if (p === '/' || p === '') { res.writeHead(302, { location: '/dispatch/' }); return res.end(); }
  if (['/dispatch', '/officer', '/client'].includes(p)) { res.writeHead(302, { location: p + '/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!API_PREFIXES.some(p => url.pathname.startsWith(p))) return serveStatic(req, res, url.pathname);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE];
  const user = auth.userFromToken(token);
  const secure = (cfg.baseUrl || '').startsWith('https');
  const cookieBase = `${COOKIE}=%s; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  try {
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);
    const r = await api.handle({ method: req.method, path: url.pathname, query: url.searchParams, body, user, token }, { ua: req.headers['user-agent'] });
    if (r.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 5000\n\n'); api.bus.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { clearInterval(ping); } }, 25000);
      res.on('close', () => clearInterval(ping));
      return;
    }
    if (r.file) { if (!fs.existsSync(r.file)) return send(res, 404, { error: 'File missing' }); res.writeHead(200, { 'content-type': r.type || 'application/octet-stream', 'cache-control': 'private, max-age=3600' }); return fs.createReadStream(r.file).pipe(res); }
    if (r.html !== undefined) { res.writeHead(r.status || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(r.html); }
    if (r.csv !== undefined) { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${r.filename || 'export.csv'}"`, 'cache-control': 'no-store' }); return res.end(r.csv); }
    const extra = {};
    if (r.setCookie) extra['set-cookie'] = cookieBase.replace('%s', r.setCookie) + `; Max-Age=${cfg.sessionDays * 86400}`;
    if (r.clearCookie) extra['set-cookie'] = cookieBase.replace('%s', '') + '; Max-Age=0';
    send(res, r.status, r.body, extra);
  } catch (e) {
    console.error('[api]', req.method, url.pathname, e);
    send(res, 500, { error: e.message || 'Server error' });
  }
});

auth.ensureAdmin();
jobs.setBus(api.bus);
jobs.start();
server.listen(cfg.port, () => console.log(`Guard Pro listening on ${cfg.baseUrl || 'http://localhost:' + cfg.port}  (config: ${cfg.configFile}, db: ${cfg.dbPath})`));
