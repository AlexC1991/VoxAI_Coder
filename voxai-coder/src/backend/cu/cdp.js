/**
 * cdp.js — minimal Chrome DevTools Protocol (CDP) browser backend for VoxAI
 * Computer Use, mirroring Codex's "browser" surface (@oai/browser-desktop):
 * a persistent, stateful connection to a real Chrome/Edge instance where the
 * agent can read the live page (text + an indexed accessibility state) and act
 * (click / type / press / scroll) with fresh state after each action.
 *
 * Dependency-free: uses Node's built-in fetch + global WebSocket. The browser
 * connection is a module-level singleton so it PERSISTS across tool calls
 * (and across buildTools instantiations) — exactly like Codex's node_repl.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux: the distro packages, the snap and the vendors' .deb/.rpm installs. A Flatpak browser
  // has no fixed path to run (it lives behind flatpak run), so set CHROME_PATH for one.
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/usr/bin/brave-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && fs.existsSync(c)) return c;
  return null;
}

// ---- module-level singleton (persists across tool calls) ----
let C = null; // { proc, port, userDir, ws, seq, pending, onUserEvent, attachedWC }

function cleanup() {
  if (!C) return;
  try { if (C.attachedWC && C.attachedWC.debugger && C.attachedWC.debugger.isAttached && C.attachedWC.debugger.isAttached()) { try { C.attachedWC.debugger.detach(); } catch {} } } catch {}
  try { C.ws && C.ws.close(); } catch {}
  try { C.proc && C.proc.kill(); } catch {}
  try { fs.rmSync(C.userDir, { recursive: true, force: true }); } catch {}
  C = null;
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

function connectWs(url) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { return reject(e); }
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.id && C && C.pending && C.pending[msg.id]) {
        const p = C.pending[msg.id];
        delete C.pending[msg.id];
        if (msg.error) p.reject(new Error((msg.error.message || 'cdp error') + (msg.error.data ? ' ' + msg.error.data : '')));
        else p.resolve(msg.result);
      } else if (msg.method && C && C.onUserEvent) {
        try { C.onUserEvent(msg); } catch {}
      }
    };
  });
}

async function startBrowser(headless, userDir) {
  const exe = findChrome();
  if (!exe) throw new Error('no Chrome/Edge found for computer-use browser backend');
  const dir = userDir || fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cu-'));
  const args = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-default-apps', '--disable-sync', '--noerrdialogs', '--silent-launch',
    'about:blank',
  ];
  if (headless !== false) args.push('--headless=new', '--disable-gpu');
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(dir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(portFile)) {
      try {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        port = parseInt((lines[0] || '').trim(), 10);
      } catch {}
    }
    if (port) break;
  }
  if (!port) { try { proc.kill(); } catch {} throw new Error('Chrome did not expose a debugging port'); }
  return { proc, port, dir };
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function newTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url || 'about:blank')}`, { method: 'PUT' });
  return res.json();
}

/**
 * Every command has a time limit. Without one, a page that stopped answering (a read
 * of the preview never came back) held the agent for minutes. Found in a live run.
 * A screenshot is optional, so it gets less time.
 */
const SEND_TIMEOUT_MS = 20000;
function withTimeout(p, method, ms, onTimeout) {
  let t;
  const limit = new Promise((_, reject) => {
    t = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch {}
      reject(new Error(`the page did not answer (${method}) within ${Math.round(ms / 1000)}s -- it may be busy or hidden; reload it or try again`));
    }, ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

function send(method, params = {}, ms = method === 'Page.captureScreenshot' ? 10000 : SEND_TIMEOUT_MS) {
  if (!C) return Promise.reject(new Error('computer-use browser not initialized'));
  if (C.attachedWC && C.attachedWC.debugger) {
    // Drive the real in-app browser (Atlas) via Electron's CDP debugger.
    return withTimeout(C.attachedWC.debugger.sendCommand(method, params).catch((e) => {
      throw new Error((e && e.message) || 'cdp error');
    }), method, ms);
  }
  if (!C.ws) return Promise.reject(new Error('computer-use browser not initialized'));
  const id = ++C.seq;
  return withTimeout(new Promise((resolve, reject) => {
    C.pending[id] = { resolve, reject };
    try { C.ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { delete C.pending[id]; reject(e); }
  }), method, ms, () => { delete C.pending[id]; });
}

async function bindPage(wsUrl, onUserEvent) {
  C.ws = await connectWs(wsUrl);
  C.seq = 0; C.pending = {}; C.onUserEvent = onUserEvent || null;
  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await send('DOM.enable', {});
  try { await send('Network.enable', {}); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}   // always the files as they are now
}

async function ensureReady() {
  if (C && ((C.ws && C.ws.readyState === 1) || (C.attachedWC && C.attachedWC.debugger))) return C;
  cleanup();
  const b = await startBrowser(true);
  C = b;
  const targets = await listTargets(b.port);
  const t0 = targets.find((t) => t.type === 'page');
  const wsUrl = t0 ? t0.webSocketDebuggerUrl : (await newTarget(b.port, 'about:blank')).webSocketDebuggerUrl;
  await bindPage(wsUrl);
  return C;
}

// ---- evaluation snippets: indexed accessibility/state snapshot ----
const ELEM_SNIPPET = `(() => {
  const out = { title: document.title, url: location.href, text: '', elements: [] };
  out.text = ((document.body && document.body.innerText) || '').replace(/\\u00a0/g,' ').replace(/\\n{3,}/g,'\\n\\n').slice(0, 16000);
  const sel = 'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="menuitem"],[tabindex]';
  const els = document.querySelectorAll(sel);
  let idx = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
    const tag = (el.tagName || '').toLowerCase();
    const typeAttr = el.getAttribute && el.getAttribute('type') ? ' type=' + el.getAttribute('type') : '';
    const role = el.getAttribute && el.getAttribute('role') ? ' role=' + el.getAttribute('role') : '';
    const name = (el.innerText || (el.value != null ? String(el.value) : '') || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ').slice(0,80);
    out.elements.push({ index: idx, kind: tag + typeAttr + role, label: name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    idx++;
  }
  return out;
})()`;

const CLICK_BY_INDEX = `(idx) => {
  const sel = 'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="menuitem"],[tabindex]';
  const els = [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && !(r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth);
  });
  const el = els[idx];
  if (!el) return { ok: false, error: 'no element at index ' + idx };
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
}`;

// ---- high-level ops ----
async function launch(url, opts = {}) {
  const headless = opts.headless !== false;
  cleanup();
  const b = await startBrowser(headless);
  C = b;
  let wsUrl;
  if (url) {
    const page = await newTarget(b.port, url);
    wsUrl = page.webSocketDebuggerUrl;
  } else {
    const targets = await listTargets(b.port);
    const t0 = targets.find((t) => t.type === 'page');
    wsUrl = t0 ? t0.webSocketDebuggerUrl : (await newTarget(b.port, 'about:blank')).webSocketDebuggerUrl;
  }
  await bindPage(wsUrl);
  if (url) await waitLoad(url);
  return getState();
}

async function waitLoad(url, timeout = 30000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timedOut: true }), timeout);
    const onDone = (m) => { if (m.method === 'Page.loadEventFired') { clearTimeout(t); resolve({ loaded: true }); } };
    C.onUserEvent = (m) => { try { onDone(m); } catch {} };
    send('Page.navigate', { url }).catch(() => {});
  });
}

async function navigate(url) {
  await ensureReady();
  await waitLoad(url);
  return getState();
}

// ------------------------------------------------------------------- overlay --
// Codex/Claude-style visible pointer: inject a transparent glass pane overlay
// with a red action-point dot + a red highlight box over the live page, so the
// user sees exactly where computer-use is pointing/clicking. Mirrors
// Playwright's x-pw-show UI that Codex embeds.
let OVERLAY_INJECTED = new WeakMap();

const OVERLAY_CSS =
  'vox-cu-overlay{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;display:block}' +
  'vox-cu-actionpoint{position:fixed;width:20px;height:20px;background:red;border:2px solid #fff;border-radius:10px;margin:-10px 0 0 -10px;z-index:2147483648;display:none;box-shadow:0 1px 4px rgba(0,0,0,.5)}' +
  'vox-cu-highlight{position:fixed;border:2px solid red;background:rgba(255,0,0,.08);z-index:2147483649;display:none;border-radius:3px}' +
  'vox-cu-label{position:fixed;backdrop-filter:blur(5px);background-color:rgba(0,0,0,.75);color:#fff;border-radius:5px;padding:3px 8px;font:12px system-ui,sans-serif;z-index:2147483650;display:none;pointer-events:none}' +
  '@keyframes vox-cu-fade{0%{opacity:1}100%{opacity:0}}';

const OVERLAY_INJECT_SNIPPET = `
  if (!document.querySelector('vox-cu-overlay')) {
    const st = document.createElement('style'); st.textContent = ${JSON.stringify(OVERLAY_CSS)}; document.head.appendChild(st);
    const o = document.createElement('vox-cu-overlay');
    o.innerHTML = '<vox-cu-actionpoint></vox-cu-actionpoint><vox-cu-highlight></vox-cu-highlight><vox-cu-label></vox-cu-label>';
    document.documentElement.appendChild(o);
    window.__voxCu = { point: o.children[0], box: o.children[1], label: o.children[2] };
  }
`;

const SHOW_POINT_SNIPPET = `
  (x, y, label, fadeMs) => {
    const d = window.__voxCu; if (!d) return { ok:false };
    const px = Math.max(0, Math.min(window.innerWidth, x));
    const py = Math.max(0, Math.min(window.innerHeight, y));
    d.point.style.left = px + 'px'; d.point.style.top = py + 'px';
    d.point.style.display = 'block';
    if (label) { d.label.textContent = label; d.label.style.left = (px + 12) + 'px'; d.label.style.top = (py + 12) + 'px'; d.label.style.display = 'block'; }
    const t = fadeMs || 900;
    d.point.style.animation = 'none'; void d.point.offsetWidth;
    d.point.style.animation = 'vox-cu-fade ' + t + 'ms ease-out forwards';
    d.point._fade = t;
    return { ok: true, x: px, y: py };
  }
`;

const SHOW_HIGHLIGHT_SNIPPET = `
  (x, y, w, h, label, ms) => {
    const d = window.__voxCu; if (!d) return { ok:false };
    d.box.style.left = x + 'px'; d.box.style.top = y + 'px';
    d.box.style.width = Math.max(0,w) + 'px'; d.box.style.height = Math.max(0,h) + 'px';
    d.box.style.display = 'block';
    if (label) { d.label.textContent = label; d.label.style.left = (x + w + 6) + 'px'; d.label.style.top = (y + 6) + 'px'; d.label.style.display = 'block'; }
    setTimeout(() => { try { d.box.style.display='none'; if(!d.label._pinned) d.label.style.display='none'; } catch{} }, ms || 1000);
    return { ok: true };
  }
`;

async function ensureOverlay() {
  await ensureReady();
  if (!OVERLAY_INJECTED.get(C)) {
    try { await send('Runtime.evaluate', { expression: OVERLAY_INJECT_SNIPPET, returnByValue: true }); OVERLAY_INJECTED.set(C, true); } catch {}
  }
  return C;
}

/** Move the visible red pointer + optional highlight + label to (x,y). */
async function showPointer(x, y, label, fadeMs) {
  await ensureOverlay();
  try { await send('Runtime.evaluate', { expression: `(${SHOW_POINT_SNIPPET})(${x}, ${y}, ${label ? JSON.stringify(String(label).slice(0,60)) : 'null'}, ${fadeMs || 900})`, returnByValue: true }); } catch {}
}

/** Outline a target element (by its rect) in red before clicking it. */
async function showHighlight(x, y, w, h, label, ms) {
  await ensureOverlay();
  try { await send('Runtime.evaluate', { expression: `(${SHOW_HIGHLIGHT_SNIPPET})(${x}, ${y}, ${w}, ${h}, ${label ? JSON.stringify(String(label).slice(0,60)) : 'null'}, ${ms || 1000})`, returnByValue: true }); } catch {}
}

/**
 * Is the page hidden? A hidden page draws nothing, so a screenshot request waits for a frame that
 * never comes (2 in 3 went unanswered in a test) -- that stalled the agent's page reads. Asked of
 * the page, not of the app's windows: a minimised app now parks its browsers off screen, where they
 * keep drawing (main.js layoutAtlas), and "any window minimised" refused every screenshot of the
 * 30B's Breakout although the page was being drawn. Reading the page still works either way.
 */
async function pageHidden() {
  if (!C || !C.attachedWC) return false;
  try {
    const r = await send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
    return !!(r && r.result && r.result.value === 'hidden');
  } catch { return false; }
}

async function getState(includeScreenshot = true) {
  await ensureReady();
  const res = await send('Runtime.evaluate', { expression: ELEM_SNIPPET, returnByValue: true });
  const snap = (res && res.result && res.result.value) || { title: '', url: '', text: '', elements: [] };
  let screenshot = null;
  if (includeScreenshot && await pageHidden()) {
    return { surface: 'browser', title: snap.title, url: snap.url, text: snap.text, elements: snap.elements, screenshot: null,
      note: 'No screenshot: the page is hidden, so it is not being drawn. The text and elements above are current.' };
  }
  if (includeScreenshot) {
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.data) screenshot = 'data:image/png;base64,' + shot.data;
    } catch { /* optional */ }
  }
  return { surface: 'browser', title: snap.title, url: snap.url, text: snap.text, elements: snap.elements, screenshot };
}

async function clickInput(opts) {
  await ensureReady();
  let x = opts.x, y = opts.y;
  let elemRect = null, elemLabel = null;
  if (opts.index != null) {
    const r = await send('Runtime.evaluate', { expression: `(${CLICK_BY_INDEX})(${opts.index})`, returnByValue: true });
    const v = r && r.result && r.result.value;
    if (!v || !v.ok) throw new Error((v && v.error) || 'element index out of range');
    x = v.x; y = v.y;
    // capture the element rect + label for the overlay highlight
    try {
      const rr = await send('Runtime.evaluate', { expression: `(() => { const sel='a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="menuitem"],[tabindex]'; const els=[...document.querySelectorAll(sel)].filter(e=>{const r=e.getBoundingClientRect(); return r.width>=2&&r.height>=2&&!(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)}); const el=els[${opts.index}]; if(!el) return null; const b=el.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height,label:(el.innerText||el.getAttribute('aria-label')||el.value||el.getAttribute('placeholder')||el.tagName||'').trim().replace(/\\s+/g,' ').slice(0,40)}; })()`, returnByValue: true });
      elemRect = rr && rr.result && rr.result.value;
      elemLabel = elemRect && elemRect.label;
    } catch {}
  }
  const button = opts.mouse_button || 'left';
  const clickCount = opts.click_count || 1;
  if (x == null || y == null) throw new Error('cu_click needs index or x/y');
  // Codex/Claude-style: show the red pointer + highlight BEFORE acting, so the
  // user sees what's about to be clicked.
  try {
    if (elemRect) await showHighlight(Math.round(elemRect.x), Math.round(elemRect.y), Math.round(elemRect.w), Math.round(elemRect.h), elemLabel, 700);
    await showPointer(x, y, elemLabel, 900);
    await new Promise((res) => setTimeout(res, 120)); // brief visual so the pointer is seen
  } catch {}
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  return { ok: true, x, y };
}


async function typeInput(text) {
  await ensureReady();
  try { const c = await windowCenter(); await showPointer(c.x, c.y, 'typing: ' + String(text).slice(0,20), 600); } catch {}
  await send('Input.insertText', { text: String(text) });
  return { ok: true, text: String(text) };
}

const MOD_MAP = { Control: 'Control', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Meta', Command: 'Meta' };
const KEY_TO_CODE = {
  Enter: 'Enter', Return: 'Enter', Tab: 'Tab', space: ' ', Escape: 'Escape', Esc: 'Escape',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Backspace: 'Backspace', Delete: 'Delete', F5: 'F5',
};

async function pressInput(key) {
  await ensureReady();
  try { const c = await windowCenter(); await showPointer(c.x, c.y, 'key: ' + String(key).slice(0,20), 600); } catch {}
  const parts = String(key).split('+').map((k) => k.trim()).filter(Boolean);
  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (MOD_MAP[p]) mods.push(MOD_MAP[p]);
    else keys.push(KEY_TO_CODE[p] != null ? KEY_TO_CODE[p] : (p.length === 1 ? p : p));
  }
  const modBits = mods.length;
  for (const m of mods) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: m, code: m, modifiers: modBits });
  for (const k of keys) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, modifiers: modBits });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, modifiers: modBits });
  }
  for (const m of mods.slice().reverse()) await send('Input.dispatchKeyEvent', { type: 'keyUp', key: m, code: m, modifiers: modBits });
  return { ok: true, key: String(key) };
}

async function scrollInput(opts) {
  await ensureReady();
  const dx = opts.dx || 0, dy = opts.dy || 0;
  let x = opts.x, y = opts.y;
  if (opts.index != null) {
    const r = await send('Runtime.evaluate', { expression: `(${CLICK_BY_INDEX})(${opts.index})`, returnByValue: true });
    const v = r && r.result && r.result.value;
    if (v && v.ok) { x = v.x; y = v.y; }
  }
  if (x == null) { const c = await windowCenter(); x = c.x; y = c.y; }
  try { await showPointer(x, y, 'scroll', 500); } catch {}
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy || dx });
  return { ok: true, dx, dy };
}

async function windowCenter() {
  const r = await send('Runtime.evaluate', { expression: '({x: window.innerWidth/2, y: window.innerHeight/2})', returnByValue: true });
  return (r && r.result && r.result.value) || { x: 640, y: 400 };
}

async function screenshot() {
  await ensureReady();
  // Minimised, nothing is drawn: say so at once rather than wait out the time limit.
  if (await pageHidden()) throw new Error('No screenshot: the page is hidden, so it is not being drawn. Read the page state instead.');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  return shot && shot.data ? 'data:image/png;base64,' + shot.data : null;
}

async function list() {
  await ensureReady();
  const targets = await listTargets(C.port);
  return targets.filter((t) => t.type === 'page').map((t) => ({ id: t.id, type: t.type, title: t.title || t.url, url: t.url }));
}

async function close() { cleanup(); return { ok: true }; }

/**
 * attach — bind the computer-use layer to an existing Electron WebContents
 * (e.g. the in-app Atlas browserV) via its CDP debugger, instead of launching a
 * separate Chrome. This is how Codex/Claude control the browser the user sees:
 * the automation acts on the SAME view that's visible. Falls back to launching a
 * standalone Chrome if no webContents is provided.
 */
async function attach(wc) {
  if (!wc || !wc.debugger) return { ok: false, error: 'no webContents.debugger available (not under Electron?)' };
  cleanup();
  C = { attachedWC: wc, seq: 0, pending: {}, onUserEvent: null };
  try {
    wc.debugger.attach('1.3');
  } catch (e) {
    // already attached by something else — reuse is fine
    if (!wc.debugger.isAttached || !wc.debugger.isAttached()) cleanup();
  }
  if (!wc.debugger.isAttached || !wc.debugger.isAttached()) {
    cleanup();
    return { ok: false, error: 'failed to attach CDP debugger to webContents' };
  }
  wc.debugger.removeListener && wc.debugger.removeAllListeners && wc.debugger.removeAllListeners('message');
  wc.debugger.on('message', (_e, method, params) => { if (method === 'Page.loadEventFired' && C && C.onUserEvent) { try { C.onUserEvent({ method, params }); } catch {} } });
  try { await send('Page.enable', {}); } catch {}
  try { await send('Runtime.enable', {}); } catch {}
  try { await send('DOM.enable', {}); } catch {}
  // No cache while the agent drives it, like DevTools' Disable cache: after an edit it reloaded
  // the page, got the old script from the cache, and went hunting for a bug it had fixed. Seen live.
  try { await send('Network.enable', {}); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
  return { ok: true, surface: 'atlas' };
}

/** Is the computer-use layer already driving this webContents? */
function attachedTo(wc) {
  try {
    return !!(C && wc && C.attachedWC === wc && wc.debugger && wc.debugger.isAttached && wc.debugger.isAttached());
  } catch { return false; }
}

module.exports = { withTimeout, attachedTo, launch, navigate, getState, clickInput, typeInput, pressInput, scrollInput, screenshot, list, close, attach, showPointer, showHighlight, ensureOverlay, cleanup, ensureReady, findChrome };