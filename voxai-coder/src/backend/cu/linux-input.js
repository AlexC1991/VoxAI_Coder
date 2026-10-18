/**
 * linux-input.js — the desktop agent's hands on Linux, as a drop-in for win-input.js.
 *
 * Same exported surface, so cu/desktop.js does not care which one it got. Where win-input.js
 * uses SendInput through koffi, this drives xdotool: window listing/geometry from xwininfo,
 * input from xdotool, and the process name from /proc.
 *
 * Two honest limitations, both reported rather than hidden:
 *   - Wayland: xdotool only reaches XWayland windows (which includes everything under Wine and
 *     Proton, and most X11 apps). A native Wayland window is not enumerable here.
 *   - Screenshots are X11-only, and ImageMagick's `import` is refused outright by some
 *     Wayland compositors (COSMIC among them). `available()` therefore says "input works"
 *     even where capture does not; screenshot failures explain themselves.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DISPLAY = () => process.env.DISPLAY || '';

function run(cmd, args, timeout = 20000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) return { ok: false, err: String(r.error.message || r.error) };
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- availability ----------------------------------------------------------

let toolsCache;
function tools() {
  if (toolsCache) return toolsCache;
  const have = (c) => run('sh', ['-c', `command -v ${c} >/dev/null 2>&1 && echo y`], 8000).out.trim() === 'y';
  toolsCache = { xdotool: have('xdotool'), xwininfo: have('xwininfo'), import: have('import') };
  return toolsCache;
}

/** Input and window listing work; screenshots may still be refused by the compositor. */
function available() {
  try {
    if (!DISPLAY()) return false;
    const t = tools();
    return Boolean(t.xdotool && t.xwininfo);
  } catch { return false; }
}

// ---- windows ---------------------------------------------------------------

const CHILD_RE = /^\s*(0x[0-9a-fA-F]+)\s+(?:"([^"]*)"|\(has no name\)):\s*\(([^)]*)\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;

/** ids in stacking order, bottom to top (xwininfo lists them that way). */
function rawChildren() {
  const r = run('xwininfo', ['-root', '-children'], 15000);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(CHILD_RE);
    if (!m) continue;
    out.push({
      id: m[1],
      hwnd: parseInt(m[1], 16),
      title: (m[2] || '').trim(),
      cls: (m[3] || '').replace(/"/g, '').trim(),
      w: parseInt(m[4], 10), h: parseInt(m[5], 10),
      x: parseInt(m[6], 10), y: parseInt(m[7], 10),
    });
  }
  return out;
}

function pidOf(id) {
  const r = run('xdotool', ['getwindowpid', id], 8000);
  if (!r.ok) return 0;
  const n = parseInt(r.out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

const nameCache = new Map();
/** The program behind a process: "Agent.exe", or the distro's name for it. */
function processName(pid) {
  const p = Number(pid) || 0;
  if (!p) return '';
  if (nameCache.has(p)) return nameCache.get(p);
  let name = '';
  try { name = fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim(); } catch { /* gone */ }
  if (!name) { try { name = path.basename(fs.readlinkSync(`/proc/${p}/exe`)); } catch { /* gone */ } }
  nameCache.set(p, name);
  return name;
}

function mapped(id) {
  const r = run('xwininfo', ['-id', id], 8000);
  if (!r.ok) return null;
  const m = r.out.match(/Map State:\s*(\S+)/);
  return m ? m[1] : null;
}

/**
 * Visible, real top-level windows, front to back:
 * [{ hwnd, title, pid, app, own, minimised }]. The same fields win-input.js returns.
 */
function listWindows(ownPid = process.pid) {
  const out = [];
  for (const c of rawChildren()) {
    // Helper windows are tiny; compositor furniture has no pid, title or class.
    if (c.w < 120 || c.h < 80) continue;
    if (['Default IME', 'Input', 'Xalia event window', 'QTrayIconMessageWindow'].includes(c.title)) continue;
    const pid = pidOf(c.id);
    if (!pid && !c.title && !c.cls) continue;
    const state = mapped(c.id);
    if (state === null) continue;
    // Do NOT require IsViewable: a minimised window is IsUnMapped and must still be
    // listed (Windows does the same via IsIconic), otherwise a minimised game or
    // launcher would vanish from the list entirely.
    out.push({
      hwnd: parseInt(c.id, 16),
      id: c.id,
      title: c.title || '(untitled)',
      pid,
      app: processName(pid) || c.cls.split(/\s+/)[0] || '',
      own: pid === ownPid,
      minimised: state !== 'IsViewable',
      x: c.x, y: c.y, w: c.w, h: c.h,
    });
  }
  // Front to back, and anything actually on screen first.
  out.reverse();
  out.sort((a, b) => Number(a.minimised) - Number(b.minimised));
  return out;
}

/** The window as drawn on screen, in pixels. */
function windowRect(hwnd) {
  const id = idOf(hwnd);
  const r = run('xdotool', ['getwindowgeometry', '--shell', id], 10000);
  if (!r.ok) return null;
  const g = {};
  for (const line of r.out.split('\n')) {
    const m = line.match(/^([A-Z]+)=(-?\d+)$/);
    if (m) g[m[1]] = parseInt(m[2], 10);
  }
  if (g.WIDTH === undefined) return null;
  return { x: g.X, y: g.Y, w: g.WIDTH, h: g.HEIGHT };
}

const foreground = () => {
  const r = run('xdotool', ['getactivewindow'], 8000);
  return r.ok ? parseInt(r.out.trim(), 10) || 0 : 0;
};

const isWindow = (hwnd) => run('xwininfo', ['-id', idOf(hwnd)], 8000).ok;

/**
 * The top-level window on top at a screen point. Approximate on Linux: there is no
 * WindowFromPoint, so the last match in stacking order wins.
 */
function windowAt(x, y) {
  if (!onScreen(x, y)) return null;
  const list = listWindows();          // already front to back
  for (const w of list) {
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) {
      return { hwnd: w.hwnd, title: w.title, className: w.app, app: w.app };
    }
  }
  // Fall back to what the pointer is over, if X will say.
  const r = run('xdotool', ['getmouselocation', '--shell'], 8000);
  if (r.ok) {
    const m = r.out.match(/WINDOW=(\d+)/);
    if (m) {
      const hwnd = parseInt(m[1], 10);
      const w = list.find((v) => v.hwnd === hwnd);
      if (w) return { hwnd, title: w.title, className: w.app, app: w.app };
    }
  }
  return null;
}

let screenSize;
function rootSize() {
  if (screenSize) return screenSize;
  const r = run('xwininfo', ['-root'], 10000);
  const w = r.out.match(/Width:\s*(\d+)/);
  const h = r.out.match(/Height:\s*(\d+)/);
  screenSize = (r.ok && w && h) ? { w: parseInt(w[1], 10), h: parseInt(h[1], 10) } : { w: 0, h: 0 };
  return screenSize;
}

/** Off the root window, a point cannot be clicked. */
function onScreen(x, y) {
  const s = rootSize();
  if (!s.w || !s.h) return true;      // cannot tell: do not block
  return x >= 0 && y >= 0 && x < s.w && y < s.h;
}

// ---- pointer and keyboard ---------------------------------------------------

const idOf = (hwnd) => (typeof hwnd === 'string' && /^0x/.test(hwnd))
  ? hwnd : '0x' + Number(hwnd).toString(16);

function cursor() {
  const r = run('xdotool', ['getmouselocation', '--shell'], 8000);
  if (!r.ok) return { x: 0, y: 0 };
  const g = {};
  for (const line of r.out.split('\n')) {
    const m = line.match(/^([A-Z]+)=(-?\d+)$/);
    if (m) g[m[1]] = parseInt(m[2], 10);
  }
  return { x: g.X || 0, y: g.Y || 0 };
}

/** Put the pointer on a point, and make sure it is there. */
function pointAt(x, y) {
  const px = Math.round(x), py = Math.round(y);
  if (!onScreen(px, py)) throw new Error(`(${px}, ${py}) is not on the screen, so the pointer cannot go there`);
  const r = run('xdotool', ['mousemove', '--sync', String(px), String(py)], 15000);
  if (!r.ok) throw new Error(r.err || `the pointer would not go to (${px}, ${py})`);
  const c = cursor();
  if (Math.abs(c.x - px) > 2 || Math.abs(c.y - py) > 2) {
    throw new Error(`the pointer would not go to (${px}, ${py}) (it is at ${c.x}, ${c.y}), so nothing was clicked`);
  }
}

async function click(x, y, { button = 'left', double = false } = {}) {
  pointAt(x, y);
  await sleep(40);
  const b = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  const args = ['click', '--repeat', double ? '2' : '1', '--delay', '60', b];
  const r = run('xdotool', args, 20000);
  if (!r.ok) throw new Error(r.err || 'the click did not go through');
}

/** Scroll at a screen point; positive notches scroll down. */
async function scroll(x, y, notches) {
  if (!Number(notches)) return;
  if (x >= 0 && y >= 0) pointAt(x, y);
  await sleep(30);
  const button = Number(notches) > 0 ? '5' : '4';
  const n = Math.min(20, Math.abs(Math.round(Number(notches))));
  const r = run('xdotool', ['click', '--repeat', String(n), '--delay', '40', button], 20000);
  if (!r.ok) throw new Error(r.err || 'the scroll did not go through');
}

/** xdotool keysym names for the keys win-input.js maps to virtual codes. */
const KEYSYM = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', menu: 'alt',
  enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape',
  space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  capslock: 'Caps_Lock', printscreen: 'Print',
};
for (let i = 1; i <= 12; i++) KEYSYM[`f${i}`] = `F${i}`;
const BLOCKED = new Set(['win', 'windows', 'meta', 'super', 'cmd', 'command', 'lwin', 'rwin']);

/**
 * Press a combination, e.g. "ctrl+shift+s". Windows-key combinations are refused for the
 * same reason as on Windows: with Super held and typing, "control the keyboard" would
 * quietly become "run anything".
 */
async function pressKeys(combo) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no keys given');
  const names = parts.map((p) => {
    if (BLOCKED.has(p)) throw new Error('the Super/Windows key is not allowed');
    const k = KEYSYM[p] || (/^[a-z0-9]$/.test(p) ? p : null);
    if (!k) throw new Error(`unknown key "${p}"`);
    return k;
  });
  const r = run('xdotool', ['key', '--clearmodifiers', names.join('+')], 15000);
  if (!r.ok) throw new Error(r.err || `could not press ${combo}`);
}

/** Type text into whatever has keyboard focus. xdotool sends Unicode directly. */
async function typeText(text, { stop } = {}) {
  const s = String(text);
  if (!s) return;
  for (const chunk of s.split('\n')) {
    if (stop && stop()) throw new Error('stopped');
    if (chunk) {
      const r = run('xdotool', ['type', '--clearmodifiers', '--delay', '12', chunk], 60000);
      if (!r.ok) throw new Error(r.err || 'the text did not go through');
      await sleep(8);
    }
  }
  if (s.endsWith('\n')) await pressKeys('enter');
}

// ---- focus ------------------------------------------------------------------

/** Bring a window to the front, and say whether it got there. */
async function focusWindow(hwnd) {
  const id = idOf(hwnd);
  run('xdotool', ['windowmap', '--sync', id], 10000);        // bring a minimised one back
  run('xdotool', ['windowactivate', '--sync', id], 15000);
  await sleep(120);
  if (foreground() === Number(hwnd)) return true;
  run('xdotool', ['windowfocus', '--sync', id], 15000);
  await sleep(80);
  return foreground() === Number(hwnd);
}

/** Show a minimised window where it was, without taking the focus. */
function restoreQuietly(hwnd) {
  const id = idOf(hwnd);
  if (mapped(id) === 'IsUnviewable' || mapped(id) === 'IsUnMapped') run('xdotool', ['windowmap', id], 10000);
}

module.exports = {
  available, listWindows, windowRect, windowAt, foreground, isWindow, onScreen,
  cursor, click, scroll, typeText, pressKeys, focusWindow, restoreQuietly, processName,
};
