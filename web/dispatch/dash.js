/* Guard Pro dispatch — Dashboard tab (activity feed + KPIs) and dispatcher clock-in. Loaded after phases.js. */
(function () {
  const Dsh = { data: null, timer: null };
  const tabs = $('#tabs'); const tab = document.createElement('button'); tab.dataset.view = 'dashboard'; tab.textContent = 'Dashboard'; tabs.insertBefore(tab, tabs.firstChild);
  const style = document.createElement('style'); style.textContent = `
  .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:14px 16px 6px}
  .tile{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 12px;cursor:pointer}
  .tile b{display:block;font-family:"Barlow Condensed",sans-serif;font-size:30px;line-height:1;font-variant-numeric:tabular-nums}
  .tile span{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .tile.bad b{color:var(--vacant)}.tile.warn b{color:var(--ot)}.tile.ok b{color:var(--ok)}
  .dash{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:14px;padding:6px 16px 24px}
  @media (max-width:1100px){.dash{grid-template-columns:1fr}}
  .feed{display:flex;flex-direction:column;gap:4px}
  .ev{display:grid;grid-template-columns:26px 1fr auto;gap:8px;align-items:start;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px}
  .ev.click{cursor:pointer}.ev.click:hover{background:var(--surface-2)}
  .ev .ic{font-size:15px;line-height:1.2}.ev .t{color:var(--faint);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .ev.att{border-left:3px solid var(--vacant)}
  .dash h3{font-family:"Barlow Condensed",sans-serif;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:6px 0 8px}`;
  document.head.appendChild(style);
  const fmtAt = iso => { if (!iso) return ''; const d = new Date(iso); const today = iso.slice(0, 10) === new Date().toISOString().slice(0, 10) || d.toDateString() === new Date().toDateString(); return (today ? '' : `${d.getMonth() + 1}/${d.getDate()} `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  async function loadDash() { try { Dsh.data = await API.get('/api/dashboard'); if (S.view === 'dashboard') renderContent(); } catch (e) { if (e.message !== 'unauthorized') toast(e.message); } }
  const _setView = setView; setView = function (v) { _setView(v); if (v === 'dashboard') loadDash(); };
  const _renderSub = renderSub; renderSub = function () { if (S.view === 'dashboard') { $('#sub').innerHTML = `<span class="muted">Live activity across every site. Updates as officers clock in, scan, report and drive.</span><button class="btn sm" data-dash="refresh">Refresh</button>`; return; } _renderSub(); };
  const _renderContent = renderContent; renderContent = function () {
    if (S.view === 'dashboard') { const c = $('#content'); if (!S.db) { c.innerHTML = '<div class="loading">Sign in to open the board.</div>'; return; } c.innerHTML = renderDash(); return; }
    _renderContent(); if (S.view === 'live') decorateLive();
  };
  function renderDash() {
    const D = Dsh.data; if (!D) return '<div class="loading">Loading…</div>'; const t = D.tiles;
    const tiles = [['onPost', 'On post now', 'ok', 'live'], ['late', 'Late now', t.late ? 'bad' : '', 'live'], ['due', 'Due now', t.due ? 'warn' : '', 'live'], ['openNow', 'Open right now', t.openNow ? 'bad' : '', 'open'], ['openToday', 'Open today', t.openToday ? 'warn' : '', 'open'], ['openWeek', 'Open this week', '', 'open'],
      ['incidents', 'Incidents to review', t.incidents ? 'bad' : '', 'reports'], ['unreviewed', 'Reports to review', t.unreviewed ? 'warn' : '', 'reports'], ['pending', 'Requests pending', t.pending ? 'warn' : '', 'requests'], ['unacked', 'Unacknowledged (48h)', t.unacked ? 'warn' : '', 'schedule'], ['patrols', 'Patrols on the road', '', 'patrol'], ['missedStops', 'Missed stops today', t.missedStops ? 'bad' : '', 'patrol']];
    const att = D.feed.filter(e => e.attention);
    const ev = e => `<div class="ev ${e.attention ? 'att' : ''} ${e.shiftId || e.reportId ? 'click' : ''}" ${e.shiftId ? `data-ev-shift="${e.shiftId}" data-ev-ws="${e.ws || ''}"` : ''} ${e.reportId ? `data-ev-report="${e.reportId}"` : ''}><span class="ic">${e.icon}</span><span>${esc(e.text)}</span><span class="t">${fmtAt(e.at)}</span></div>`;
    return `<div class="tiles">${tiles.map(([k, l, c, v]) => `<div class="tile ${c}" data-dash-go="${v}"><b>${t[k]}</b><span>${l}</span></div>`).join('')}</div>
    <div class="dash"><div><h3>Needs attention (${att.length})</h3><div class="feed">${att.slice(0, 30).map(ev).join('') || '<div class="muted small">Nothing outstanding.</div>'}</div></div>
    <div><h3>Activity · last 24 hours (${D.feed.length})</h3><div class="feed">${D.feed.map(ev).join('') || '<div class="muted small">No activity yet. Clock-ins, scans, reports, requests and patrol events show up here.</div>'}</div></div></div>`;
  }
  function decorateLive() {
    document.querySelectorAll('#content tr.row[data-shift]').forEach(tr => {
      const st = tr.querySelector('.state'); if (!st || tr.querySelector('[data-dclock]')) return; const k = [...st.classList].find(c => c !== 'state'); const cell = tr.lastElementChild;
      if (['late', 'due', 'no_show'].includes(k)) cell.insertAdjacentHTML('beforeend', ` <button class="btn sm" data-dclock="in" data-id="${tr.dataset.shift}" title="Clock the officer in from dispatch">Clock in</button>`);
      if (k === 'on_post') cell.insertAdjacentHTML('beforeend', ` <button class="btn sm" data-dclock="out" data-id="${tr.dataset.shift}">Clock out</button>`);
    });
  }
  /* dispatcher clock section in the shift editor */
  const _renderPanel = renderPanel; renderPanel = function () { _renderPanel(); const sel = S.sel; if (sel && sel.type === 'shift') appendClock(sel); };
  function appendClock(sel) {
    const p = $('#panel .panel-in'); if (!p) return; const f = findShift(sel.id, sel.ws); const sh = f.sh; if (!sh || !sh.emp) return; const c = sh.clock || {};
    const box = document.createElement('div');
    box.innerHTML = `<h3>Clock (by dispatch)</h3><div class="small muted">${c.in ? 'In ' + fmtAt(c.in.at) + (c.in.flagged ? ' · off-site' : '') + (c.in.note ? ' · ' + esc(c.in.note) : '') : 'Not clocked in'}${c.out ? ' · Out ' + fmtAt(c.out.at) : ''}</div>
    <div class="actions" style="margin-top:6px;align-items:center">${!c.in ? `<input type="time" data-dclock-at class="search" style="min-width:0;padding:4px 8px" title="Actual arrival time, if not now"><button class="btn sm primary" data-dclock="in" data-id="${sh.id}">Clock in</button>` : ''}${c.in && !c.out ? `<input type="time" data-dclock-at class="search" style="min-width:0;padding:4px 8px" title="Actual leaving time, if not now"><button class="btn sm primary" data-dclock="out" data-id="${sh.id}">Clock out</button>` : ''}${c.in ? `<button class="btn sm" data-dclock="undo" data-id="${sh.id}">Remove clock-in</button>` : ''}</div>
    <div class="small faint">Use this when an officer phones in from post or the app is not working. It is recorded as entered by you.</div>`;
    const last = [...p.children].filter(el => el.classList && el.classList.contains('actions')).pop(); if (last) p.insertBefore(box, last); else p.appendChild(box);
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-dclock],[data-dash],[data-dash-go],[data-ev-shift],[data-ev-report]'); if (!b) return;
    try {
      if (b.dataset.dash === 'refresh') return loadDash();
      if (b.dataset.dashGo) return setView(b.dataset.dashGo);
      if (b.dataset.evReport) { S.sel = { type: 'report', id: b.dataset.evReport }; render(); return; }
      if (b.dataset.evShift) { const ws = b.dataset.evWs; if (ws) { S.ws = ws; loadWeek(ws); } S.sel = { type: 'shift', id: b.dataset.evShift, ws: ws || S.ws }; setView('schedule'); return; }
      const kind = b.dataset.dclock; const id = b.dataset.id; if (!kind) return;
      e.stopPropagation();
      if (kind === 'undo' && !confirm('Remove this clock-in (and any clock-out) for the shift?')) return;
      const atEl = $('#panel [data-dclock-at]'); const body = kind === 'undo' ? { kind: 'in', undo: true } : { kind, at: atEl && atEl.value ? atEl.value : undefined };
      await API.send('POST', '/api/shifts/' + id + '/clock', body);
      toast(kind === 'undo' ? 'Clock-in removed' : 'Clocked ' + kind + ' by dispatch'); if (S.view === 'live') loadLive();
    } catch (err) { toast(err.message); }
  }, true);
  try { const es = new EventSource('/api/events'); es.addEventListener('change', () => { if (S.view === 'dashboard') { clearTimeout(Dsh.timer); Dsh.timer = setTimeout(loadDash, 800); } }); } catch (e) {}
  setInterval(() => { if (S.view === 'dashboard' && S.db) loadDash(); }, 60000);
  // Land on the dashboard once signed in (the first connect() ran before this file loaded, so poll for it).
  let waited = 0; const landing = setInterval(() => { waited += 300; if (S.mode === 'live') { clearInterval(landing); if (S.view === 'schedule' && !S.sel) setView('dashboard'); } else if (waited > 20000) clearInterval(landing); }, 300);
  const _connect = connect; connect = async function () { await _connect(); if (S.db && S.view === 'schedule' && !S.sel) setView('dashboard'); };
})();
