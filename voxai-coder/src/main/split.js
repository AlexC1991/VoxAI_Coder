/**
 * split -- sessions side by side, like Claude Code Desktop.
 *
 * Drag a session from the list into the chat and it opens beside it: two, three or
 * four at once. The window's own page stays the first pane (with the session list);
 * each other pane is another copy of that page in "pane mode" -- locked to one
 * session, no title bar or list -- slotted into a hole the first page lays out and
 * measures, the way the preview is. So every pane has the whole thread and its own
 * message box, approvals and questions, with no second copy of that code.
 *
 * While panes are open the preview stays shut: the agent's pages still load, where
 * its browser tools can use them, but nothing opens over the panes.
 */
const MAX_PANES = 3;   // beside the first: four in all

function createSplit({ rootV, WebContentsView, prefs, pageFile, guard, first, onChange }) {
  const panes = [];   // { sid, view }
  let mainSid = '';   // what the window's own page shows: never also in a pane
  let held = false;   // a session is being dragged: the panes step aside for the map
  let lastRects = null;

  const find = (sid) => panes.find((p) => p.sid === sid);
  const sids = () => panes.map((p) => p.sid);
  const active = () => panes.length > 0;

  function state() { return { panes: sids(), max: MAX_PANES + 1 }; }
  function changed() {
    for (const c of [first(), ...contents()]) { try { c && c.send('split:state', state()); } catch { /* closing */ } }
    try { onChange && onChange(state()); } catch { /* not fatal */ }
  }

  /** Open a session in a new pane, at `at` among the panes (the end by default). { ok, error } */
  function add(sid, at) {
    sid = String(sid || '');
    if (!/^[\w.-]{1,80}$/.test(sid)) return { ok: false, error: 'no such session' };
    if (find(sid)) return { ok: false, error: 'already open' };
    if (sid === mainSid) return { ok: false, error: 'already open in the main pane' };
    if (panes.length >= MAX_PANES) return { ok: false, error: `up to ${MAX_PANES + 1} side by side` };
    const view = new WebContentsView({ webPreferences: prefs });
    try { view.setBackgroundColor('#0e0e10'); } catch { /* older Electron */ }
    view.setVisible(false);            // shown once the first page says where
    rootV.addChildView(view);
    guard(view.webContents);
    view.webContents.loadFile(pageFile, { query: { pane: sid } });
    const i = Number.isInteger(at) && at >= 0 && at < panes.length ? at : panes.length;
    panes.splice(i, 0, { sid, view });
    changed();
    return { ok: true };
  }

  /** Four open: the pane at `at` shows `sid` instead. */
  function swap(at, sid) {
    const p = panes[at];
    if (!p) return { ok: false, error: 'no such pane' };
    if (find(sid) || String(sid) === mainSid) return { ok: false, error: 'already open' };
    const old = p.sid;
    remove(old);
    const r = add(sid, at);
    if (!r.ok) add(old, at);
    return r;
  }

  function hold(on) {
    held = !!on;
    if (held) for (const p of panes) p.view.setVisible(false);
    else place(lastRects);
  }
  function setMain(sid) { mainSid = String(sid || ''); }

  function remove(sid) {
    const i = panes.findIndex((p) => p.sid === sid);
    if (i < 0) return false;
    const [p] = panes.splice(i, 1);
    try { rootV.removeChildView(p.view); } catch { /* gone */ }
    try { p.view.webContents.close(); } catch { /* gone */ }
    changed();
    return true;
  }

  /** The first page measured its slots: { sid: {x, y, width, height} }. */
  function place(rects) {
    lastRects = rects;
    if (held) return;
    for (const p of panes) {
      const r = rects && rects[p.sid];
      if (!r || !(r.width > 40) || !(r.height > 40)) { p.view.setVisible(false); continue; }
      p.view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
      p.view.setVisible(true);
    }
  }

  function focus(sid) {
    const p = find(sid);
    if (!p) return false;
    try { p.view.webContents.focus(); p.view.webContents.send('split:flash'); } catch { /* gone */ }
    return true;
  }

  /** The session a pane's page shows, from its webContents (null for the first page). */
  const paneOf = (wc) => { const p = panes.find((x) => x.view.webContents === wc); return p ? p.sid : null; };
  const contents = () => panes.map((p) => p.view.webContents).filter((wc) => wc && !wc.isDestroyed());

  /** The panes on screen now, with where they are (for a snapshot while a dialog is open). */
  function shown() { return panes.filter((p) => { try { return p.view.getVisible(); } catch { return false; } }).map((p) => ({ view: p.view, rect: p.view.getBounds() })); }
  return { add, swap, remove, place, hold, shown, setMain, mainSession: () => mainSid, focus, state, sids, active, paneOf, contents, MAX_PANES };
}

module.exports = { createSplit, MAX_PANES };
