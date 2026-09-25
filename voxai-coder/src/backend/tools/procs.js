/**
 * procs — processes the agent leaves running: servers, watchers, anything started to
 * keep going after its command returns.
 *
 * Asked to serve a folder, the model ran `start /b python -m http.server 8765 && curl …`.
 * The server kept the command's output open, so the shell call never returned: the run
 * sat on "Running" for minutes, the time limit killed a cmd.exe that had already gone,
 * Stop did the same, and the server was left listening with nothing tracking it. Found
 * in a live run.
 *
 * Every such process is recorded here and ended when the app quits.
 */
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const running = new Map();   // pid -> { pid, name, command, sessionId, startedAt, log }

function killTree(pid) {
  try {
    if (isWin) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else process.kill(-pid, 'SIGKILL');
  } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

function track(rec) { running.set(rec.pid, { startedAt: Date.now(), ...rec }); return rec; }

/** What is still running, for this session or all of them. Dead entries are dropped. */
function list(sessionId) {
  for (const [pid] of running) if (!alive(pid)) running.delete(pid);
  return [...running.values()].filter((r) => !sessionId || r.sessionId === sessionId)
    .map(({ pid, name, command, startedAt, log }) => ({ pid, name, command, startedAt, log }));
}

/** End one (with its children). */
function stop(pid) { killTree(pid); running.delete(Number(pid)); }

/** End everything. For app quit: synchronous, so it finishes before the process goes. */
function stopAll() {
  for (const [pid] of running) {
    try {
      if (isWin) execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  running.clear();
}

/**
 * The processes a finished command left behind: children of its (now gone) shell.
 * Windows keeps the parent id on an orphan, so they can still be found by it.
 */
function leftovers(parentPid) {
  return new Promise((resolve) => {
    if (isWin) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parentPid)}" | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`],
      { windowsHide: true, timeout: 8000 }, (err, out) => {
        resolve(String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const [p, name] = l.split('|'); return { pid: Number(p), name: name || '' };
        }).filter((x) => x.pid && !/^(conhost|taskkill)\.exe$/i.test(x.name)));
      });
    } else {
      execFile('ps', ['-o', 'pid=,comm=', '--ppid', String(parentPid)], (err, out) => {
        resolve(String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = /^(\d+)\s+(.*)$/.exec(l); return m ? { pid: Number(m[1]), name: m[2] } : null;
        }).filter(Boolean));
      });
    }
  });
}

/**
 * Start a command that keeps running (a server, a watcher). Its output goes to a log
 * file; this returns once it has had a few seconds to start -- or sooner, if it
 * exits, in which case it did not start and the output says why.
 */
function startBackground(command, { cwd, sessionId, waitMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const dir = path.join(os.tmpdir(), 'voxai-bg');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const log = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    const fd = fs.openSync(log, 'a');
    const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', '"' + command + '"'] : ['-c', command], {
      cwd, windowsHide: true, windowsVerbatimArguments: isWin, stdio: ['ignore', fd, fd], detached: !isWin,
    });
    try { fs.closeSync(fd); } catch {}
    const read = () => { try { return fs.readFileSync(log, 'utf8').split('\n').slice(-60).join('\n').slice(-4000); } catch { return ''; } };
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    child.on('error', (e) => done({ command, background: true, running: false, error: String(e && e.message || e), output: read(), log }));
    child.on('exit', (code) => done({ command, background: true, running: false, exit: code == null ? 1 : code, output: read(), log,
      note: 'It exited straight away, so nothing is running. The output says why.' }));
    setTimeout(() => {
      if (settled) return;
      track({ pid: child.pid, name: isWin ? 'cmd.exe' : 'sh', command, sessionId, log });
      if (!isWin) try { child.unref(); } catch {}
      done({ command, background: true, running: true, pid: child.pid, output: read(), log,
        note: `Running in the background (pid ${child.pid}); it keeps going after this call and ends when the app closes. `
          + `To end it sooner: ${isWin ? `taskkill /pid ${child.pid} /T /F` : `kill -- -${child.pid}`}.` });
    }, waitMs);
  });
}

module.exports = { startBackground, leftovers, track, list, stop, stopAll, killTree };
