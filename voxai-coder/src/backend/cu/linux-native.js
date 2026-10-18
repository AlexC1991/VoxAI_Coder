/**
 * linux-native.js — screenshots and window metadata for Linux, as a drop-in for native.js.
 *
 * Same exported surface, so cu/desktop.js and cu/index.js do not care which one they got.
 * Capture goes through a chain, newest desktop first:
 *   1. a Wayland desktop's own screenshot tool (COSMIC's cosmic-screenshot), which uses
 *      the desktop portal and works where X11 capture is refused;
 *   2. ImageMagick's `import` on X11;
 *   3. grim, if a wlroots compositor offers wlr-screencopy.
 *
 * The order matters: some Wayland compositors refuse X11 capture outright (COSMIC does,
 * with BadMatch on X_GetImage), so every X11 tool fails there while the portal path works
 * perfectly. Trying X11 first meant a black or missing screenshot on a desktop where a
 * good one was available. `captureSupported()` probes the chain once and `screenshot()`
 * explains the outcome in plain words rather than surfacing a raw X error.
 *
 * Input control and window listing are unaffected by any of this.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DISPLAY = () => process.env.DISPLAY || '';

function run(cmd, args, timeout = 60000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, err: String(r.error.message || r.error) };
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

const NO_CAPTURE = 'Nothing on this desktop would give us a screenshot. On a Wayland session '
  + '(COSMIC, GNOME) the X11 tools are refused -- the desktop portal or its own screenshot '
  + 'tool is required instead. Install one of cosmic-screenshot, grim (wlroots), or '
  + 'gnome-screenshot, or log into an X11 session. Window listing and input control still work here.';

function looksBlocked(msg) {
  return /BadMatch|X_GetImage|Resource temporarily unavailable|unable to grab|not authorized/i.test(String(msg));
}

/* ---- capture backends, in the order worth trying ------------------------- */

// `command -v` is a shell builtin, not a program: spawning it directly fails with ENOENT
// and made every backend look absent, so the whole capture chain reported "nothing works"
// on a machine where cosmic-screenshot was installed and fine.
function have(cmd) {
  if (!/^[a-z0-9_.+-]+$/i.test(cmd)) return false;
  return run('/bin/sh', ['-c', 'command -v ' + cmd], 5000).ok;
}

/**
 * A Wayland desktop's own screenshot tool.
 *
 * These take a save directory and write a timestamped PNG, returning the path on stdout.
 * cosmic-screenshot is what a COSMIC session uses, and it is the only thing that worked
 * on this machine when every X11 tool returned "Resource temporarily unavailable".
 *
 * Non-interactive is essential: the interactive default opens a selector UI that would
 * sit there waiting for a person, which an agent can never satisfy.
 */
function portalShot(outDir) {
  const attempts = [
    ['cosmic-screenshot', ['--interactive=false', '--notify=false', '--save-dir', outDir]],
  ];
  for (const [cmd, args] of attempts) {
    if (!have(cmd)) continue;
    const r = run(cmd, args, 45000);
    // Some builds print the path; otherwise take the newest file the tool just made.
    const printed = String(r.out || '').split('\n').map((s) => s.trim()).filter(Boolean)
      .find((s) => /\.(png|jpg|jpeg)$/i.test(s) && fs.existsSync(s));
    if (printed) return { file: printed, tool: cmd };
    const fresh = fs.readdirSync(outDir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .map((f) => path.join(outDir, f))
      .filter((p) => { try { return Date.now() - fs.statSync(p).mtimeMs < 20000; } catch { return false; } })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (fresh && fs.statSync(fresh).size > 0) return { file: fresh, tool: cmd };
  }
  return null;
}

/** ImageMagick on X11: the desktop, or one window by id. */
function x11Shot(out, winId) {
  const args = winId ? ['-window', winId, '+repage', out] : ['-window', 'root', '+repage', out];
  const r = run('import', args, 60000);
  const good = r.ok && fs.existsSync(out) && fs.statSync(out).size > 0;
  return { ok: good, err: r.err, blocked: looksBlocked(r.err) };
}

/** grim (wlroots): whole screen only -- it has no "one window" mode. */
function grimShot(out) {
  if (!have('grim')) return { ok: false, err: '', blocked: false };
  const r = run('grim', [out], 45000);
  const good = r.ok && fs.existsSync(out) && fs.statSync(out).size > 0;
  return { ok: good, err: r.err, blocked: false };
}

/** The X id of the frontmost window matching a title fragment, app name or pid. */
function findWindowId({ pid = 0, hwnd = 0, window = '' } = {}) {
  if (hwnd) return '0x' + Number(hwnd).toString(16);
  const input = require('./linux-input');
  const all = input.listWindows();               // front to back
  const want = String(window || '').toLowerCase();
  const hit = all.find((w) => (pid && w.pid === Number(pid))
    || (want && (String(w.title || '').toLowerCase().includes(want)
      || String(w.app || '').toLowerCase().includes(want)))) || null;
  return hit ? '0x' + Number(hit.hwnd).toString(16) : '';
}

/** Window details for a captured target, or null when this is a whole-screen shot. */
function windowInfo({ pid = 0, hwnd = 0, window = '' } = {}) {
  const input = require('./linux-input');
  const all = input.listWindows();
  const want = String(window || '').toLowerCase();
  return all.find((w) => (hwnd && w.hwnd === Number(hwnd))
    || (pid && w.pid === Number(pid))
    || (want && (String(w.title || '').toLowerCase().includes(want)
      || String(w.app || '').toLowerCase().includes(want)))) || null;
}

let probe = null;
/** Can this session capture at all? Probed once, so the agent can be told plainly. */
function captureSupported() {
  if (probe) return probe;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cu-probe-'));
  const p = path.join(dir, 'probe.png');
  const errors = [];
  try {
    const x = x11Shot(p, '');
    if (x.ok) { probe = { ok: true, reason: '', detail: '', tool: 'x11' }; return probe; }
    if (x.err) errors.push('import: ' + x.err.slice(0, 120));

    const w = portalShot(dir);
    if (w) { probe = { ok: true, reason: '', detail: '', tool: w.tool }; return probe; }
    errors.push('desktop screenshot tool: no image produced');

    const g = grimShot(p);
    if (g.ok) { probe = { ok: true, reason: '', detail: '', tool: 'grim' }; return probe; }
    if (g.err) errors.push('grim: ' + g.err.slice(0, 120));

    probe = { ok: false, reason: 'no-capture-backend', detail: errors.join(' | ').slice(0, 300) };
    return probe;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

/**
 * A screenshot of the desktop, or of one window: `target` is a pid, or
 * { window, hwnd, pid }. A window is captured on its own even when covered.
 * `x`, `y` say where the image's top-left corner is on screen, for clicking inside it.
 * Returns a dataUrl, as native.js does.
 */
function screenshot(target) {
  const t = (typeof target === 'object' && target) ? target : { pid: Number(target) || 0 };
  const sup = captureSupported();
  if (!sup.ok) return { ok: false, error: NO_CAPTURE, reason: 'no-capture-backend', detail: sup.detail };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cu-shot-'));
  const p = path.join(dir, 'shot.png');
  const winId = findWindowId(t);
  const input = require('./linux-input');
  const info = windowInfo(t);
  let method = '';
  let shotPath = '';
  let geolocated = false;

  try {
    if (sup.tool === 'x11') {
      const r = x11Shot(p, winId);
      if (!r.ok) return { ok: false, error: looksBlocked(r.err) ? NO_CAPTURE : (r.err || 'the screenshot did not come out').slice(0, 300) };
      method = 'x11'; shotPath = p; geolocated = true;
    } else {
      // A portal screenshot is of the whole desktop: these tools cannot capture one window
      // on its own. Crop to the window's rectangle when we know it, so "look at the game"
      // returns the game rather than two monitors' worth of desktop.
      const w = portalShot(dir);
      if (!w) {
        const g = grimShot(p);
        if (!g.ok) return { ok: false, error: g.err || 'the desktop screenshot tool produced no image' };
        method = 'grim'; shotPath = p; geolocated = true;
      } else {
        method = w.tool === 'grim' ? 'grim' : 'wayland-portal';
        shotPath = w.file;
        geolocated = true;   // these capture the whole desktop, so x,y=0,0 is right
        if (winId && info) {
          const cropped = path.join(dir, 'crop.png');
          const c = run('convert', [w.file, '-crop', `${info.w}x${info.h}+${info.x}+${info.y}`, '+repage', cropped], 30000);
          if (c.ok && fs.existsSync(cropped) && fs.statSync(cropped).size > 0) {
            shotPath = cropped;
            method += '+crop';
            geolocated = false;   // now it is the window, so its own x,y are the origin
          }
        }
      }
    }

    if (!fs.existsSync(shotPath) || !fs.statSync(shotPath).size) {
      return { ok: false, error: 'the screenshot did not come out' };
    }
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(shotPath).toString('base64');
    const size = identify(shotPath);
    return {
      ok: true,
      dataUrl,
      x: geolocated ? (info ? info.x : 0) : 0,
      y: geolocated ? (info ? info.y : 0) : 0,
      w: size.w, h: size.h,
      ...(info ? { hwnd: info.hwnd, pid: info.pid, title: info.title, app: info.app } : {}),
      method,
      note: method.startsWith('x11')
        ? 'captured with ImageMagick import (X11), without stealing focus.'
        : info
          ? `captured with ${method} (Wayland); cropped to the "${info.app || info.title}" window.`
          : `captured with ${method} (Wayland); whole desktop.`,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

function identify(p) {
  const r = run('identify', ['-format', '%w %h', p], 15000);
  if (!r.ok) return { w: 0, h: 0 };
  const [w, h] = r.out.trim().split(/\s+/).map((n) => parseInt(n, 10));
  return { w: w || 0, h: h || 0 };
}

// ---- the rest of native.js's surface, for the code paths that call it ---------

function listWindows() {
  const input = require('./linux-input');
  return { ok: true, windows: input.listWindows() };
}

function buildA11y(pid) {
  const input = require('./linux-input');
  const win = pid ? input.listWindows().find((w) => w.pid === Number(pid)) : input.listWindows()[0];
  if (!win) return { ok: false, error: 'no window for that pid' };
  const { UiaHelper } = require('./linux-uia');
  const u = new UiaHelper();
  return u.list(win.hwnd, '', 200).then((r) => ({
    ok: true, pid: win.pid, title: win.title, x: win.x, y: win.y, w: win.w, h: win.h,
    elements: r.elements,
    note: 'Linux elements come from the X widget tree, not UI Automation: names are often blank.',
  }));
}

function clickElement(pid, index) {
  const input = require('./linux-input');
  const win = input.listWindows().find((w) => w.pid === Number(pid));
  if (!win) return { ok: false, error: 'no window for that pid' };
  const { UiaHelper } = require('./linux-uia');
  const u = new UiaHelper();
  return u.list(win.hwnd, '', 200).then((r) => {
    const el = (r.elements || [])[Number(index) || 0];
    if (!el) return { ok: false, error: 'no element at that index' };
    return input.click(el.x + Math.floor(el.w / 2), el.y + Math.floor(el.h / 2))
      .then(() => ({ ok: true }));
  });
}

function click(x, y) {
  return require('./linux-input').click(x, y).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.message || e) }));
}
function move(x, y) {
  try { require('./linux-input').pointAt(x, y); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
function typeText(text) {
  return require('./linux-input').typeText(text).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.message || e) }));
}
function press(key) {
  return require('./linux-input').pressKeys(key).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.message || e) }));
}
function scroll(x, y, delta) {
  return require('./linux-input').scroll(x, y, delta).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.message || e) }));
}
function launch(exe, args) {
  try {
    const { spawn } = require('child_process');
    const list = Array.isArray(args) ? args : (args ? String(args).split(/\s+/).filter(Boolean) : []);
    const c = spawn(exe, list, { detached: true, stdio: 'ignore' });
    c.unref();
    return { ok: true, path: exe, args: list, pid: c.pid || 0 };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function isWindows() { return false; }
function isLinux() { return process.platform === 'linux'; }
function runScript([op, arg]) {
  const p = arg || {};
  switch (op) {
    case 'list': return listWindows();
    case 'a11y': return buildA11y(p.pid);
    case 'cele': return clickElement(p.pid, p.index);
    case 'shot': return screenshot(p);
    case 'click': return click(p.x, p.y);
    case 'move': return move(p.x, p.y);
    case 'type': return typeText(p.text);
    case 'press': return press(p.key);
    case 'scroll': return scroll(p.x, p.y, p.delta);
    case 'launch': return launch(p.path, p.args);
    default: return { ok: false, error: `unknown op ${op}` };
  }
}

module.exports = {
  listWindows, buildA11y, clickElement, screenshot,
  click, move, typeText, press, scroll, launch,
  isWindows, isLinux, runScript, captureSupported,
};
