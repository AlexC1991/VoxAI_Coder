/**
 * snapshot — save the project's files before a risky change, and put them back.
 *
 * It used to copy files only when the model listed them (it rarely did), and restore
 * only rewrote the session transcript -- never a file -- while the running agent kept
 * its own copy of the conversation. Asked to snapshot, edit and restore, the agent
 * restored seven times and the edit was still there. Found in a live run.
 *
 * Now: create copies the project's files (or the ones named), restore writes them back
 * inside the project, and neither touches the conversation.
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 300;
const MAX_BYTES = 256 * 1024;             // larger files are listed as skipped, not copied
const SKIP_DIRS = new Set(['node_modules', '.git', '.voxai', 'dist', 'build', 'release', 'out', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache']);

function snapDir(userData) {
  return path.join(userData, 'snapshots');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The project's files, relative, skipping dependency and build folders. */
async function projectFiles(root, max = MAX_FILES) {
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= max || depth > 8) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), depth + 1); }
      else if (e.isFile()) out.push(path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/'));
    }
  }
  await walk(root, 0);
  return out;
}

/** A path inside the project, or null. */
function inside(root, rel) {
  const full = path.resolve(root, rel);
  const r = path.relative(root, full);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? full : null;
}

async function createSnapshot({ userData, session, files }) {
  const dir = snapDir(userData);
  const root = session.workdir;
  const snapId = 'snap_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex');
  const list = (Array.isArray(files) && files.length ? files : await projectFiles(root)).slice(0, MAX_FILES);
  const snap = { id: snapId, sessionId: session.id, workdir: root, createdAt: new Date().toISOString(), files: [], skipped: [] };
  await fsp.mkdir(dir, { recursive: true });
  for (const f of list) {
    const full = inside(root, f);
    if (!full) { snap.skipped.push({ path: f, why: 'outside the project' }); continue; }
    try {
      const buf = await fsp.readFile(full);
      if (buf.length > MAX_BYTES) { snap.skipped.push({ path: f, why: 'larger than 256 KB' }); continue; }
      const fname = snapId + '_' + sha256(Buffer.from(f)).slice(0, 16);
      await fsp.writeFile(path.join(dir, fname), buf);
      snap.files.push({ path: f.replace(/\\/g, '/'), hash: sha256(buf), size: buf.length, copy: fname });
    } catch { /* gone or unreadable: nothing to save */ }
  }
  await fsp.writeFile(path.join(dir, snapId + '.json'), JSON.stringify(snap, null, 2), 'utf8');
  return { id: snapId, files: snap.files.length, skipped: snap.skipped.length };
}

async function listSnapshots(userData, sessionId) {
  try {
    const names = await fsp.readdir(snapDir(userData));
    const out = [];
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      try {
        const o = JSON.parse(await fsp.readFile(path.join(snapDir(userData), f), 'utf8'));
        if (!sessionId || o.sessionId === sessionId) out.push({ id: o.id, createdAt: o.createdAt, files: o.files ? o.files.length : 0 });
      } catch {}
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  } catch { return []; }
}

/** Put the snapshot's files back. Files created since are left alone. */
async function restoreSnapshot({ userData, id, workdir }) {
  let snap;
  try { snap = JSON.parse(await fsp.readFile(path.join(snapDir(userData), id + '.json'), 'utf8')); }
  catch { return { ok: false, error: 'no snapshot ' + id + ' (see snapshot list)' }; }
  const root = snap.workdir || workdir;
  if (!root || !Array.isArray(snap.files)) return { ok: false, error: 'this snapshot has no saved files' };
  const restored = [], unchanged = [], failed = [];
  for (const f of snap.files) {
    const full = inside(root, f.path);
    if (!full || !f.copy) { failed.push(f.path); continue; }
    try {
      const buf = await fsp.readFile(path.join(snapDir(userData), f.copy));
      let now = null; try { now = await fsp.readFile(full); } catch {}
      if (now && sha256(now) === f.hash) { unchanged.push(f.path); continue; }
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, buf);
      restored.push(f.path);
    } catch { failed.push(f.path); }
  }
  return { ok: true, restored, unchanged: unchanged.length, failed, note: 'Files created after the snapshot were left in place.' };
}

function makeSnapshotTool({ userData }) {
  return {
    def: {
      type: 'function',
      function: {
        name: 'snapshot',
        description: 'Save the project\'s files before a risky change, and put them back. Actions: create (copies the project\'s files, or only `files` if given; returns an id), list (this session\'s snapshots), restore (writes the snapshot\'s files back by id; files created since are left in place). It does not touch the conversation.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'list', 'restore'] },
            files: { type: 'array', items: { type: 'string' }, description: 'Only these files (relative paths). Leave out to save the whole project.' },
            id: { type: 'string', description: 'Snapshot id for restore.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      const a = args.action;
      if (a === 'create') return await createSnapshot({ userData, session: ctx.session, files: args.files });
      if (a === 'list') return { snapshots: await listSnapshots(userData, ctx.session.id) };
      if (a === 'restore') {
        if (!args.id) throw new Error('restore needs an id (see snapshot list)');
        // Restoring rewrites files: it asks like any other change (create and list only read).
        if (ctx.checkPermission) await ctx.checkPermission('write-file', 'restore snapshot ' + args.id);
        return await restoreSnapshot({ userData, id: args.id, workdir: ctx.session.workdir });
      }
      throw new Error('unknown snapshot action');
    },
  };
}

module.exports = { makeSnapshotTool, listSnapshots, createSnapshot, restoreSnapshot, snapDir, projectFiles };
