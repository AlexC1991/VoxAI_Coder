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

  const find = (sid) => panes.find((p) => p.sid === sid);
  const sids = () => panes.map((p) => p.sid);
  const active = () => panes.length > 0;

  function state() { return { panes: sids(), max: MAX_PANES + 1 }; }
  function changed() {
    for (const c of [first(), ...contents()]) { try { c && c.send('split:state', state()); } catch { /* closing */ } }
    try { onChange && onChange(state()); } catch { /* not fatal */ }
  }

  /** Open a session in a new pane. { ok, error } */
  function add(sid) {
    sid = String(sid || '');
    if (!/^[\w.-]{1,80}$/.test(sid)) return { ok: false, error: 'no such session' };
    if (find(sid)) return { ok: false, error: 'already open' };
    if (panes.length >= MAX_PANES) return { ok: false, error: `up to ${MAX_PANES + 1} side by side` };
    const view = new WebContentsView({ webPreferences: prefs });
    try { view.setBackgroundColor('#0e0e10'); } catch { /* older Electron */ }
    view.setVisible(false);            // shown once the first page says where
    rootV.addChildView(view);
    guard(view.webContents);
    view.webContents.loadFile(pageFile, { query: { pane: sid } });
    panes.push({ sid, view });
    changed();
    return { ok: true };
  }

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

  return { add, remove, place, focus, state, sids, active, paneOf, contents, MAX_PANES };
}

module.exports = { createSplit, MAX_PANES };
