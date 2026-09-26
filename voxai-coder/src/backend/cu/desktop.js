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
// Set by main.js, which owns the Esc kill switch.
const escHooks = { suspend: () => {}, resume: () => {} };
function setEscHooks(h) { if (h && typeof h.suspend === 'function' && typeof h.resume === 'function') Object.assign(escHooks, h); }
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
// A Store app's window belongs to Windows' host (ApplicationFrameHost): name it by its title instead.
const appName = (w) => {
  const exe = String((w && w.app) || '').replace(/\.exe$/i, '');
  if (/^applicationframehost$/i.test(exe) && w && w.title) return String(w.title).split(' - ').pop().slice(0, 40);
  return exe || 'the app';
};

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
// includeOwn: VoxAI Coder's own windows too -- for a picture only. Acting on them stays out:
// the agent clicking its own interface could approve its own requests.
function findWindow(query, { includeOwn = false } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const ws = includeOwn ? input.listWindows() : visibleWindows();
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

/**
 * Stop if the user has moved the mouse since the agent last knew where it was. That point is taken
 * once, and moved only when the agent itself moves the pointer (leftAt), as Byte does. It used to be
 * re-read at the end of every step, so a move made while a step was running (most of the time: a step
 * takes a second or two) became the new starting point and was never noticed.
 */
function guard(s, ctx) {
  if (ctx && ctx.signal && ctx.signal.aborted) throw new Error('stopped by the user');
  if (s.stopped) throw new Error('Desktop control is paused because the user moved the mouse. Ask them (ask_user) whether to carry on; once they have answered, you can continue.');
  let now = null;
  try { now = input.cursor(); } catch { return; }
  // Answering a prompt moved the mouse: not the user taking over, so start again from here. Only a
  // prompt they answered counts -- "Always for <app>" allows the call too, and treating that the same
  // switched this check off for good.
  if ((ctx && ctx.userAnswered) || !s.cursorAt) { s.cursorAt = now; return; }
  if (Math.hypot(now.x - s.cursorAt.x, now.y - s.cursorAt.y) > MOVED_PX) {
    s.stopped = true;
    throw new Error('The user moved the mouse, so desktop control stopped. Stop and ask them (ask_user) whether to carry on; once they have answered, you can continue.');
  }
}
/** Where the agent itself just put the pointer: the only moves that are not the user's. */
const leftAt = (s, x, y) => { s.cursorAt = { x: Math.round(x), y: Math.round(y) }; };
// 'start' before an action touches the keyboard or mouse, 'end' once it is done: main.js holds Esc as
// the stop key in between and for a few seconds after.
const busy = (ctx, phase = 'start') => { try { if (ctx && typeof ctx.emit === 'function') ctx.emit({ type: 'desktop_control', phase }); } catch { /* the UI's problem */ } };
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
/** What the window says (texts from the helper), without repeating the controls' own names. */
function readText(texts, elements) {
  const names = new Set((elements || []).map((e) => String(e.name || '')));
  // Single characters are icon glyphs (a font's symbols), not words.
  return (texts || []).filter((t) => !names.has(t) && String(t).trim().length > 1).slice(0, 30);
}

function elementFor(s, index) {
  if (index === undefined || index === null || index === '') throw new Error('this needs a control number: call state (with window) first, then use its [number]');
  const e = s.elements.get(Number(index));
  if (!e) throw new Error(`there is no [${index}]: call state for that window again`);
  return e;
}

// VoxAI Coder's own window cannot draw itself for PrintWindow (its thread is the one
// waiting), so native.js fell back to the screen: whatever covered it was in the picture
// -- a game on top was described as "the app". main.js hands in Electron's own capture.
let ownCapture = null;
function setOwnCapture(fn) { ownCapture = typeof fn === 'function' ? fn : null; }

/** A picture of window `w`: this app's own window from Electron, any other from Windows. */
async function shotOf(w, nativeArgs) {
  if (w && ownCapture && Number(w.pid) === process.pid) {
    try {
      const r = await ownCapture(w.hwnd);
      if (r && r.dataUrl) {
        return { ok: true, dataUrl: r.dataUrl, x: r.x, y: r.y, w: r.w, h: r.h, hwnd: w.hwnd, pid: w.pid, title: w.title, app: w.app,
          method: 'app', note: 'VoxAI Coder\'s own window, drawn by the app itself (its title bar is not included).' };
      }
    } catch { /* fall back to Windows */ }
  }
  return native.screenshot(nativeArgs || { hwnd: w.hwnd });
}

/** A fresh picture of the window, and which control has the keyboard now: what the agent checks after acting. */
async function after(s, ctx, w, did) {
  busy(ctx, 'end');
  await sleep(SETTLE_MS);
  let focused = '';
  try { const f = await uia.focused(); if (f && f.type) focused = `${f.type} "${f.name || ''}"`; } catch { /* no helper */ }
  const shot = await shotOf(w);
  recordCapture(s, shot);
  // What the window says now: the result of the step, for a model that cannot see the picture.
  let text = [];
  if (uia.available) {
    try { const r = await uia.list(w.hwnd, '', 80); remember(s, w.hwnd, r.elements || []); text = readText(r.texts, r.elements); } catch { /* the picture still shows it */ }
  }
  return {
    backend: 'native', ok: true, did, window: { title: w.title, app: appName(w) },
    ...(focused ? { keyboardFocus: focused } : {}),
    ...(text.length ? { text } : {}),
    screenshot: shot.ok ? shot.dataUrl : null,
    next: 'Check the picture (or call state again) before the next step.',
  };
}

/**
 * A real click (or wheel) at a screen point in window `w`: only if `w` is what is on top there. The
 * picture of a window is taken even where something covers it, so the agent can see a button it cannot
 * press -- Calculator's bottom row under the taskbar took a real click on "=" and nothing happened.
 */
async function pointOn(s, w, x, y, act) {
  await focusOn(w);
  const hit = input.windowAt(x, y);
  if (hit && hit.hwnd === w.hwnd) return act();
  const what = !hit ? 'that part of the window is off the screen, so it cannot be clicked'
    : /^Shell_(Secondary)?TrayWnd$/.test(hit.className) ? 'the taskbar is over it there, so a real click would land on the taskbar'
      : `"${hit.title || appName(hit)}" is on top of it there, so a real click would land on that instead`;
  throw new Error(`That point is not on ${appName(w)} as it is on screen: ${what}. `
    + 'Use the control by its number (click with index presses it without the mouse), or move the window into view first '
    + '(maximise it with its Maximize button, or with alt+space then x in classic apps -- Store apps like Calculator ignore that), then take state again.');
}

async function focusOn(w) {
  if (!(await input.focusWindow(w.hwnd))) throw new Error(`Windows would not bring "${w.title}" to the front: ask the user to click it once, then try again`);
}

// ---- the actions --------------------------------------------------------------------------------

function list() {
  const ws = visibleWindows();
  const own = input.listWindows().filter((w) => w.own && !w.minimised);
  return { backend: 'native', surface: 'native', windows: ws.slice(0, 40).map((w) => ({ title: w.title, app: appName(w), ...(w.minimised ? { minimised: true } : {}), ...(privacyBlock(w) ? { private: true } : {}) }))
    .concat(own.slice(0, 3).map((w) => ({ title: w.title, app: 'VoxAI Coder', thisApp: 'this app -- screenshot only, not state or clicks' }))),
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
  const shot = await shotOf(w);
  recordCapture(s, shot);
  let controls = '', count = 0, complete = true, note = '', text = [];
  if (uia.available) {
    try {
      const r = await uia.list(w.hwnd, String((args && args.find) || '').slice(0, 40), 80);
      remember(s, w.hwnd, r.elements || []);
      count = (r.elements || []).length;
      complete = r.complete !== false;
      controls = count ? describeAll(s, r.elements) : `no controls${args && args.find ? ` matching "${args.find}"` : ''} found: use the picture and x/y`;
      text = readText(r.texts, r.elements);
    } catch (e) { note = `The control list failed (${e.message}): use the picture and x/y.`; }
  } else note = 'The control list is not available on this computer: use the picture and x/y.';
  return {
    backend: 'native', surface: 'native', window: { title: w.title, app: appName(w) },
    controls, elementCount: count, ...(complete ? {} : { more: 'there are more: use find to narrow the list' }),
    ...(text.length ? { text } : {}),
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
      const [x, y] = centre(e);
      await pointOn(s, w, x, y, () => input.click(x, y, { button: 'right' }));
      leftAt(s, x, y);
      await sleep(MENU_MS);
      let menu = [];
      try { const r = await uia.list(s.listHwnd || w.hwnd, '', 40, 'menu'); menu = r.elements || []; remember(s, s.listHwnd || w.hwnd, menu); } catch { /* none */ }
      const res = await after(s, ctx, w, `right-clicked [${e.id}] ${e.type} "${e.name}"`);
      res.menu = menu.length ? describeAll(s, menu) : 'no menu showed up in the control list (look at the picture)';
      return res;
    }
    if (double) {
      const [x, y] = centre(e);
      await pointOn(s, w, x, y, () => input.click(x, y, { double: true }));
      leftAt(s, x, y);
      return after(s, ctx, w, `double-clicked [${e.id}] ${e.type} "${e.name}"`);
    }
    const r = await uia.act(e.id, 'invoke');
    if (r.click) {
      await pointOn(s, w, r.click[0], r.click[1], () => input.click(r.click[0], r.click[1]));
      leftAt(s, r.click[0], r.click[1]);
    }
    return after(s, ctx, w, `${r.click ? 'clicked' : r.done === 'invoke' ? 'pressed' : r.done} [${e.id}] ${e.type} "${e.name}"`);
  }
  if (args.x === undefined || args.y === undefined) throw new Error('click needs index (a control from state) or x and y (pixels in the latest picture)');
  const p = screenPoint(s, args.x, args.y);
  await pointOn(s, w, p.x, p.y, () => input.click(p.x, p.y, { button: right ? 'right' : 'left', double }));
  leftAt(s, p.x, p.y);
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
    if (r.click) { await pointOn(s, w, r.click[0], r.click[1], () => input.click(r.click[0], r.click[1])); leftAt(s, r.click[0], r.click[1]); }
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
  const keys = input.parseKeys(String(args.key || ''));   // refuse Windows-key shortcuts before touching anything
  busy(ctx);
  await focusOn(w);
  // Esc is the user's kill switch (a global shortcut while this runs): it would take the agent's own
  // Esc too -- ending the run -- and the app would never get it. Step it aside for this key press.
  const esc = keys.some((k) => k.vk === 0x1b);
  if (esc) escHooks.suspend();
  try { await input.pressKeys(String(args.key)); } finally { if (esc) setTimeout(() => escHooks.resume(), 150); }
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
  await pointOn(s, w, x, y, () => input.scroll(x, y, notches));
  leftAt(s, x, y);
  return after(s, ctx, w, `scrolled ${notches > 0 ? 'down' : 'up'} ${Math.abs(notches)}`);
}

/** A native screenshot: remembered as the picture x/y refer to. */
async function screenshot(args, ctx) {
  const s = stateFor(ctx);
  const one = !!(args && (args.window || args.hwnd || args.pid));
  // Its own window can be looked at (never acted on, so it is not remembered as the target).
  // Found live: with it left out, "VoxAI Coder" fell to a browser tab titled "VoxAI · ...".
  const target = one ? (args.window ? findWindow(args.window, { includeOwn: true })
    : input.listWindows().find((x) => (args.hwnd && x.hwnd === Number(args.hwnd)) || (args.pid && x.pid === Number(args.pid)))) : null;
  if (target) {
    const why = privacyBlock(target);
    if (why) return { ok: false, error: `I don't look into that window: ${why}.` };
    if (!target.own) s.target = target.hwnd;
  }
  const shot = target ? await shotOf(target, { window: args.window, hwnd: args.hwnd, pid: args.pid })
    : native.screenshot(one ? { window: args.window, hwnd: args.hwnd, pid: args.pid } : 0);
  if (shot.ok) recordCapture(s, shot);
  return shot;
}

/**
 * What an acting call would do, in words, for its approval ("Type "hello" into "Text editor" in Notepad"),
 * and the app its "Always" covers. Null when this is not a desktop action.
 */
function describe(sessionId, act, a) {
  if (act === 'open' && a.nativePath) {
    const exe = String(a.nativePath).split(/[\\/]/).pop();
    return { target: `Start ${exe}${/[\\/]/.test(String(a.nativePath)) ? ` (${String(a.nativePath).slice(0, 120)})` : ''}`, alwaysKey: 'start:' + exe.toLowerCase(), alwaysLabel: `Always for ${exe}` };
  }
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

/**
 * The user has answered the agent since a moved mouse paused it: that pause is over, from wherever
 * the pointer is now. It used to last the whole run, so "yes, carry on" was followed by nothing but
 * "stopped by the user" -- and the agent concluded it should give up.
 */
/** A deleted session: its window, controls and pointer baseline go. */
function forget(sessionId) { states.delete(sessionId || 'default'); }

function userAnswered(sessionId) {
  const s = states.get(sessionId || 'default');
  if (s && s.stopped) { s.stopped = false; s.cursorAt = null; }
}

module.exports = { list, focus, state, click, type, press, scroll, screenshot, setOwnCapture, _shotOf: shotOf, describe, userAnswered, forget, privacyBlock, findWindow, fitScale, appName, setEscHooks, uia, _states: states };
