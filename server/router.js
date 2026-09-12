// A very small router: each module registers routes with a method, a path pattern and the roles allowed.
// Path patterns use :name segments, e.g. '/api/officer/shifts/:id/ack'.
const routes = [];

function add(method, pattern, roles, fn) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '$');
  routes.push({ method, re, keys, roles, fn });
}
const err = (status, message) => ({ status, body: { error: message } });
const ok = body => ({ status: 200, body });

async function dispatch(req, ctx) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(req.path); if (!m) continue;
    if (r.roles && r.roles.length) {
      if (!req.user) return err(401, 'Sign in first');
      if (!r.roles.includes(req.user.role)) return err(403, r.roles.includes('officer') ? 'Officer login required' : 'Dispatch login required');
    }
    const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
    return r.fn({ ...req, params }, ctx);
  }
  return err(404, 'Not found');
}

module.exports = { add, dispatch, err, ok, DISPATCH: ['dispatch', 'admin'], ADMIN: ['admin'], OFFICER: ['officer'], ANY: ['dispatch', 'admin', 'officer'], CLIENT: ['client'] };
