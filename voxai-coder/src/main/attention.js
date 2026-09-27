/**
 * attention -- telling you a session needs you when VoxAI is not in front.
 *
 *   A  a card in the corner per request, drawn like AI Account Hub's Signal Rail: which
 *      project, what it asks, and for an approval Allow once / Deny / Open right on it
 *      (Open for a question). Or, if you prefer, Windows' own notification.
 *   B  a count badge on the taskbar button, which flashes when a new one arrives,
 *      and a red dot on the tray icon
 *   +  a tray icon (Open, Quit) and, if you want, minimize / close to the tray
 *
 * A toast's buttons reach the running app as voxai-coder:// links: Windows starts a
 * second copy with the link, the single-instance lock hands it to this one
 * ('second-instance'), and it is acted on here. Each toast carries a one-time secret,
 * so a link from anywhere else -- a web page -- cannot answer an approval.
 */
const path = require('path');
const crypto = require('crypto');
const { Tray, Menu, Notification, nativeImage, BrowserWindow, ipcMain, screen } = require('electron');

const PROTOCOL = 'voxai-coder';
// The corner card (renderer/notice.html). The window has 10 px of shadow room round the
// card; fixed sizes keep a stack from shifting. Up to three, newest at the bottom.
const CARD_W = 340, CARD_H = 134, CARD_GAP = 6, CARD_MARGIN = 8, CARD_MAX = 3;
const CARD_TONE = { perm: '#d9a35f', ask: '#8fb3d9' };
const CARD_WORD = { shell: 'Run', 'write-file': 'Edit', 'browser-act': 'Browser', 'desktop-act': 'Desktop', 'desktop-look': 'Look', 'web-fetch': 'Fetch', 'web-search': 'Search' };

function xml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** The icon with a red dot in the top right: the tray's "something needs you". */
function dotted(img) {
  const size = 32;
  const base = img.resize({ width: size, height: size });
  const buf = Buffer.from(base.toBitmap());   // BGRA
  const cx = 24, cy = 8, r = 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r + 1) continue;
      const i = (y * size + x) * 4;
      const white = d > r - 0.2;               // a thin light ring keeps it readable on dark taskbars
      buf[i] = white ? 255 : 77; buf[i + 1] = white ? 255 : 72; buf[i + 2] = white ? 255 : 229; buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createAttention({ app, getWindow, getSettings, pendingPerms, pendingInputs, live, renderer, answerPerm, openSession }) {
  const iconFile = path.join(__dirname, '..', '..', 'resources', 'icon.png');
  const appIcon = nativeImage.createFromPath(iconFile);
  const dotIcon = appIcon.isEmpty() ? appIcon : dotted(appIcon);
  let tray = null;
  let quitting = false;
  let lastCount = -1;
  const seen = new Set();          // request ids already announced
  const toasts = new Map();        // request id -> { note, secret, sessionId }
  const badges = new Map();        // count label -> nativeImage
  const cards = [];                // { id, win, sessionId }, oldest first

  app.on('before-quit', () => { quitting = true; });

  // ---- the tray -----------------------------------------------------------------
  const show = () => {
    const w = getWindow(); if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show(); w.focus();
  };
  function syncTray() {
    const s = getSettings();
    const want = !!(s.trayOnMinimize || s.trayOnClose);
    if (want && !tray && !appIcon.isEmpty()) {
      tray = new Tray(appIcon);
      tray.setToolTip('VoxAI Coder');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open VoxAI Coder', click: show },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
      ]));
      tray.on('click', show);
      lastCount = -1;   // repaint the dot
    } else if (!want && tray) {
      tray.destroy(); tray = null;
    }
  }

  /** Minimize / close to the tray, when you ask for it. Called once the window exists. */
  function wireWindow(w) {
    w.on('minimize', (e) => {
      if (!getSettings().trayOnMinimize) return;
      syncTray(); if (!tray) return;
      e.preventDefault(); w.hide();
    });
    w.on('close', (e) => {
      if (quitting || !getSettings().trayOnClose) return;
      syncTray(); if (!tray) return;
      e.preventDefault(); w.hide();
    });
    w.on('focus', () => { try { w.flashFrame(false); } catch { /* gone */ } });
  }

  // ---- B: the count badge and the flash ---------------------------------------------
  async function badgeFor(n) {
    const label = n > 9 ? '9+' : String(n);
    if (badges.has(label)) return badges.get(label);
    const wc = renderer();
    if (!wc) return null;
    const url = await wc.executeJavaScript(`(() => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d');
      g.fillStyle = '#e5484d'; g.beginPath(); g.arc(16, 16, 16, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.font = 'bold ${label.length > 1 ? 16 : 21}px Segoe UI, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(${JSON.stringify(label)}, 16, 17); return c.toDataURL('image/png'); })()`).catch(() => null);
    const img = url ? nativeImage.createFromDataURL(url) : null;
    if (img && !img.isEmpty()) badges.set(label, img);
    return img;
  }

  // ---- what is waiting now ----------------------------------------------------------------
  function waiting() {
    const out = [];
    for (const [id, p] of pendingPerms) {
      if (!p || !p.msg) continue;
      out.push({ id, kind: 'perm', sessionId: p.msg.sessionId, text: String(p.msg.target || ''), what: p.msg.kind });
    }
    for (const [id, p] of pendingInputs) {
      if (!p) continue;
      const e = p.event || {};
      const q = e.question || (Array.isArray(e.questions) && e.questions[0] && e.questions[0].question) || 'It has a question for you';
      out.push({ id, kind: 'ask', sessionId: p.sessionId, text: String(q), many: Array.isArray(e.questions) ? e.questions.length : 1 });
    }
    return out;
  }

  const KIND_WORD = { shell: 'Run', 'write-file': 'Change a file', 'browser-act': 'Browser', 'desktop-act': 'Desktop', 'desktop-look': 'Look at', 'web-fetch': 'Open a web page', 'web-search': 'Search the web' };

  // ---- A: the notification ----------------------------------------------------------------
  function toast(req) {
    if (!Notification.isSupported()) return;
    const sess = live.get(req.sessionId);
    const project = sess && sess.workdir ? path.basename(String(sess.workdir).replace(/[\\/]+$/, '')) : 'A session';
    const title = `${project} needs you`;
    const body = req.kind === 'perm'
      ? `${KIND_WORD[req.what] ? KIND_WORD[req.what] + ': ' : ''}${req.text}`.slice(0, 200)
      : (req.many > 1 ? `${req.many} questions: ` : 'Question: ') + req.text.slice(0, 180);
    const secret = crypto.randomBytes(12).toString('hex');
    const link = (q) => xml(`${PROTOCOL}://${q}&k=${secret}`);
    const open = link(`open?s=${encodeURIComponent(req.sessionId)}&id=${encodeURIComponent(req.id)}`);
    const actions = req.kind === 'perm'
      ? `<action content="Allow once" activationType="protocol" arguments="${link(`perm?id=${encodeURIComponent(req.id)}&a=allow`)}"/>`
        + `<action content="Deny" activationType="protocol" arguments="${link(`perm?id=${encodeURIComponent(req.id)}&a=deny`)}"/>`
        + `<action content="Open" activationType="protocol" arguments="${open}"/>`
      : `<action content="Open" activationType="protocol" arguments="${open}"/>`;
    const toastXml = `<toast activationType="protocol" launch="${open}"><visual><binding template="ToastGeneric">`
      + `<text>${xml(title)}</text><text>${xml(body)}</text></binding></visual><actions>${actions}</actions></toast>`;
    try {
      const n = new Notification({ toastXml });
      n.show();
      toasts.set(req.id, { note: n, secret, sessionId: req.sessionId });
    } catch { /* notifications off in Windows: the badge still shows */ }
  }

  // ---- A: the corner card -------------------------------------------------------------
  const MODEL_SHORT = (m) => String(m || '').split('/').pop().replace(/[-_]/g, ' ');
  function cardData(req) {
    const sess = live.get(req.sessionId);
    const project = sess && sess.workdir ? path.basename(String(sess.workdir).replace(/[\\/]+$/, '')) : 'A session';
    const title = sess && sess.title ? String(sess.title) : '';
    const model = sess && sess.model ? MODEL_SHORT(sess.model) : MODEL_SHORT(getSettings().openrouterModel);
    const perm = req.kind === 'perm';
    return {
      tone: perm ? CARD_TONE.perm : CARD_TONE.ask,
      title: `${project} needs you`,
      account: [title, model].filter(Boolean).join(' | '),
      message: req.text.slice(0, 300),
      value: perm ? (CARD_WORD[req.what] || 'Approve') : 'Ask',
      meta: perm ? 'approval' : (req.many > 1 ? `${req.many} questions` : 'question'),
      actions: perm
        ? [{ label: 'Allow once', act: 'allow', primary: true }, { label: 'Deny', act: 'deny' }, { label: 'Open', act: 'open' }]
        : [{ label: 'Answer in VoxAI', act: 'open', primary: true }],
      timeoutMs: 12000,
    };
  }
  function cardSpots() {
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + wa.width - CARD_W - CARD_MARGIN;
    let y = wa.y + wa.height - CARD_MARGIN;
    const spots = new Map();
    for (const c of [...cards].reverse()) { y -= CARD_H; spots.set(c, { x, y }); y -= CARD_GAP; }
    return spots;
  }
  function glide(win, to) {
    if (!win || win.isDestroyed()) return;
    const [fx, fy] = win.getPosition();
    if (fx === to.x && fy === to.y) return;
    clearInterval(win._glide);
    let i = 0; const n = 9;
    win._glide = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(win._glide); return; }
      i++; const k = 1 - Math.pow(1 - i / n, 3);
      win.setPosition(Math.round(fx + (to.x - fx) * k), Math.round(fy + (to.y - fy) * k));
      if (i >= n) clearInterval(win._glide);
    }, 16);
  }
  function restack() { for (const [c, p] of cardSpots()) glide(c.win, p); }
  function dropCard(c, fade) {
    const i = cards.indexOf(c); if (i < 0) return;
    cards.splice(i, 1);
    const end = () => { try { if (!c.win.isDestroyed()) c.win.destroy(); } catch { /* gone */ } restack(); };
    if (fade && !c.win.isDestroyed()) { try { c.win.webContents.send('notice:bye'); } catch { /* gone */ } setTimeout(end, 150); } else end();
  }
  function card(req) {
    while (cards.length >= CARD_MAX) dropCard(cards[0], false);
    const win = new BrowserWindow({
      width: CARD_W, height: CARD_H, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, title: 'VoxAI Coder',
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'notice-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch { /* older Electron */ }
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const c = { id: req.id, win, sessionId: req.sessionId };
    cards.push(c);
    const spot = cardSpots().get(c);
    win.setPosition(spot.x, spot.y);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'notice.html'), { query: { d: JSON.stringify(cardData(req)) } });
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    win.on('closed', () => { const i = cards.indexOf(c); if (i >= 0) { cards.splice(i, 1); restack(); } });
    restack();
  }
  // What was clicked on a card. Only a card's own window is heard, for its own request.
  ipcMain.on('notice:act', (e, a) => {
    const c = cards.find((x) => !x.win.isDestroyed() && x.win.webContents === e.sender);
    if (!c) return;
    if (a === 'allow' || a === 'deny') answerPerm(c.id, a === 'allow');
    else if (a === 'open') { show(); openSession(c.sessionId); }
    dropCard(c, false);
  });

  /** Once a second: badge, tray dot, flash and notifications follow what is waiting. */
  async function tick() {
    const s = getSettings();
    syncTray();
    const w = getWindow();
    const list = waiting();
    const n = list.length;
    const away = !w || w.isDestroyed() || !w.isVisible() || w.isMinimized() || !w.isFocused();
    for (const req of list) {
      // Announced once, when you are not looking: one that came in while you were, and is
      // still waiting when you switch away, is announced then.
      if (seen.has(req.id) || !away) continue;
      seen.add(req.id);
      if (s.notifyTaskbar && w && !w.isDestroyed()) { try { w.flashFrame(true); } catch { /* gone */ } }
      if (s.notifyToast) { if (s.notifyNative) toast(req); else card(req); }
    }
    // Answered (here or on screen): its notification goes, its id is forgotten.
    const ids = new Set(list.map((r) => r.id));
    for (const id of [...seen]) if (!ids.has(id)) seen.delete(id);
    for (const [id, t] of toasts) if (!ids.has(id)) { try { t.note.close(); } catch { /* gone */ } toasts.delete(id); }
    for (const c of [...cards]) if (!ids.has(c.id)) dropCard(c, true);
    if (n === lastCount) return;
    lastCount = n;
    if (w && !w.isDestroyed()) {
      try {
        if (s.notifyTaskbar && n > 0) { const b = await badgeFor(n); w.setOverlayIcon(b, `${n} waiting for you`); }
        else w.setOverlayIcon(null, '');
        if (n === 0) w.flashFrame(false);
      } catch { /* not on this platform */ }
    }
    if (tray) {
      tray.setImage(n > 0 ? dotIcon : appIcon);
      tray.setToolTip(n > 0 ? `VoxAI Coder — ${n} waiting for you` : 'VoxAI Coder');
    }
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  app.on('will-quit', () => { clearInterval(timer); for (const c of [...cards]) dropCard(c, false); if (tray) { try { tray.destroy(); } catch { /* gone */ } } });

  // ---- a toast's button, arriving as a link --------------------------------------------------
  /** Returns true when the link was ours (acted on or refused). */
  function handleLink(url) {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    if (u.protocol !== PROTOCOL + ':') return false;
    const id = u.searchParams.get('id') || '';
    const t = toasts.get(id);
    // Only a link from a notification this copy showed, with its secret, does anything.
    if (!t || !u.searchParams.get('k') || u.searchParams.get('k') !== t.secret) return true;
    const what = u.hostname || u.pathname.replace(/^\/+/, '');
    if (what === 'perm') {
      const a = u.searchParams.get('a');
      if (a === 'allow' || a === 'deny') answerPerm(id, a === 'allow');
      return true;
    }
    if (what === 'open') { show(); openSession(t.sessionId); return true; }
    return true;
  }

  function registerProtocol() {
    try {
      if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
      else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] || '.')]);
    } catch { /* the buttons fall back to opening the app */ }
  }

  return { wireWindow, handleLink, registerProtocol, syncTray, tick, _waiting: waiting, _cards: cards, _cardData: cardData };
}

module.exports = { createAttention, dotted, PROTOCOL };
