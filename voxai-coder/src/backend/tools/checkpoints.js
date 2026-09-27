/**
 * checkpoints -- each run's file changes, as the files were before it, so /rewind can put
 * them back.
 *
 * Snapshots only exist when the agent decides to take one, so after a run went wrong there
 * was nothing to go back to. Here nothing is asked of the agent: before a run's first
 * change to a file (write, edit, patch, fs move / remove) the original is kept -- or the
 * fact that there was none, so a file the run created can be taken away again. Only what
 * the agent changed through those tools: a shell command's changes are not seen.
 *
 * On disk: <userData>/checkpoints/<sessionId>/<runId>.json plus one copy per file.
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;   // bigger files are noted, not copied
const KEEP_RUNS = 30;                 // per session; older checkpoints are dropped

const dirOf = (userData, sessionId) => path.join(userData, 'checkpoints', String(sessionId).replace(/[^\w.-]/g, '_'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function inside(root, rel) {
  if (!root || !rel) return null;
  const full = path.resolve(root, String(rel));
  const r = path.resolve(root);
  return full === r || full.startsWith(r + path.sep) ? full : null;
}

/** A run is starting: its checkpoint is made on its first change, not before. */
function startRun(session) {
  session._checkpoint = { id: 'cp_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex'), sessionId: session.id,
    workdir: session.workdir, createdAt: new Date().toISOString(), files: [], seen: new Set() };
}

/** The files a tool call is about to change (relative paths), from its arguments. */
function pathsOf(name, args) {
  const a = args || {};
  if (['write', 'edit', 'patch'].includes(name)) return a.path ? [a.path] : [];
  if (name === 'fs' && a.action === 'move') return [a.source, a.destination].filter(Boolean);
  if (name === 'fs' && a.action === 'remove') return a.path ? [a.path] : [];
  if (name === 'move') return [a.source, a.destination].filter(Boolean);
  if (name === 'remove') return a.path ? [a.path] : [];
  return [];
}

/** Keep each file as it is now, once per run, before the run changes it. Never throws. */
async function before(userData, session, rels) {
  const cp = session && session._checkpoint;
  if (!cp || !userData) return;
  // The checkpoint's own session: a worker writing into its parent run's checkpoint saves it there.
  const dir = dirOf(userData, cp.sessionId);
  let added = false;
  for (const rel of rels) {
    const full = inside(cp.workdir, rel);
    if (!full) continue;
    const key = path.relative(cp.workdir, full).replace(/\\/g, '/');
    if (cp.seen.has(key)) continue;
    cp.seen.add(key);
    try {
      const st = await fsp.stat(full).catch(() => null);
      if (!st) { cp.files.push({ path: key, existed: false }); added = true; continue; }
      if (st.isDirectory()) { cp.files.push({ path: key, existed: true, dir: true }); added = true; continue; }
      if (st.size > MAX_BYTES) { cp.files.push({ path: key, existed: true, tooBig: true }); added = true; continue; }
      const buf = await fsp.readFile(full);
      await fsp.mkdir(dir, { recursive: true });
      const copy = cp.id + '_' + sha(Buffer.from(key)).slice(0, 16);
      await fsp.writeFile(path.join(dir, copy), buf);
      cp.files.push({ path: key, existed: true, copy, hash: sha(buf) });
      added = true;
    } catch { /* unreadable: nothing to keep */ }
  }
  if (!added) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const { seen, ...rest } = cp;
    await fsp.writeFile(path.join(dir, cp.id + '.json'), JSON.stringify(rest, null, 2), 'utf8');
    // Keep the newest KEEP_RUNS checkpoints.
    const all = (await fsp.readdir(dir)).filter((f) => /^cp_\d+_[0-9a-f]+\.json$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_RUNS))) await drop(dir, old.replace(/\.json$/, ''));
  } catch { /* the change goes ahead; this run just cannot be rewound */ }
}

async function drop(dir, id) {
  try {
    for (const f of await fsp.readdir(dir)) if (f.startsWith(id)) await fsp.rm(path.join(dir, f), { force: true });
  } catch { /* already gone */ }
}

/** The session's checkpoints, newest first: { id, createdAt, files }. */
async function list(userData, sessionId) {
  const dir = dirOf(userData, sessionId);
  let names = [];
  try { names = (await fsp.readdir(dir)).filter((f) => /^cp_\d+_[0-9a-f]+\.json$/.test(f)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { const c = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); if (c.files && c.files.length) out.push(c); } catch { /* broken: skip */ }
  }
  return out;
}

/**
 * Undo the newest checkpoint: files the run changed go back to how they were, files it
 * created go to the Recycle Bin (`trash`), and the checkpoint is used up -- so /rewind
 * again goes one run further back. { ok, restored, removed, unchanged, skipped, failed, when }.
 */
async function rewind(userData, sessionId, trash) {
  const cps = await list(userData, sessionId);
  if (!cps.length) return { ok: false, error: 'nothing to rewind: no file changes by the agent are on record for this session' };
  const cp = cps[0];
  const dir = dirOf(userData, sessionId);
  const restored = [], removed = [], unchanged = [], skipped = [], failed = [];
  // Newest change last in the list; undo in reverse so a move's two ends come back in order.
  for (const f of cp.files.slice().reverse()) {
    const full = inside(cp.workdir, f.path);
    if (!full) { failed.push(f.path); continue; }
    try {
      if (f.dir || f.tooBig) { skipped.push(f.path + (f.tooBig ? ' (over 5 MB, not kept)' : ' (a folder)')); continue; }
      if (!f.existed) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st) { unchanged.push(f.path); continue; }
        if (typeof trash === 'function') await trash(full); else await fsp.rm(full, { force: true });
        removed.push(f.path);
        continue;
      }
      const buf = await fsp.readFile(path.join(dir, f.copy));
      const now = await fsp.readFile(full).catch(() => null);
      if (now && sha(now) === f.hash) { unchanged.push(f.path); continue; }
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, buf);
      restored.push(f.path);
    } catch { failed.push(f.path); }
  }
  await drop(dir, cp.id);
  return { ok: true, when: cp.createdAt, restored, removed, unchanged, skipped, failed, left: cps.length - 1 };
}

module.exports = { startRun, pathsOf, before, list, rewind, dirOf };
