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
const { decodeOutput } = require('./decode');

const isWin = process.platform === 'win32';
const running = new Map();   // pid -> { pid, name, command, sessionId, startedAt, log }

/**
 * Will this command stop and ask something it has no way to read on a pipe? Those run in the
 * terminal panel instead (terminal_run), where the user answers. sudo is Linux's; a bare ssh
 * login, ssh-add, gpg, and the CLIs' own logins ask on Windows too. Text in quotes is data:
 * `git commit -m "ssh host"` asks nothing. A plain `ssh host some-command` is a one-shot.
 */
function needsTerminal(command) {
  let c = String(command == null ? '' : command);
  if (!c) return false;
  c = c.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  // sudo, unless -n ("never prompt"), which is the pipe-safe form.
  if (!isWin && /(^|[\s;&|(])sudo(\s|$)/.test(c) && !/(^|[\s;&|(])sudo\s+-[A-Za-z]*n/.test(c)) return true;
  if (/(^|[\s;&|(])ssh(\.exe)?\s+[^\s;&|]+\s*$/i.test(c)) return true;
  if (/(^|[\s;&|(])(ssh-add|gpg|pass)(\.exe)?\s/i.test(c)) return true;
  if (/(^|[\s;&|(])(npm|pnpm|yarn)\s+(login|adduser)\b/i.test(c) || /(^|[\s;&|(])gh\s+auth\s+login\b/i.test(c)) return true;
  return false;
}

/** How a command is run: cmd.exe on Windows, given the command exactly as written. */
function shellArgs(command) {
  return isWin ? ['cmd.exe', ['/d', '/s', '/c', '"' + command + '"']] : ['/bin/sh', ['-c', command]];
}
// Python writes to a pipe in cp1252 unless told otherwise, so "héllo" came back
// mangled. Its output is read as UTF-8 (see decode.js for cmd.exe's own).
function childEnv() {
  return { ...process.env, PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8', PYTHONUTF8: process.env.PYTHONUTF8 || '1' };
}

function killTree(pid) {
  try {
    if (isWin) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else process.kill(-pid, 'SIGKILL');
  } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

function track(rec) { running.set(rec.pid, { startedAt: Date.now(), ...rec }); claim(rec.pid, rec.sessionId); return rec; }

// Every pid a session started, including programs it opened on the desktop. Only for
// telling its own processes from the user's when it wants to end one (kills.js):
// unlike `running`, nothing here is ended when the app quits -- a program the agent
// opened for you stays open.
const owned = new Map();   // sessionId -> Set<pid>
function claim(pid, sessionId) {
  if (!pid || !sessionId) return;
  if (!owned.has(sessionId)) owned.set(sessionId, new Set());
  owned.get(sessionId).add(Number(pid));
}
function ownedBy(sessionId) { return owned.get(sessionId) || new Set(); }

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
    } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }   // a leftover is in its shell's group, not leading one
  }
  running.clear();
}

/**
 * The processes a finished command left behind: children of its (now gone) shell.
 * Windows keeps the parent id on an orphan, so they can still be found by it. Elsewhere
 * an orphan is handed to init, but it stays in the shell's process group (the shell is
 * spawned detached, so the group is the shell's pid) -- so it is found by that instead.
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
      execFile('ps', ['-eo', 'pid=,pgid=,comm='], (err, out) => {
        resolve(String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
          return m && Number(m[2]) === Number(parentPid) && Number(m[1]) !== Number(parentPid) ? { pid: Number(m[1]), name: m[3] } : null;
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
    const [exe, argv] = shellArgs(command);
    const child = spawn(exe, argv, {
      cwd, env: childEnv(), windowsHide: true, windowsVerbatimArguments: isWin, stdio: ['ignore', fd, fd], detached: !isWin,
    });
    try { fs.closeSync(fd); } catch {}
    const read = () => { try { return decodeOutput(fs.readFileSync(log)).split('\n').slice(-60).join('\n').slice(-4000); } catch { return ''; } };
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

module.exports = { startBackground, leftovers, track, claim, ownedBy, list, stop, stopAll, killTree, shellArgs, childEnv, needsTerminal };
