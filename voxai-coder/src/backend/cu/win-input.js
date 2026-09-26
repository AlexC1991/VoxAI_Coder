/**
 * win-input.js — the desktop agent's hands on Windows: keyboard, mouse and window focus through
 * SendInput, in-process via koffi. Ported from Byte (Desktop3D, src/main/input.js).
 *
 * The old native path typed with WScript SendKeys, which reads + ^ % ~ ( ) { } as shortcut keys ("a+b"
 * pressed Shift), and had no way to bring a window to the front, so keys went to whatever had focus --
 * usually VoxAI itself. Typing here is Unicode (any language, any character, exactly as given).
 *
 * Windows-key combinations are refused: with Win+R and typing, "control the keyboard" would quietly
 * become "run anything". `parseKeys` is pure (tested); everything else needs Windows.
 */

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, menu: 0x12,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, arrowup: 0x26, arrowdown: 0x28, arrowleft: 0x25, arrowright: 0x27,
  capslock: 0x14, printscreen: 0x2c,
};
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;
const EXTENDED = new Set([0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27]);
const BLOCKED = new Set(['win', 'windows', 'meta', 'super', 'cmd', 'command', 'lwin', 'rwin']);

/** "ctrl+shift+s" -> [{vk, extended}], or throws with a reason the model can read. */
function parseKeys(combo) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no keys given');
  return parts.map((p) => {
    if (BLOCKED.has(p)) throw new Error('Windows-key shortcuts are not allowed');
    let vk = VK[p];
    if (vk === undefined && /^[a-z0-9]$/.test(p)) vk = p.toUpperCase().charCodeAt(0);
    if (vk === undefined) throw new Error(`unknown key "${p}"`);
    return { vk, extended: EXTENDED.has(vk) };
  });
}

// -- Windows ------------------------------------------------------------------------------
let api;
function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const MOUSEINPUT = koffi.struct('VOX_MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('VOX_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32',
    dwExtraInfo: 'uintptr_t' });
  const HARDWAREINPUT = koffi.struct('VOX_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_U = koffi.union('VOX_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('VOX_INPUT', { type: 'uint32', u: INPUT_U });
  koffi.struct('VOX_POINT', { x: 'int32', y: 'int32' });
  koffi.struct('VOX_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const EnumProc = koffi.proto('int __stdcall VOX_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  api = {
    koffi, INPUT, EnumProc,
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 n, VOX_INPUT *inputs, int size)'),
    SetCursorPos: user32.func('int __stdcall SetCursorPos(int x, int y)'),
    GetCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ VOX_POINT *p)'),
    SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    ShowWindow: user32.func('int __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
    IsWindow: user32.func('int __stdcall IsWindow(intptr_t hwnd)'),
    IsIconic: user32.func('int __stdcall IsIconic(intptr_t hwnd)'),
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, uint8_t *buf, int n)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32 cmd)'),
    GetWindowRect: user32.func('int __stdcall GetWindowRect(intptr_t hwnd, _Out_ VOX_RECT *rect)'),
    EnumWindows: user32.func('int __stdcall EnumWindows(VOX_EnumWindowsProc *proc, intptr_t lParam)'),
    DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ int32 *value, uint32 size)'),
    DwmGetFrame: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ VOX_RECT *value, uint32 size)'),
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(VOX_POINT pt)'),
    MonitorFromPoint: user32.func('intptr_t __stdcall MonitorFromPoint(VOX_POINT pt, uint32 flags)'),
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32 flags)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, uint8_t *buf, int n)'),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(intptr_t h)'),
    QueryFullProcessImageNameW: kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, uint8_t *buf, _Inout_ uint32 *size)'),
  };
  return api;
}

const available = () => { try { return Boolean(load()); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INPUT_SIZE = 40;   // sizeof(INPUT) on x64
const KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;

function send(input) {
  const a = load();
  if (a.SendInput(1, input, a.koffi.sizeof(a.INPUT) || INPUT_SIZE) !== 1) throw new Error('Windows blocked the input (is an administrator window in front?)');
}

const key = (vk, up, extended = false) => ({ type: 1, u: { ki: { wVk: vk, wScan: 0,
  dwFlags: (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0), time: 0, dwExtraInfo: 0 } } });

async function pressKeys(combo) {
  const keys = parseKeys(combo);
  for (const k of keys) { send(key(k.vk, false, k.extended)); await sleep(15); }
  for (const k of [...keys].reverse()) { send(key(k.vk, true, k.extended)); await sleep(15); }
}

/** Type text into whatever has keyboard focus (Unicode, so any language and any character works). */
async function typeText(text, { stop } = {}) {
  for (const ch of String(text)) {
    if (stop && stop()) throw new Error('stopped');
    if (ch === '\n') { await pressKeys('enter'); continue; }
    if (ch === '\r') continue;
    for (let i = 0; i < ch.length; i++) {
      const code = ch.charCodeAt(i);
      send({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } });
      send({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } });
    }
    await sleep(8);
  }
}

const mouse = (flags, data = 0) => ({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });

/**
 * Put the pointer on a screen point, and make sure it is there. Windows does not move it to a point
 * off every screen (and can refuse for other reasons), and a click sent anyway lands wherever the
 * pointer happens to be -- in a test, on another app on another screen.
 */
function pointAt(x, y) {
  const a = load();
  const px = Math.round(x), py = Math.round(y);
  if (!onScreen(px, py)) throw new Error(`(${px}, ${py}) is not on any screen, so the pointer cannot go there`);
  a.SetCursorPos(px, py);
  const c = cursor();
  if (Math.abs(c.x - px) > 1 || Math.abs(c.y - py) > 1) throw new Error(`the pointer would not go to (${px}, ${py}) (it is at ${c.x}, ${c.y}), so nothing was clicked`);
}
const onScreen = (x, y) => Boolean(Number(load().MonitorFromPoint({ x: Math.round(x), y: Math.round(y) }, 0)));   // MONITOR_DEFAULTTONULL

/** Click at a physical screen point. */
async function click(x, y, { button = 'left', double = false } = {}) {
  pointAt(x, y);
  await sleep(40);
  const [down, up] = button === 'right' ? [0x0008, 0x0010] : [0x0002, 0x0004];
  for (let i = 0; i < (double ? 2 : 1); i++) {
    send(mouse(down));
    await sleep(30);
    send(mouse(up));
    await sleep(60);
  }
}

/** Scroll the wheel at a physical screen point; positive notches scroll down. */
async function scroll(x, y, notches) {
  pointAt(x, y);
  await sleep(30);
  send(mouse(0x0800, Math.round(-notches * 120)));
}

function cursor() {
  const a = load();
  const p = {};
  a.GetCursorPos(p);
  return { x: p.x, y: p.y };
}

/** Bring a window to the front. The Alt tap lets a background app take the foreground. */
async function focusWindow(hwnd) {
  const a = load();
  if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, 9);   // SW_RESTORE
  if (Number(a.GetForegroundWindow()) === hwnd) return true;
  send(key(0x12, false));
  send(key(0x12, true));
  a.SetForegroundWindow(hwnd);
  await sleep(120);
  return Number(a.GetForegroundWindow()) === hwnd;
}

/** Show a minimised window where it was, without taking the focus. */
function restoreQuietly(hwnd) { const a = load(); if (a.IsIconic(hwnd)) a.ShowWindow(hwnd, 4); }   // SW_SHOWNOACTIVATE

const exeNames = new Map();
/** The program behind a process: "notepad.exe". */
function processName(pid) {
  if (exeNames.has(pid)) return exeNames.get(pid);
  const a = load();
  let name = '';
  const h = a.OpenProcess(0x1000, 0, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
  if (h) {
    try {
      const buf = Buffer.alloc(2048);
      const size = [1024];
      if (a.QueryFullProcessImageNameW(h, 0, buf, size)) name = buf.toString('utf16le', 0, size[0] * 2).split('\\').pop();
    } finally { a.CloseHandle(h); }
  }
  exeNames.set(pid, name);
  return name;
}

/** The window as drawn on screen (without the invisible resize border), in physical pixels. */
function windowRect(hwnd) {
  const a = load();
  const r = {};
  if (a.DwmGetFrame(hwnd, 9, r, 16) !== 0 && !a.GetWindowRect(hwnd, r)) return null;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

/** Visible, titled, real top-level windows, front to back: [{hwnd, title, pid, app, minimised}]. */
function listWindows(ownPid = process.pid) {
  const a = load();
  const out = [];
  const cb = a.koffi.register((hwnd) => {
    hwnd = Number(hwnd);
    if (!a.IsWindowVisible(hwnd)) return 1;
    const exStyle = Number(a.GetWindowLongPtrW(hwnd, -20));
    if (exStyle & 0x80) return 1;                       // WS_EX_TOOLWINDOW
    if (Number(a.GetWindow(hwnd, 4))) return 1;         // owned popups
    const cloaked = [0];
    if (a.DwmGetWindowAttribute(hwnd, 14, cloaked, 4) === 0 && cloaked[0]) return 1;   // hidden Store-app shells
    const buf = Buffer.alloc(1024);
    const n = a.GetWindowTextW(hwnd, buf, 512);
    if (n <= 0) return 1;
    const pid = [0];
    a.GetWindowThreadProcessId(hwnd, pid);
    const title = buf.toString('utf16le', 0, n * 2);
    const app = processName(pid[0]);
    if (app.toLowerCase() === 'explorer.exe' && title === 'Program Manager') return 1;   // the desktop itself
    out.push({ hwnd, title, pid: pid[0], app, own: pid[0] === ownPid, minimised: Boolean(a.IsIconic(hwnd)) });
    return 1;
  }, a.koffi.pointer(a.EnumProc));
  try { a.EnumWindows(cb, 0); } finally { a.koffi.unregister(cb); }
  return out;
}

/**
 * The top-level window that is really on top at a screen point, and what it is: a real click goes
 * there, whatever a window's own picture (captured even when covered) shows. { hwnd, title, className, app }.
 */
function windowAt(x, y) {
  const a = load();
  // Off every screen, a window can still "cover" the point (it extends past the edge): nothing is there.
  if (!onScreen(x, y)) return null;
  const child = Number(a.WindowFromPoint({ x: Math.round(x), y: Math.round(y) }));
  if (!child) return null;
  const hwnd = Number(a.GetAncestor(child, 2)) || child;   // GA_ROOT
  const t = Buffer.alloc(1024), c = Buffer.alloc(512);
  const tn = a.GetWindowTextW(hwnd, t, 512), cn = a.GetClassNameW(hwnd, c, 256);
  const pid = [0];
  a.GetWindowThreadProcessId(hwnd, pid);
  return { hwnd, title: tn > 0 ? t.toString('utf16le', 0, tn * 2) : '', className: cn > 0 ? c.toString('utf16le', 0, cn * 2) : '', app: processName(pid[0]) };
}

const foreground = () => Number(load().GetForegroundWindow());
const isWindow = (hwnd) => Boolean(load().IsWindow(hwnd));

module.exports = { parseKeys, available, pressKeys, typeText, click, scroll, cursor, focusWindow, restoreQuietly, processName,
  windowRect, listWindows, foreground, isWindow, windowAt, onScreen };
