'use strict';
/**
 * Which desktop-control backend this system uses -- the one place cu/desktop.js and cu/index.js
 * get it from, and the one place a new system's backend is added.
 *
 *   win32  win-input (SendInput through koffi), native (PowerShell and .NET), uia (VoxUia.exe)
 *   linux  linux-input (xdotool, xwininfo), linux-native (screenshots: the desktop portal,
 *          ImageMagick's import, grim), linux-uia (the X widget tree) -- from the Linux edition
 *   other  none yet. The Windows modules are loaded and report themselves unavailable, so
 *          desktop control says so instead of failing. A macOS backend would be three files
 *          with the same surface -- mac-input (CGEvent, e.g. through koffi like win-input),
 *          mac-native (screencapture, CGWindowList), mac-uia (the Accessibility API) -- and the
 *          two lines below; docs/MACOS.md lists what each needs (permissions included).
 *
 * Every backend has the same surface. Key combinations are checked the same way everywhere:
 * parseKeys is pure (win-input.js) and refuses Windows-key shortcuts before anything is pressed;
 * the Linux module had no copy of it, so pressing a key there failed.
 */
const linux = process.platform === 'linux';
const winInput = require('./win-input');
const rawInput = linux ? require('./linux-input') : winInput;
const input = { ...rawInput, parseKeys: rawInput.parseKeys || winInput.parseKeys };
const native = require(linux ? './linux-native' : './native');
const { UiaHelper } = linux ? require('./linux-uia') : require('./uia');
const backend = linux ? 'linux' : process.platform === 'win32' ? 'windows' : 'none';

/**
 * What desktop control can do here, for Settings > Computer use. Only looks for the tools: it
 * never takes a screenshot (on GNOME the portal would ask the user) or touches a window.
 * { ok, system, how, missing: [what to install], screenshots: [tools found], note }
 */
function status() {
  if (backend === 'windows') {
    const ok = !!input.available();
    return { backend, ok, system: 'Windows', how: 'Windows UI Automation', missing: [], screenshots: ok ? ['Windows'] : [],
      note: ok ? '' : 'The input library did not load, so the agent cannot use the mouse and keyboard. Reinstalling VoxAI usually fixes it.' };
  }
  if (backend === 'linux') {
    const { spawnSync } = require('child_process');
    const have = (c) => { try { return spawnSync('sh', ['-c', 'command -v ' + c], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch { return false; } };
    const session = String(process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11')).toLowerCase();
    const missing = ['xdotool', 'xwininfo'].filter((c) => !have(c));
    const screenshots = ['cosmic-screenshot', 'import', 'grim'].filter(have);
    const display = !!process.env.DISPLAY;
    const ok = display && !missing.length;
    const notes = [];
    if (!display) notes.push('There is no X display (DISPLAY is not set), so no window can be reached.');
    if (session === 'wayland') notes.push('On Wayland only XWayland windows can be reached (most X11 apps, and anything under Wine or Proton).');
    if (!screenshots.length) notes.push('Nothing here can take a screenshot: install ImageMagick (import), or grim on Sway or Hyprland.');
    return { backend, ok, system: 'Linux, ' + (session === 'wayland' ? 'Wayland' : 'X11'), how: 'xdotool and xwininfo', missing, screenshots, note: notes.join(' ') };
  }
  return { backend, ok: false, system: process.platform === 'darwin' ? 'macOS' : process.platform, how: '', missing: [], screenshots: [],
    note: 'Using desktop apps is not available on this system yet (docs/MACOS.md says what it needs). The browser works.' };
}

module.exports = { input, native, UiaHelper, backend, status };
