/**
 * kills — commands that end processes, and whose processes they are.
 *
 * Found in a live build: to restart the app it was testing, the agent ran
 * `taskkill /IM electron.exe /F`. That ends EVERY Electron app on the machine -- the
 * user's editor, chat, VoxAI itself -- and Auto only stopped it because a person
 * happened to say no. A kill is judged here, before any mode's "allow":
 *
 *   by name / filter / port  -> always the user's call, in every mode, with the count
 *   by pid, all this session's own (or their children) -> fine
 *   by pid, anything else    -> the user's call, naming the process
 */
const { execFile } = require('child_process');
const procs = require('./procs');

const isWin = process.platform === 'win32';

const unq = (s) => String(s || '').replace(/^["']|["']$/g, '');

/**
 * What a command would end. null when it ends nothing.
 * { pids: number[], names: string[], other: string[] }
 *   names  image or process names (taskkill /im, Stop-Process -Name, pkill, killall)
 *   other  kills we cannot pin to a pid or a name: filters, patterns, ports, wmic
 */
function processKills(cmd) {
  const s = String(cmd || '');
  const pids = [];
  const names = [];
  const other = [];
  const seg = '([^&|;\\n]*)';
  let m;

  const taskkill = new RegExp('\\b(?:taskkill|tskill)(?:\\.exe)?\\b' + seg, 'gi');
  while ((m = taskkill.exec(s))) {
    const a = m[1];
    const isTs = /^tskill/i.test(m[0]);
    let hit = false;
    for (const p of a.matchAll(/\/pid\s+(\d+)/gi)) { pids.push(Number(p[1])); hit = true; }
    for (const n of a.matchAll(/\/im\s+("[^"]+"|\S+)/gi)) { names.push(unq(n[1])); hit = true; }
    if (/\/fi\b/i.test(a)) { other.push('taskkill filter'); hit = true; }
    if (isTs) {
      const t = a.trim().split(/\s+/).find((x) => x && !x.startsWith('/'));
      if (t) { if (/^\d+$/.test(t)) pids.push(Number(t)); else names.push(t); hit = true; }
    }
    if (!hit) other.push('taskkill');
  }

  // PowerShell: Stop-Process / spps, and its `kill` alias with -Id / -Name.
  const stopProc = new RegExp('(^|[^\\w-])(?:Stop-Process|spps)\\b' + seg, 'gi');
  while ((m = stopProc.exec(s))) {
    const a = m[2];
    let hit = false;
    const id = /-Id\s+([\d,\s]+)/i.exec(a);
    if (id) { for (const n of id[1].split(/[,\s]+/).filter(Boolean)) pids.push(Number(n)); hit = true; }
    const nm = /-(?:Name|ProcessName)\s+("[^"]+"|'[^']+'|[^\s-][^\s]*)/i.exec(a);
    if (nm) { for (const n of unq(nm[1]).split(',')) names.push(n.trim()); hit = true; }
    if (!hit) {
      // `Get-Process chrome | Stop-Process` -- the name is on the left of the pipe.
      const before = s.slice(0, m.index + m[1].length);
      const gp = /(?:Get-Process|gps|ps)\s+(?:-Name\s+)?("[^"]+"|'[^']+'|[A-Za-z][\w.*,-]*)[^|]*\|\s*$/i.exec(before);
      if (gp && !/where|\?/i.test(before.slice(gp.index))) { for (const n of unq(gp[1]).split(',')) names.push(n.trim()); }
      else other.push('Stop-Process');
    }
  }

  // `kill` (sh, or the PowerShell alias). Not pkill/taskkill/skill.
  const kill = new RegExp('(^|[\\s;&|(])kill\\s+' + seg, 'gi');
  while ((m = kill.exec(s))) {
    const words = m[2].trim().split(/\s+/).filter(Boolean);
    let hit = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/^-(Name|ProcessName)$/i.test(w) && words[i + 1]) { names.push(unq(words[++i])); hit = true; }
      else if (/^-Id$/i.test(w) && words[i + 1]) { for (const n of words[++i].split(',')) if (/^\d+$/.test(n)) pids.push(Number(n)); hit = true; }
      else if (/^-?\d+$/.test(w) && !/^-\d{1,2}$/.test(w)) { pids.push(Math.abs(Number(w))); hit = true; }
      else if (/^-\d{1,2}$/.test(w) || /^-[A-Z]+$/.test(w) || /^-s$/i.test(w) || w === '--') { /* a signal */ }
      else { other.push('kill ' + w); hit = true; }
    }
    if (!hit) other.push('kill');
  }

  const pk = new RegExp('(^|[\\s;&|(])(pkill|killall)\\s+' + seg, 'gi');
  while ((m = pk.exec(s))) {
    const words = m[3].trim().split(/\s+/).filter(Boolean);
    if (words.some((w) => /^-(f|-full)$/.test(w))) { other.push(m[2] + ' -f'); continue; }
    const targets = words.filter((w, i) => !w.startsWith('-') && !/^-(s|u|U|g|G|signal)$/.test(words[i - 1] || ''));
    if (targets.length) names.push(...targets.map(unq)); else other.push(m[2]);
  }

  if (/\bwmic\b[^&|;\n]*\bprocess\b[^&|;\n]*\b(delete|terminate)\b/i.test(s)) other.push('wmic process');
  if (/\b(kill-port|fkill|killport)\b/i.test(s)) other.push('by port');

  // Kills written as code in a one-liner. Found live: refused five times, the agent ran
  // python -c "os.kill(20340, signal.SIGTERM)" -- and ended the user's own app.
  for (const mm of s.matchAll(/\b(?:os|process)\.kill\s*\(\s*(\d+)/g)) pids.push(Number(mm[1]));
  for (const mm of s.matchAll(/\bpsutil\.Process\s*\(\s*(\d+)\s*\)\s*\.\s*(?:kill|terminate|send_signal|suspend)\s*\(/g)) pids.push(Number(mm[1]));
  for (const mm of s.matchAll(/Get-Process\s+-Id\s+(\d+)[^|;&\n]*\)\s*\.\s*Kill\s*\(/gi)) pids.push(Number(mm[1]));
  for (const mm of s.matchAll(/\bOpenProcess\s*\([^)]*?(\d{2,})\s*\)/g)) pids.push(Number(mm[1]));
  if (/\bTerminateProcess\b|\bNtTerminateProcess\b/.test(s) && !pids.length) other.push('TerminateProcess');
  if (/\.Kill\s*\(/.test(s) && !/Get-Process\s+-Id\s+\d+/i.test(s)) other.push('.Kill()');
  if (/\b(?:os|process)\.kill\s*\(\s*[^\d\s)]/.test(s)) other.push('os.kill');
  if (/\bos\.killpg\b|\bpsutil\b[\s\S]*\.(?:kill|terminate)\s*\(\s*\)/.test(s)) other.push('a script (psutil or killpg)');

  if (!pids.length && !names.length && !other.length) return null;
  return { pids: [...new Set(pids)], names: [...new Set(names.filter(Boolean))], other: [...new Set(other)] };
}

/** Is every piece of this command a kill (so allowing the kills allows all of it)? */
function onlyKills(cmd) {
  const quiet = String(cmd || '').replace(/\s*\d?>\s*(nul|\/dev\/null)(?=\s|$|[&|;])/gi, ' ').replace(/\s*2>&1/g, ' ');
  const parts = quiet.split(/&&|\|\||;|&/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^(taskkill|tskill|kill|Stop-Process|spps)(\.exe)?\b/i.test(p));
}

/**
 * Is everything in this chain besides its kills harmless: only looking (isReadOnly) or a
 * short local wait (ping 127.0.0.1 / localhost)? For an own kill chained with a pause.
 */
function harmlessBesidesKills(cmd, isReadOnly) {
  const quiet = String(cmd || '').replace(/\s*\d?>\s*(nul|\/dev\/null)(?=\s|$|[&|;])/gi, ' ').replace(/\s*2>&1/g, ' ');
  const parts = quiet.split(/&&|\|\||;|&/).map((p) => p.trim()).filter(Boolean);
  const rest = parts.filter((p) => !/^(taskkill|tskill|kill|Stop-Process|spps)(\.exe)?\b/i.test(p));
  if (!rest.length || rest.length === parts.length) return false;
  const wait = (p) => /^ping(\.exe)?\s+(-n\s+\d{1,3}\s+)?(127\.0\.0\.1|localhost)(\s+-n\s+\d{1,3})?\s*$/i.test(p);
  return rest.every((p) => wait(p) || (typeof isReadOnly === 'function' && isReadOnly(p)));
}

/** Every running process: pid -> { ppid, name }. Empty when it cannot be read. */
function processTable() {
  return new Promise((resolve) => {
    const done = (map) => resolve(map);
    if (isWin) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        const map = new Map();
        if (!err) for (const line of String(out).split(/\r?\n/)) {
          const [pid, ppid, ...rest] = line.split(',');
          if (/^\d+$/.test(pid)) map.set(Number(pid), { ppid: Number(ppid), name: rest.join(',').trim() });
        }
        done(map);
      });
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        const map = new Map();
        if (!err) for (const line of String(out).split(/\n/)) {
          const mm = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          if (mm) map.set(Number(mm[1]), { ppid: Number(mm[2]), name: mm[3].trim() });
        }
        done(map);
      });
    }
  });
}

/**
 * What these processes are: program, command line, when started. pid -> { name, cmd, since }.
 * The agent took the user's pythonw app (AI_Account_Hub, running since the day before) for
 * the one it had just started; "pythonw.exe" alone did not tell it otherwise.
 */
function pidDetails(pids) {
  const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0).slice(0, 8);
  if (!list.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    if (!isWin) {
      execFile('ps', ['-o', 'pid=,lstart=,args=', '-p', list.join(',')], { timeout: 10000 }, (err, out) => {
        const map = new Map();
        if (!err) for (const line of String(out).split(/\n/)) {
          const mm = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
          if (mm) map.set(Number(mm[1]), { name: mm[3].split(/\s+/)[0], cmd: mm[3], since: mm[2] });
        }
        resolve(map);
      });
      return;
    }
    const filter = list.map((p) => `ProcessId=${p}`).join(' OR ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CreationDate.ToString('d MMM HH:mm'))\`t$($_.CommandLine)" }`],
    { windowsHide: true, timeout: 15000 }, (err, out) => {
      const map = new Map();
      if (!err) for (const line of String(out).split(/\r?\n/)) {
        const [pid, name, since, ...rest] = line.split('\t');
        if (/^\d+$/.test(pid)) map.set(Number(pid), { name, since, cmd: rest.join('\t').trim() });
      }
      resolve(map);
    });
  });
}
/** "pythonw.exe running A:\...\main.py, started 25 Sep 18:01" -- short enough for a prompt. */
function whatIs(d, row) {
  if (!d && !row) return '';
  const name = (d && d.name) || (row && row.name) || 'a process';
  const args = d && d.cmd ? d.cmd.replace(/^"[^"]*"\s*|^\S+\s*/, '').trim() : '';
  return `${name}${args ? ` running ${args.slice(0, 120)}` : ''}${d && d.since ? `, started ${d.since}` : ''}`;
}

const baseName = (n) => String(n || '').toLowerCase().replace(/\.exe$/, '');
function nameMatches(pattern, name) {
  const p = baseName(pattern);
  if (p.includes('*')) return new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(baseName(name));
  return p === baseName(name);
}

/**
 * Whose processes would this kill end?
 * { own: true } when every target is a pid this session started (or a child of one).
 * Otherwise { own: false, note, hint }: the note for the approval prompt, the hint
 * for the model when the user says no.
 */
async function judgeKills(kills, sessionId, table = null) {
  const owned = procs.ownedBy(sessionId);
  const mine = procs.list(sessionId).map((r) => `${r.pid} (${String(r.command || r.name).slice(0, 60)})`);
  const hint = 'Ending processes by name, filter or port also ends the user\'s own programs. '
    + 'To stop something you started, end it by its pid with taskkill /pid <pid> /T /F, as a command on its own. '
    + (mine.length ? `Still running from this session: ${mine.join('; ')}.` : 'Nothing started by this session is still running.');
  const t = table || (kills.names.length || kills.pids.length ? await processTable() : new Map());
  const isOwn = (pid) => {
    let p = pid;
    for (let i = 0; i < 32 && p; i++) {
      if (owned.has(p)) return true;
      const row = t.get(p);
      if (!row || row.ppid === p) break;
      p = row.ppid;
    }
    return false;
  };
  if (!kills.names.length && !kills.other.length && kills.pids.length && kills.pids.every(isOwn)) return { own: true };

  const parts = [];
  for (const n of kills.names) {
    const count = [...t.values()].filter((r) => nameMatches(n, r.name)).length;
    parts.push(`every process named ${n}${t.size ? ` (${count} running now)` : ''}`);
  }
  for (const o of kills.other) parts.push(o === 'by port' ? 'whatever is using a port' : `processes matched by ${o}`);
  const others = kills.pids.filter((p) => !isOwn(p));
  const det = others.length ? await pidDetails(others) : new Map();
  const notMine = [];
  for (const pid of others) {
    const w = whatIs(det.get(pid), t.get(pid));
    parts.push(`pid ${pid}${w ? ` (${w})` : ''}, which this session did not start`);
    if (w) notMine.push(`PID ${pid} is ${w}: it is NOT a program you started, so it is not your app.`);
  }
  const note = `This ends ${parts.join(', ')}. `
    + (kills.names.length || kills.other.length ? 'That can include programs you have open. Allow only if you want exactly that.'
      : 'Allow only if you mean to end it.');
  return { own: false, note, hint: (notMine.length ? notMine.join(' ') + ' ' : '') + hint };
}

/** Everything a kill aims at, as keys, to remember a refusal by ("pid:20340", "name:pythonw"). */
function killKeys(kills) {
  return [...kills.pids.map((p) => 'pid:' + p), ...kills.names.map((n) => 'name:' + baseName(n)), ...kills.other.map((o) => 'other:' + o)];
}

module.exports = { processKills, onlyKills, harmlessBesidesKills, judgeKills, killKeys, pidDetails, processTable, nameMatches };
