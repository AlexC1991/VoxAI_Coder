/**
 * desktop.js — computer use on the Windows desktop (the `computer` tool with backend "native").
 * Ported from Byte (Desktop3D): a window is named, its controls are listed by UI Automation with ids,
 * and the agent presses and types into controls by id rather than guessing pixels. Real keyboard and
 * mouse go through SendInput (win-input.js), after bringing that window to the front.
 *
 * What it replaced: reading and clicking always went to whatever window was in front (VoxAI itself,
 * while you chat), typing went through SendKeys (which read + ^ % ~ ( ) { } as shortcut keys), and
 * there was no way to bring a window forward.
 *
 * Safety, as in Byte: every acting call names its window and control for the approval prompt (agent.js,
 * desktopGate); moving the mouse yourself stops it; Esc stops the run (main.js arms it while this is in
 * use); Windows-key shortcuts are refused; password boxes are never read or typed into; password
 * managers and private browser windows are never looked into.
 */
const input = require('./win-input');
const native = require('./native');
const { UiaHelper } = require('./uia');

const uia = new UiaHelper();
const MOVED_PX = 40;
const MAX_TEXT = 8000;
const MENU_MS = 450;
const SETTLE_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Apps whose windows are never looked into, and window titles that mean "private" (from Byte's privacy.js).
const PRIVATE_APPS = new Set(['1password.exe', 'bitwarden.exe', 'keepass.exe', 'keepassxc.exe', 'lastpass.exe',
  'dashlane.exe', 'enpass.exe', 'nordpass.exe', 'proton pass.exe', 'keeper.exe']);
const PRIVATE_TITLES = ['inprivate', 'incognito', 'private browsing', '- private', 'password manager'];
function privacyBlock(w) {
  if (!w) return null;
  if (PRIVATE_APPS.has(String(w.app || '').toLowerCase())) return `${appName(w)} is a password manager`;
  const t = String(w.title || '').toLowerCase();
  return PRIVATE_TITLES.some((p) => t.includes(p)) ? 'that is a private browsing window' : null;
}
const appName = (w) => String((w && w.app) || '').replace(/\.exe$/i, '') || 'the app';

// Per session: the window being worked in, its listed controls, the last picture, where the mouse was left.
const states = new Map();
function stateFor(ctx) {
  const id = (ctx && ctx.session && ctx.session.id) || 'default';
  let s = states.get(id);
  if (!s) { s = { target: null, elements: new Map(), listHwnd: null, capture: null, cursorAt: null, stopped: false, signal: null }; states.set(id, s); }
  // A new run starts fresh on stopping (Esc, a moved mouse); the window and its controls are kept.
  const sig = ctx && ctx.signal;
  if (sig && s.signal !== sig) { s.signal = sig; s.stopped = false; s.cursorAt = null; }
  return s;
}

const visibleWindows = () => input.listWindows().filter((w) => !w.own);

/** A window by title or app name: exact title, then part of a title, then the app ("notepad"). */
function findWindow(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const ws = visibleWindows();
  const app = (w) => String(w.app || '').toLowerCase().replace(/\.exe$/, '');
  return ws.find((w) => w.title.toLowerCase() === q) || ws.find((w) => w.title.toLowerCase().includes(q))
    || ws.find((w) => app(w) === q.replace(/\.exe$/, '')) || ws.find((w) => app(w).includes(q)) || null;
}
const openList = () => visibleWindows().filter((w) => !w.minimised).slice(0, 12).map((w) => `"${w.title}" (${appName(w)})`).join(', ');

/** The window this call is about: `window` if given (and remembered), else the one worked in last. */
function resolveTarget(s, args, { allowPrivate = false } = {}) {
  let w = null;
  if (args && args.window) {
    w = findWindow(args.window);
    if (!w) throw new Error(`No open window matches "${String(args.window).slice(0, 60)}". Open windows: ${openList()}`);
  } else if (s.target && input.isWindow(s.target)) {
    w = visibleWindows().find((x) => x.hwnd === s.target) || null;
  }
  if (!w) throw new Error(`Say which window: window: "Notepad" (part of its title or the app name). Open windows: ${openList()}`);
  const why = privacyBlock(w);
  if (why && !allowPrivate) throw new Error(`I don't look into or control that window: ${why}.`);
  if (s.target !== w.hwnd) { s.target = w.hwnd; }
  return w;
}

/** Stop if the user took the mouse since the last action (not when they have just clicked Allow). */
function guard(s, ctx) {
  if (s.stopped || (ctx && ctx.signal && ctx.signal.aborted)) throw new Error('stopped by the user');
  if (ctx && ctx.callApproved) { s.cursorAt = null; return; }   // answering the prompt moved the mouse
  if (s.cursorAt) {
    const c = input.cursor();
    if (Math.hypot(c.x - s.cursorAt.x, c.y - s.cursorAt.y) > MOVED_PX) {
      s.stopped = true;
      throw new Error('The user moved the mouse, so desktop control stopped. Stop here and ask them what they want to do next.');
    }
  }
}
const settle = (s) => { try { s.cursorAt = input.cursor(); } catch { /* no cursor */ } };
const busy = (ctx) => { try { if (ctx && typeof ctx.emit === 'function') ctx.emit({ type: 'desktop_control' }); } catch { /* the UI's problem */ } };
const stopFn = (s, ctx) => () => s.stopped || Boolean(ctx && ctx.signal && ctx.signal.aborted);

/** How the model's copy of a picture relates to the screen: images are fitted inside 2560 x 1600 (agent.js). */
const fitScale = (w, h) => Math.min(1, 2560 / Math.max(1, w), 1600 / Math.max(1, h));
function recordCapture(s, shot) {
  if (shot && shot.ok && Number.isFinite(shot.x) && shot.w > 0) s.capture = { x: shot.x, y: shot.y, w: shot.w, h: shot.h, k: fitScale(shot.w, shot.h) };
}
function imagePoint(s, sx, sy) {
  const c = s.capture;
  if (!c || sx < c.x || sy < c.y || sx > c.x + c.w || sy > c.y + c.h) return null;
  return { x: Math.round((sx - c.x) * c.k), y: Math.round((sy - c.y) * c.k) };
}
function screenPoint(s, ix, iy) {
  const c = s.capture;
  if (!c) throw new Error('take a screenshot (or state) first: x and y are pixels in the latest picture');
  const x = Number(ix), y = Number(iy);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > c.w * c.k || y > c.h * c.k) throw new Error('that point is outside the latest picture');
  return { x: Math.round(c.x + x / c.k), y: Math.round(c.y + y / c.k) };
}

const centre = (e) => [e.rect[0] + e.rect[2] / 2, e.rect[1] + e.rect[3] / 2];
function remember(s, hwnd, elements) {   // ids are stable within one window, so later lists add to earlier ones
  if (s.listHwnd !== hwnd) s.elements = new Map();
  s.listHwnd = hwnd;
  for (const e of elements) s.elements.set(e.id, e);
}
function describeAll(s, elements) {
  return elements.map((e) => {
    const [cx, cy] = centre(e);
    const at = imagePoint(s, cx, cy);
    return `[${e.id}] ${e.type} "${e.name}"${e.value ? ` = "${e.value}"` : ''}${e.focused ? ' (focused)' : ''}`
      + `${e.enabled ? '' : ' (disabled)'}${e.password ? ' (password box: the user types it)' : ''}${at ? ` at ${at.x},${at.y}` : ''}`;
  }).join('\n');
}
function elementFor(s, index) {
  if (index === undefined || index === null || index === '') throw new Error('this needs a control number: call state (with window) first, then use its [number]');
  const e = s.elements.get(Number(index));
  if (!e) throw new Error(`there is no [${index}]: call state for that window again`);
  return e;
}

/** A fresh picture of the window, and which control has the keyboard now: what the agent checks after acting. */
async function after(s, ctx, w, did) {
  await sleep(SETTLE_MS);
  settle(s);
  let focused = '';
  try { const f = await uia.focused(); if (f && f.type) focused = `${f.type} "${f.name || ''}"`; } catch { /* no helper */ }
  const shot = native.screenshot({ hwnd: w.hwnd });
  recordCapture(s, shot);
  return {
    backend: 'native', ok: true, did, window: { title: w.title, app: appName(w) },
    ...(focused ? { keyboardFocus: focused } : {}),
    screenshot: shot.ok ? shot.dataUrl : null,
    next: 'Check the picture (or call state again) before the next step.',
  };
}

async function focusOn(w) {
  if (!(await input.focusWindow(w.hwnd))) throw new Error(`Windows would not bring "${w.title}" to the front: ask the user to click it once, then try again`);
}

// ---- the actions --------------------------------------------------------------------------------

function list() {
  const ws = visibleWindows();
  return { backend: 'native', surface: 'native', windows: ws.slice(0, 40).map((w) => ({ title: w.title, app: appName(w), ...(w.minimised ? { minimised: true } : {}), ...(privacyBlock(w) ? { private: true } : {}) })),
    how: 'Name one with `window` (part of its title or the app name) in state, click, type, press, scroll or focus.' };
}

async function focus(args, ctx) {
  const s = stateFor(ctx);
  guard(s, ctx);
  const w = resolveTarget(s, args);
  busy(ctx);
  await focusOn(w);
  return after(s, ctx, w, `"${w.title}" is in front`);
}

async function state(args, ctx) {
  const s = stateFor(ctx);
  const w = resolveTarget(s, args);
  if (w.minimised) { input.restoreQuietly(w.hwnd); await sleep(400); }
  const shot = native.screenshot({ hwnd: w.hwnd });
  recordCapture(s, shot);
  let controls = '', count = 0, complete = true, note = '';
  if (uia.available) {
    try {
      const r = await uia.list(w.hwnd, String((args && args.find) || '').slice(0, 40), 80);
      remember(s, w.hwnd, r.elements || []);
      count = (r.elements || []).length;
      complete = r.complete !== false;
      controls = count ? describeAll(s, r.elements) : `no controls${args && args.find ? ` matching "${args.find}"` : ''} found: use the picture and x/y`;
    } catch (e) { note = `The control list failed (${e.message}): use the picture and x/y.`; }
  } else note = 'The control list is not available on this computer: use the picture and x/y.';
  return {
    backend: 'native', surface: 'native', window: { title: w.title, app: appName(w) },
    controls, elementCount: count, ...(complete ? {} : { more: 'there are more: use find to narrow the list' }),
    ...(note ? { note } : {}),
    screenshot: shot.ok ? shot.dataUrl : null,
    how: 'Act on a control by its [number] (index): click, type (with index to type into it). x and y, when needed, are pixels in this picture.',
  };
}

async function click(args, ctx) {
  const s = stateFor(ctx);
  guard(s, ctx);
  const w = resolveTarget(s, args);
  busy(ctx);
  const right = String(args.button || args.mouse_button || '').toLowerCase() === 'right';
  const double = Boolean(args.double) || Number(args.click_count) === 2;
  if (args.index !== undefined && args.index !== null) {
    const e = elementFor(s, args.index);
    if (right) {
      await focusOn(w);
      const [x, y] = centre(e);
      await input.click(x, y, { button: 'right' });
      await sleep(MENU_MS);
      let menu = [];
      try { const r = await uia.list(s.listHwnd || w.hwnd, '', 40, 'menu'); menu = r.elements || []; remember(s, s.listHwnd || w.hwnd, menu); } catch { /* none */ }
      const res = await after(s, ctx, w, `right-clicked [${e.id}] ${e.type} "${e.name}"`);
      res.menu = menu.length ? describeAll(s, menu) : 'no menu showed up in the control list (look at the picture)';
      return res;
    }
    if (double) {
      await focusOn(w);
      const [x, y] = centre(e);
      await input.click(x, y, { double: true });
      return after(s, ctx, w, `double-clicked [${e.id}] ${e.type} "${e.name}"`);
    }
    const r = await uia.act(e.id, 'invoke');
    if (r.click) {
      await focusOn(w);
      await input.click(r.click[0], r.click[1]);
    }
    return after(s, ctx, w, `${r.click ? 'clicked' : r.done === 'invoke' ? 'pressed' : r.done} [${e.id}] ${e.type} "${e.name}"`);
  }
  if (args.x === undefined || args.y === undefined) throw new Error('click needs index (a control from state) or x and y (pixels in the latest picture)');
  const p = screenPoint(s, args.x, args.y);
  await focusOn(w);
  await input.click(p.x, p.y, { button: right ? 'right' : 'left', double });
  return after(s, ctx, w, `${double ? 'double-' : ''}${right ? 'right-' : ''}clicked at (${args.x}, ${args.y})`);
}

async function type(args, ctx) {
  const s = stateFor(ctx);
  guard(s, ctx);
  const w = resolveTarget(s, args);
  const t = String(args.text == null ? '' : args.text).slice(0, MAX_TEXT);
  busy(ctx);
  if (args.index !== undefined && args.index !== null) {
    const e = elementFor(s, args.index);
    if (e.password) throw new Error('that is a password box: the user types passwords themselves');
    await focusOn(w);   // its window in front first: the keystrokes must go there, not to VoxAI
    const r = await uia.act(e.id, 'set_text', t);
    if (r.click) await input.click(r.click[0], r.click[1]);
    if (r.type || r.click) await input.typeText(t, { stop: stopFn(s, ctx) });
    return after(s, ctx, w, `typed ${t.length} characters into [${e.id}] ${e.type} "${e.name}"`);
  }
  await focusOn(w);
  let f = null;
  try { f = await uia.focused(); } catch { /* no helper */ }
  if (f && f.password) throw new Error('the focused box is a password box: the user types passwords themselves');
  await input.typeText(t, { stop: stopFn(s, ctx) });
  return after(s, ctx, w, `typed ${t.length} characters into ${f && f.type ? `${f.type} "${f.name || ''}"` : 'the focused control'}`);
}

async function press(args, ctx) {
  const s = stateFor(ctx);
  guard(s, ctx);
  const w = resolveTarget(s, args);
  input.parseKeys(String(args.key || ''));   // refuse Windows-key shortcuts before touching anything
  busy(ctx);
  await focusOn(w);
  await input.pressKeys(String(args.key));
  return after(s, ctx, w, `pressed ${args.key}`);
}

async function scroll(args, ctx) {
  const s = stateFor(ctx);
  guard(s, ctx);
  const w = resolveTarget(s, args);
  busy(ctx);
  let x, y;
  if (args.index !== undefined && args.index !== null) [x, y] = centre(elementFor(s, args.index));
  else if (args.x !== undefined && args.y !== undefined) ({ x, y } = screenPoint(s, args.x, args.y));
  else { const r = input.windowRect(w.hwnd); if (!r) throw new Error('that window has no size'); x = r.x + r.w / 2; y = r.y + r.h / 2; }
  const raw = Number(args.dy || args.dx || 3);
  const notches = Math.max(-20, Math.min(20, Math.abs(raw) > 20 ? Math.round(raw / 120) || Math.sign(raw) : raw));
  await focusOn(w);
  await input.scroll(x, y, notches);
  return after(s, ctx, w, `scrolled ${notches > 0 ? 'down' : 'up'} ${Math.abs(notches)}`);
}

/** A native screenshot: remembered as the picture x/y refer to. */
function screenshot(args, ctx) {
  const s = stateFor(ctx);
  const one = !!(args && (args.window || args.hwnd || args.pid));
  if (one && args.window) {
    const w = findWindow(args.window);
    const why = privacyBlock(w);
    if (why) return { ok: false, error: `I don't look into that window: ${why}.` };
    if (w) s.target = w.hwnd;
  }
  const shot = native.screenshot(one ? { window: args.window, hwnd: args.hwnd, pid: args.pid } : 0);
  if (shot.ok) recordCapture(s, shot);
  return shot;
}

/**
 * What an acting call would do, in words, for its approval ("Type "hello" into "Text editor" in Notepad"),
 * and the app its "Always" covers. Null when this is not a desktop action.
 */
function describe(sessionId, act, a) {
  if (!['click', 'type', 'press', 'scroll', 'focus'].includes(act)) return null;
  const s = states.get(sessionId) || { elements: new Map() };
  let w = null;
  try { w = a.window ? findWindow(a.window) : (s.target ? visibleWindows().find((x) => x.hwnd === s.target) : null); } catch { w = null; }
  const where = w ? ` in ${appName(w)}${w.title && w.title.toLowerCase() !== appName(w).toLowerCase() ? ` ("${w.title.slice(0, 60)}")` : ''}` : (a.window ? ` in "${a.window}"` : '');
  const e = a.index !== undefined && a.index !== null ? s.elements.get(Number(a.index)) : null;
  const ctl = e ? ` "${e.name || e.type}"` : (a.index !== undefined && a.index !== null ? ` control [${a.index}]` : '');
  const right = String(a.button || a.mouse_button || '').toLowerCase() === 'right';
  const target = act === 'click' ? `${a.double || Number(a.click_count) === 2 ? 'Double-click' : right ? 'Right-click' : 'Click'}${ctl || (a.x !== undefined ? ` at (${a.x}, ${a.y})` : '')}${where}`
    : act === 'type' ? `Type "${String(a.text || '').slice(0, 80)}"${ctl ? ` into${ctl}` : ''}${where}`
      : act === 'press' ? `Press ${String(a.key || '')}${where}`
        : act === 'scroll' ? `Scroll ${Number(a.dy || a.dx || 3) < 0 ? 'up' : 'down'}${where}`
          : `Bring ${w ? appName(w) : `"${a.window || 'the window'}"`} to the front`;
  const app = w ? appName(w) : String(a.window || 'this app');
  return { target, alwaysKey: 'app:' + app.toLowerCase(), alwaysLabel: `Always for ${app}` };
}

module.exports = { list, focus, state, click, type, press, scroll, screenshot, describe, privacyBlock, findWindow, fitScale, uia, _states: states };
