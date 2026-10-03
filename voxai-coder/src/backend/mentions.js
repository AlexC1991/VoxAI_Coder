/**
 * @-mentions -- files and folders named in a message, sent with it.
 *
 * "@src/game.js why does the ball stick?" gave the model a path it then had to go and read,
 * a turn (and, on a paid model, a request) spent on fetching what the user had just pointed
 * at. Now what is mentioned goes with the message: a file's contents, a folder's listing.
 * Only what the PERSON typed is expanded -- a model cannot mention anything into its own
 * context -- so an absolute path (a file dropped from elsewhere) is allowed as well.
 *
 * The contents ride as a second text part of the user message, marked [VOX FILES]; the chat
 * draws only the first part, so the bubble shows what was typed, not the files.
 */
const fsp = require('fs').promises;
const path = require('path');

const FILE_MAX = 100 * 1024;    // per file; more is cut, and said
const TOTAL_MAX = 300 * 1024;   // all mentions together
const DIR_MAX = 200;            // entries listed per folder
const SKIP_DIRS = new Set(['node_modules', '.git', '.voxai', 'dist', 'build', 'release', '__pycache__', '.venv', 'venv', '.next', 'target']);

/** The @tokens in a message: @path, or @"a path with spaces". Trailing punctuation is not part of it. */
function findMentions(text) {
  const out = [];
  const re = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const p = (m[2] || m[3] || '').replace(/[.,;:!?)\]]+$/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function fence(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return { js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx', py: 'python', json: 'json', html: 'html', css: 'css', md: 'markdown', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml' }[ext] || '';
}

async function listDir(full) {
  const names = [];
  const walk = async (d, prefix, depth) => {
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (names.length >= DIR_MAX) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { names.push(prefix + e.name + '/ (not listed)'); continue; }
        names.push(prefix + e.name + '/');
        if (depth < 2) await walk(path.join(d, e.name), prefix + e.name + '/', depth + 1);
      } else names.push(prefix + e.name);
    }
  };
  await walk(full, '', 0);
  return names;
}

/**
 * The mentioned files' contents, ready to send. Returns { text, used, missing }:
 * text is '' when nothing mentioned exists (an @ in ordinary writing, an email-ish word).
 */
async function expandMentions(message, workdir) {
  const used = [], missing = [];
  let total = 0;
  const blocks = [];
  for (const p of findMentions(message)) {
    const full = path.isAbsolute(p) ? path.normalize(p) : path.resolve(String(workdir || ''), p);
    let st;
    try { st = await fsp.stat(full); } catch { missing.push(p); continue; }
    const rel = workdir && (full === path.resolve(workdir) || full.startsWith(path.resolve(workdir) + path.sep))
      ? (path.relative(workdir, full).replace(/\\/g, '/') || '.') : full;
    if (st.isDirectory()) {
      const names = await listDir(full);
      blocks.push(`### ${rel}/ (folder)\n` + names.map((n) => '- ' + n).join('\n') + (names.length >= DIR_MAX ? `\n- ... (first ${DIR_MAX} shown)` : ''));
      used.push({ path: rel, kind: 'folder', entries: names.length });
      continue;
    }
    if (total >= TOTAL_MAX) { blocks.push(`### ${rel}\n(not included: the mentions already add up to ${Math.round(TOTAL_MAX / 1024)} KB; read it with the read tool)`); used.push({ path: rel, kind: 'skipped' }); continue; }
    let buf;
    try { buf = await fsp.readFile(full); } catch { missing.push(p); continue; }
    if (buf.subarray(0, 8192).includes(0)) { blocks.push(`### ${rel}\n(a binary file, ${st.size} bytes: not included)`); used.push({ path: rel, kind: 'binary' }); continue; }
    const room = Math.min(FILE_MAX, TOTAL_MAX - total);
    const cut = buf.length > room;
    const body = buf.subarray(0, room).toString('utf8');
    total += Math.min(buf.length, room);
    blocks.push(`### ${rel}${cut ? ` (first ${Math.round(room / 1024)} KB of ${Math.round(buf.length / 1024)} KB; read the rest with the read tool)` : ''}\n\`\`\`${fence(rel)}\n${body}${body.endsWith('\n') ? '' : '\n'}\`\`\``);
    used.push({ path: rel, kind: 'file', bytes: buf.length, cut });
  }
  if (!blocks.length) return { text: '', used, missing };
  return {
    text: '[VOX FILES] The user mentioned these with @. Their current contents (no need to read them again):\n\n' + blocks.join('\n\n'),
    used, missing,
  };
}

/**
 * The project's files, for the @ picker: git's own list when it is a repository (tracked and
 * new, ignored left out), otherwise a walk that skips the usual heavy folders. Folders are
 * included so a whole one can be mentioned. Capped; cached per folder for a short while.
 */
const listed = new Map();   // workdir -> { at, files }
async function projectFiles(workdir, { max = 8000, ttlMs = 20000 } = {}) {
  const root = String(workdir || '');
  if (!root) return [];
  const hit = listed.get(root);
  if (hit && Date.now() - hit.at < ttlMs) return hit.files;
  let files = null;
  try {
    const out = await new Promise((resolve, reject) => require('child_process').execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, (e, so) => (e ? reject(e) : resolve(so))));
    files = String(out).split('\0').filter(Boolean).slice(0, max);
  } catch { /* not a repository, or no git */ }
  if (!files) {
    files = [];
    const walk = async (d, prefix) => {
      if (files.length >= max) return;
      let ents = [];
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (files.length >= max) return;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(d, e.name), prefix + e.name + '/'); }
        else files.push(prefix + e.name);
      }
    };
    await walk(root, '');
  }
  const dirs = new Set();
  for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/'); }
  const all = [...dirs, ...files];
  listed.set(root, { at: Date.now(), files: all });
  return all;
}

module.exports = { findMentions, expandMentions, projectFiles, FILE_MAX, TOTAL_MAX };
