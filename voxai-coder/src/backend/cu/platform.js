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

module.exports = { input, native, UiaHelper, backend };
