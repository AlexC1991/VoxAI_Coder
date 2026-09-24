/**
 * snapshot — session + workspace snapshots (backup/restore).
 * Inspired by AI_GUI's snapshots.py + runtime_backup.py + Codex backups.
 * Snapshot stores: the session JSONL copy + a lightweight manifest of key files'
 * hashes (full file copies optional). Restore rolls a session back from its snapshot.
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function snapDir(userData) {
  return path.join(userData, 'snapshots');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function createSnapshot({ userData, session, files }) {
  const dir = snapDir(userData);
  const snapId = 'snap_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex');
  const snap = {
    id: snapId, sessionId: session.id, title: session.title,
    createdAt: new Date().toISOString(),
    messageCount: session.messages.length,
    todos: session.todos || [],
    files: [],
  };
  await fsp.mkdir(dir, { recursive: true });
  // copy session file
  const sessPath = path.join(userData, 'sessions', session.id + '.jsonl');
  try {
    const raw = await fsp.readFile(sessPath, 'utf8');
    snap.sessionSnapshot = raw;
  } catch { snap.sessionSnapshot = null; }
  // hash key workspace files (optionally copy small ones)
  const list = Array.isArray(files) ? files.slice(0, 200) : [];
  for (const f of list) {
    const rel = String(f).replace(/[/\\]/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
    try {
      const buf = await fsp.readFile(path.join(session.workdir, f));
      const hash = sha256(buf);
      const entry = { path: f, hash, size: buf.length };
      if (buf.length <= 200 * 1024) {
        const fname = snapId + '_' + rel;
        await fsp.writeFile(path.join(dir, fname), buf);
        entry.copy = fname;
      }
      snap.files.push(entry);
    } catch { /* file missing → skip */ }
  }
  await fsp.writeFile(path.join(dir, snapId + '.json'), JSON.stringify(snap, null, 2), 'utf8');
  return { id: snapId, messageCount: snap.messageCount, files: snap.files.length };
}

async function listSnapshots(userData, sessionId) {
  try {
    const files = await fsp.readdir(snapDir(userData));
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const o = JSON.parse(await fsp.readFile(path.join(snapDir(userData), f), 'utf8'));
        if (!sessionId || o.sessionId === sessionId) out.push({ id: o.id, sessionId: o.sessionId, title: o.title, createdAt: o.createdAt, messageCount: o.messageCount, files: o.files ? o.files.length : 0 });
      } catch {}
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  } catch { return []; }
}

async function restoreSnapshot({ userData, id, live }) {
  const snap = JSON.parse(await fsp.readFile(path.join(snapDir(userData), id + '.json'), 'utf8'));
  if (!snap.sessionSnapshot) return { ok: false, error: 'snapshot has no session copy' };
  const sessPath = path.join(userData, 'sessions', snap.sessionId + '.jsonl');
  await fsp.mkdir(path.dirname(sessPath), { recursive: true });
  await fsp.writeFile(sessPath, snap.sessionSnapshot, 'utf8');
  if (live) {
    const store = require('../sessions');
    const sess = await store.loadSession(userData, snap.sessionId);
    live.set(snap.sessionId, sess);
  }
  return { ok: true, sessionId: snap.sessionId, messageCount: snap.messageCount, title: snap.title };
}

function makeSnapshotTool({ userData, live }) {
  return {
    def: {
      type: 'function',
      function: {
        name: 'snapshot',
        description: 'Snapshot or restore. Actions: create (save session state + optional file hashes), list (list session snapshots), restore (roll back session to a snapshot by id). Use before risky multi-file changes so work is never lost.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'list', 'restore'] },
            files: { type: 'array', items: { type: 'string' }, description: 'Workspace files to hash/copy into the snapshot (optional).' },
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
        if (!args.id) throw new Error('restore requires id (see snapshot list)');
        const r = await restoreSnapshot({ userData, id: args.id, live });
        return r.ok ? { ok: true, restored: r.sessionId, messageCount: r.messageCount } : { ok: false, error: r.error };
      }
      throw new Error('unknown snapshot action');
    },
  };
}

module.exports = { makeSnapshotTool, listSnapshots, createSnapshot, restoreSnapshot, snapDir };