/**
 * uia.js — the UI Automation helper (resources/uia/voxai-uia.exe, built from native/VoxUia.cs): the controls
 * in a window by name, so the agent can press "Save" or type into "File name" instead of guessing pixels.
 * Started on first use, one JSON line per request; stopped after two idle minutes. A request that takes
 * over 5 s (a hung app) kills the helper, which starts fresh next time. Ported from Byte (Desktop3D).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 5000;
const IDLE_MS = 120000;
// Packed inside app.asar in the installed app, where an .exe cannot run: electron-builder unpacks it beside.
const EXE = path.join(__dirname, '..', '..', '..', 'resources', 'uia', 'voxai-uia.exe').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

class UiaHelper {
  constructor({ exe = EXE, spawnFn = spawn, timeoutMs = TIMEOUT_MS } = {}) {
    Object.assign(this, { exe, spawnFn, timeoutMs });
    this.proc = null;
    this.seq = 0;
    this.waiting = new Map();   // seq -> {resolve, reject, timer}
    this.buffer = '';
    this._idle = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(this.exe); }

  _start() {
    if (this.proc) return;
    const proc = this.spawnFn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._read(chunk));
    const gone = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error(`the control list stopped (${why})`)); }
      this.waiting.clear();
    };
    proc.on('exit', (code) => gone(`exit ${code}`));
    proc.on('error', (err) => gone(err.message));
  }

  _read(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = this.waiting.get(msg.seq);
      if (!w) continue;
      this.waiting.delete(msg.seq);
      clearTimeout(w.timer);
      if ('error' in msg) w.reject(new Error(msg.error || `${msg.kind || 'the app'} refused: list the window again`));
      else w.resolve(msg);
    }
  }

  request(cmd) {
    if (!this.available) return Promise.reject(new Error('the control list is not available here: use a screenshot and x/y'));
    this._start();
    clearTimeout(this._idle);
    this._idle = setTimeout(() => this.stop(), IDLE_MS);
    if (this._idle.unref) this._idle.unref();
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(seq);
        this.stop();
        reject(new Error('the app did not answer in time (it may be busy): use a screenshot instead'));
      }, this.timeoutMs);
      this.waiting.set(seq, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ ...cmd, seq })}\n`);
    });
  }

  /** only 'menu': just the items of the menu that is open (a right-click menu). near: [x, y, w, h] screen pixels. */
  list(hwnd, find = '', max = 60, only = '', near = null) {
    return this.request({ cmd: 'list', hwnd: Number(hwnd), find, max, ...(only ? { only } : {}), ...(near ? { near: near.map(Math.round) } : {}) });
  }
  act(id, action, text = '') { return this.request({ cmd: 'act', id: Number(id), action, text }); }
  focused() { return this.request({ cmd: 'focused' }); }

  stop() {
    clearTimeout(this._idle);
    const proc = this.proc;
    this.proc = null;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error('the control list stopped')); }
    this.waiting.clear();
    try { if (proc) proc.kill(); } catch { /* already gone */ }
  }
}

module.exports = { UiaHelper, EXE };
