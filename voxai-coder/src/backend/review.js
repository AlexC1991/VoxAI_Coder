/**
 * review -- the session folder's changes, reviewed and shipped: per-file and per-hunk diffs,
 * putting a hunk back, committing what was kept, pushing, opening a pull request and watching
 * its checks.
 *
 * VoxAI stopped at "the agent changed files". What happened next -- reading the diff, keeping
 * some of it, writing the commit, pushing, the PR and its CI -- was done somewhere else.
 *
 * Everything runs git / gh with an argument list (execFile, never a shell string), in the
 * session's folder, so a file name cannot be read as a command. Each step is something the
 * user clicked; nothing here runs on its own.
 */
const { execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

function run(cmd, cwd, args, { timeout = 30000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ ok: false, missing: true, code: -1, out: '', err: `${cmd} is not installed` });
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || (err && !stdout ? err.message : '') || '') });
      });
  });
}
const git = (cwd, args, o) => run('git', cwd, args, o);
const gh = (cwd, args, o) => run('gh', cwd, args, o);

/** Where the remote is, so the PR and checks buttons know whether gh applies. */
function hostOf(url) {
  const u = String(url || '').toLowerCase();
  if (/github\.com[:/]/.test(u)) return 'github';
  if (/gitlab\./.test(u)) return 'gitlab';
  if (/codeberg\.org/.test(u)) return 'codeberg';
  return u ? 'other' : '';
}

/** The folder's state: branch, remote, ahead/behind, and each changed file with its +/- counts. */
async function status(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') {
    return { repo: false, error: inside.missing ? 'git is not installed' : 'This folder is not a git repository.' };
  }
  const [head, br, up, remote, st] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const hasHead = head.ok && !!head.out.trim();
  let ahead = 0, behind = 0;
  if (up.ok && up.out.trim()) {
    const c = await git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    const m = /(\d+)\s+(\d+)/.exec(c.out);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }
  // Porcelain -z: "XY path\0", and a rename's old path follows as its own field.
  const files = [];
  const parts = st.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const x = e[0], y = e[1], p = e.slice(3);
    let kind = 'M';
    if (x === '?' && y === '?') kind = '?';
    else if (x === 'R' || y === 'R') { kind = 'R'; i++; }
    else if (x === 'A' || y === 'A') kind = 'A';
    else if (x === 'D' || y === 'D') kind = 'D';
    files.push({ path: p, status: kind, staged: x !== ' ' && x !== '?' });
  }
  if (hasHead && files.length) {
    const ns = await git(cwd, ['diff', 'HEAD', '--numstat', '-z']);
    const counts = new Map();
    for (const rec of ns.out.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(rec);
      if (m) counts.set(m[3], { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
    }
    for (const f of files) Object.assign(f, counts.get(f.path) || {});
  }
  for (const f of files) {
    if (f.status === '?' || (f.status === 'A' && f.added == null)) {
      try { const t = await fsp.readFile(path.join(cwd, f.path)); const txt = t.toString('utf8'); f.added = t.includes(0) ? null : txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0); f.removed = 0; } catch { /* gone */ }
    }
  }
  return {
    repo: true, hasHead, branch: br.ok ? br.out.trim() : '(detached)', upstream: up.ok ? up.out.trim() : '',
    ahead, behind, remote: remote.ok ? remote.out.trim() : '', host: hostOf(remote.ok ? remote.out : ''), files,
  };
}

/** A unified diff, parsed: the file's header lines and its hunks with numbered lines. */
function parseDiff(text) {
  const lines = String(text || '').split('\n');
  const header = [];
  const hunks = [];
  let h = null, oldNo = 0, newNo = 0, binary = false;
  for (const l of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(l);
    if (m) {
      h = { header: l, oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], lines: [] };
      hunks.push(h); oldNo = h.oldStart; newNo = h.newStart;
      continue;
    }
    if (!h) { if (l) header.push(l); if (/^Binary files /.test(l)) binary = true; continue; }
    const t = l[0];
    if (t === '+') h.lines.push({ t: '+', text: l.slice(1), newNo: newNo++ });
    else if (t === '-') h.lines.push({ t: '-', text: l.slice(1), oldNo: oldNo++ });
    else if (t === ' ') h.lines.push({ t: ' ', text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (t === '\\') h.lines.push({ t: '\\', text: l });
  }
  return { header, hunks, binary };
}
function hunkText(h) {
  return [h.header, ...h.lines.map((x) => (x.t === '\\' ? x.text : x.t + x.text))].join('\n') + '\n';
}

/** One file's diff against the last commit (a new file: against nothing). */
async function fileDiff(cwd, file, { untracked = false } = {}) {
  const r = untracked
    ? await git(cwd, ['diff', '--no-color', '--no-index', '--', os.platform() === 'win32' ? 'NUL' : '/dev/null', file])
    : await git(cwd, ['diff', '--no-color', 'HEAD', '--', file]);
  // --no-index answers 1 when there is a difference, which for a new file is always.
  if (!r.ok && !(untracked && r.code === 1)) {
    const s = await git(cwd, ['diff', '--no-color', '--cached', '--', file]);   // no commits yet
    if (s.ok && s.out) return { file, ...parseDiff(s.out), raw: s.out };
    return { file, header: [], hunks: [], error: r.err.trim() || 'no diff' };
  }
  return { file, ...parseDiff(r.out), raw: r.out };
}

/**
 * Put one hunk back the way the last commit had it. The diff is read again and the hunk must
 * still be the one the user saw (its @@ line), so a file the agent changed meanwhile is not
 * edited blind. Applied in reverse to the working tree only.
 */
async function revertHunk(cwd, file, index, expectHeader) {
  const d = await fileDiff(cwd, file);
  const h = d.hunks && d.hunks[index];
  if (!h) return { ok: false, error: 'That change is no longer there; the review was refreshed.' };
  if (expectHeader && h.header !== expectHeader) return { ok: false, error: 'The file changed since the review was opened; it was refreshed. Look again, then put it back.' };
  const patch = d.header.filter((l) => /^(diff --git|index |--- |\+\+\+ |old mode|new mode|deleted file mode|new file mode)/.test(l)).join('\n') + '\n' + hunkText(h);
  const tmp = path.join(os.tmpdir(), `vox-hunk-${process.pid}-${Date.now()}.patch`);
  await fsp.writeFile(tmp, patch, 'utf8');
  try {
    const r = await git(cwd, ['apply', '-R', '--whitespace=nowarn', tmp]);
    return r.ok ? { ok: true } : { ok: false, error: (r.err || 'git apply refused it').trim().slice(0, 300) };
  } finally { fsp.unlink(tmp).catch(() => {}); }
}

/**
 * Put a whole file back: a changed or deleted file as the last commit had it. A file new since
 * then is NOT deleted here -- main sends it to the Recycle Bin (shell.trashItem), so it can be
 * got back. Returns { ok, trash: fullPath } for that case.
 */
async function discardFile(cwd, file, kind) {
  if (kind === '?' || kind === 'A') {
    if (kind === 'A') await git(cwd, ['rm', '--cached', '-q', '--', file]);
    return { ok: true, trash: path.join(cwd, file) };
  }
  const r = await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file]);
  if (r.ok) return { ok: true };
  const c = await git(cwd, ['checkout', 'HEAD', '--', file]);
  return c.ok ? { ok: true } : { ok: false, error: (c.err || r.err).trim().slice(0, 300) };
}

/** Commit exactly these files (deletions included) with this message. */
async function commit(cwd, files, message) {
  const list = (files || []).map(String).filter(Boolean);
  if (!list.length) return { ok: false, error: 'Pick at least one file to commit.' };
  if (!String(message || '').trim()) return { ok: false, error: 'Write a commit message first.' };
  const add = await git(cwd, ['add', '-A', '--', ...list]);
  if (!add.ok) return { ok: false, error: add.err.trim().slice(0, 300) };
  const tmp = path.join(os.tmpdir(), `vox-commit-${process.pid}-${Date.now()}.txt`);
  await fsp.writeFile(tmp, String(message).trim() + '\n', 'utf8');
  try {
    const r = await git(cwd, ['commit', '-F', tmp, '--', ...list]);
    if (!r.ok) return { ok: false, error: (r.err || r.out).trim().slice(0, 400) };
    const h = await git(cwd, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, hash: h.out.trim(), summary: r.out.split('\n')[0] };
  } finally { fsp.unlink(tmp).catch(() => {}); }
}

/** Push the branch to origin, setting it as the upstream the first time. */
async function push(cwd) {
  const r = await git(cwd, ['push', '-u', 'origin', 'HEAD'], { timeout: 120000 });
  return r.ok ? { ok: true, out: (r.err || r.out).trim().slice(-400) } : { ok: false, error: (r.err || r.out).trim().slice(-500) || 'push failed' };
}

/** Open a pull request on GitHub for this branch (gh), or say why it cannot. */
async function createPr(cwd, title, body) {
  const auth = await gh(cwd, ['auth', 'status']);
  if (auth.missing) return { ok: false, error: 'The GitHub CLI (gh) is not installed. Install it (winget install GitHub.cli), sign in with "gh auth login", then try again.' };
  if (!auth.ok) return { ok: false, error: 'gh is not signed in. Run "gh auth login" in the terminal panel, then try again.' };
  const r = await gh(cwd, ['pr', 'create', '--title', String(title || '').slice(0, 250), '--body', String(body || '')], { timeout: 60000 });
  if (!r.ok) {
    const existing = /already exists[^\n]*\n?(https?:\/\/\S+)/i.exec(r.err + '\n' + r.out);
    if (existing) return { ok: true, url: existing[1], existed: true };
    return { ok: false, error: (r.err || r.out).trim().slice(0, 500) };
  }
  const url = (/(https?:\/\/\S+\/pull\/\d+)/.exec(r.out) || [])[1] || r.out.trim();
  return { ok: true, url };
}

/** The pull request for this branch, and its checks. */
async function prChecks(cwd) {
  const pr = await gh(cwd, ['pr', 'view', '--json', 'number,url,title,state']);
  if (pr.missing) return { ok: false, error: 'gh is not installed' };
  if (!pr.ok) return { ok: true, pr: null, checks: [] };
  let info = null; try { info = JSON.parse(pr.out); } catch { /* none */ }
  const c = await gh(cwd, ['pr', 'checks', '--json', 'name,state,bucket,link,workflow']);
  let checks = [];
  try { checks = JSON.parse(c.out || '[]'); } catch { /* none yet */ }
  return { ok: true, pr: info, checks: Array.isArray(checks) ? checks : [] };
}

/** The failing part of a GitHub Actions run's log, from a check's link (for "Fix with the agent"). */
async function failedLog(cwd, link) {
  const id = (/\/actions\/runs\/(\d+)/.exec(String(link || '')) || [])[1];
  if (!id) return { ok: false, error: 'That check is not a GitHub Actions run, so its log cannot be fetched here.' };
  const r = await gh(cwd, ['run', 'view', id, '--log-failed'], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: (r.err || 'could not read the log').trim().slice(0, 300) };
  const lines = r.out.split('\n');
  return { ok: true, log: lines.slice(-200).join('\n').slice(-12000) };
}

/** The diff of the files about to be committed, cut to size, for writing the message. */
async function diffForMessage(cwd, files) {
  const list = (files || []).map(String).filter(Boolean);
  const stat = await git(cwd, ['diff', 'HEAD', '--stat', '--', ...list]);
  const d = await git(cwd, ['diff', 'HEAD', '--no-color', '--', ...list]);
  let text = (stat.out || '') + '\n' + (d.out || '');
  const st = await status(cwd);
  for (const f of (st.files || []).filter((x) => x.status === '?' && list.includes(x.path))) {
    try { const t = await fsp.readFile(path.join(cwd, f.path), 'utf8'); text += `\nnew file ${f.path}:\n` + t.slice(0, 3000); } catch { /* gone */ }
  }
  return text.slice(0, 14000);
}

module.exports = { status, fileDiff, parseDiff, hunkText, revertHunk, discardFile, commit, push, createPr, prChecks, failedLog, diffForMessage, hostOf };
