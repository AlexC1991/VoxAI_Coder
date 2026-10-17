/**
 * verify — run a cheap correctness check on a file the agent just changed, and
 * return the diagnostics as part of the tool result.
 *
 * This is the step that makes the loop self-correcting. Without it the only thing
 * pushing the model to check its own work is a sentence in the system prompt asking
 * it nicely — which is the prompt-instead-of-mechanism pattern that made the old
 * XML agent unreliable. With it, a broken edit comes back as a FAILED tool result on
 * the very next turn, carrying the compiler's own error text, and the model fixes it
 * without anyone writing recovery logic.
 *
 * Deliberate constraints:
 *   - The edit has already been written. Verification REPORTS, it does not revert:
 *     silently undoing work the model just did is more confusing than a red result.
 *   - Everything is best-effort. A missing toolchain, an unknown extension or a
 *     timeout yields "skipped", never an error — verification must not be able to
 *     fail an edit that actually succeeded.
 *   - No shell. execFile with an argument array, on a path already confined to the
 *     workdir by resolveIn.
 */
const { execFile } = require('child_process');
const path = require('path');
const fsp = require('fs').promises;

const TIMEOUT_MS = (() => {
  const n = Number(process.env.VOX_VERIFY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
})();

const MAX_DIAG_CHARS = 2000;

// ext -> { cmd, args(file) }. Only checks that are FAST and file-local belong here.
// Project-wide checkers (tsc --noEmit, eslint, mypy) are intentionally absent: they
// are slow, they report problems in files the model did not touch, and on a single
// file they produce false errors about missing imports and types.
const CHECKERS = {
  '.js': (f) => ['node', ['--check', f]],
  '.cjs': (f) => ['node', ['--check', f]],
  '.mjs': (f) => ['node', ['--check', f]],
  // Most Linux distributions ship only python3; plain "python" is missing or Python 2.
  '.py': (f) => [process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', f]],
  '.rb': (f) => ['ruby', ['-c', f]],
  '.php': (f) => ['php', ['-l', f]],
  '.sh': (f) => ['bash', ['-n', f]],
  '.bash': (f) => ['bash', ['-n', f]],
};

function trimDiag(s) {
  const t = String(s || '').trim();
  return t.length > MAX_DIAG_CHARS ? `${t.slice(0, MAX_DIAG_CHARS)}\n…[truncated]` : t;
}

/** JSON is checked in-process — no subprocess, and a far better error message. */
async function verifyJson(fullPath) {
  let text;
  try { text = await fsp.readFile(fullPath, 'utf8'); }
  catch { return { verified: 'skipped', reason: 'unreadable' }; }
  try {
    JSON.parse(text);
    return { verified: 'ok', checker: 'JSON.parse' };
  } catch (e) {
    // Turn the byte offset into line:col — "position 8423" is not actionable.
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const upto = text.slice(0, Number(m[1]));
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      where = ` (line ${line}, column ${col})`;
    }
    return { verified: 'failed', checker: 'JSON.parse', diagnostics: `${e.message}${where}` };
  }
}

/**
 * JavaScript, checked in this process: no Node to start. Started fresh for every edit,
 * `node --check` took ~3.8 s on a busy PC against a 4 s limit, so the check was quietly
 * "skipped" and broken code was reported as written fine. A script (CommonJS) is compiled
 * the way Node wraps a module; an ES module (import/export) cannot be compiled here without
 * flags, so it alone still goes to `node --check`, as a .mjs copy, with longer to answer.
 */
const ESM_TIMEOUT_MS = Math.max(TIMEOUT_MS, 15000);
async function verifyJs(fullPath, ext) {
  let src;
  try { src = await fsp.readFile(fullPath, 'utf8'); } catch { return { verified: 'skipped', reason: 'unreadable' }; }
  if (ext !== '.mjs') {
    const body = src.replace(/^#![^\n]*/, '');   // a shebang line is fine in a file Node runs
    try {
      // The wrapper sits on the file's first line, so line numbers in an error stay right.
      new (require('vm').Script)(`(function (exports, require, module, __filename, __dirname) {${body}\n})`, { filename: fullPath });
      return { verified: 'ok', checker: 'node' };
    } catch (e) {
      if (!/import statement|Unexpected token 'export'|import\.meta|await is only valid|Cannot use import/.test(String(e && e.message))) {
        return { verified: 'failed', checker: 'node', diagnostics: trimDiag(String((e && e.stack) || e).split('\n    at ')[0].split('(function (exports, require, module, __filename, __dirname) {').join('')) };
      }
    }
  }
  // An ES module (or a .mjs): Node itself, on a .mjs copy so the project's package.json cannot
  // make it read the file as a script (see the RTS note in verifyFile).
  const tmp = path.join(require('os').tmpdir(), `vox-check-${process.pid}-${Date.now()}.mjs`);
  try {
    await fsp.writeFile(tmp, src, 'utf8');
    const r = await run('node', ['--check', tmp], ESM_TIMEOUT_MS);
    if (r.missing) return { verified: 'skipped', reason: 'node not available' };
    if (r.timedOut) return { verified: 'skipped', reason: `node timed out after ${ESM_TIMEOUT_MS}ms` };
    if (r.ok) return { verified: 'ok', checker: 'node (as an ES module)' };
    return { verified: 'failed', checker: 'node', diagnostics: String(r.out || '').split(tmp).join(fullPath) };
  } catch { return { verified: 'skipped', reason: 'could not check' }; }
  finally { fsp.unlink(tmp).catch(() => {}); }
}

function run(cmd, args, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        const out = trimDiag(`${stderr || ''}${stdout || ''}`);
        if (!err) return resolve({ ok: true, out });
        // ENOENT = the toolchain simply isn't installed on this machine.
        if (err.code === 'ENOENT') return resolve({ missing: true });
        if (err.killed) return resolve({ timedOut: true });
        resolve({ ok: false, out: out || String(err.message || 'check failed') });
      });
    } catch {
      return resolve({ missing: true });
    }
    child.on('error', () => resolve({ missing: true }));
  });
}

/**
 * Check one file. Always resolves; never throws.
 * @returns {{verified:'ok'|'failed'|'skipped', checker?:string, diagnostics?:string, reason?:string}}
 */
async function verifyFile(fullPath) {
  if (process.env.VOX_DISABLE_VERIFY) return { verified: 'skipped', reason: 'disabled' };
  const ext = path.extname(String(fullPath || '')).toLowerCase();
  if (ext === '.json') return verifyJson(fullPath);
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return verifyJs(fullPath, ext);

  const make = CHECKERS[ext];
  if (!make) return { verified: 'skipped', reason: `no checker for ${ext || 'this file type'}` };

  const [cmd, args] = make(fullPath);
  const r = await run(cmd, args);
  if (r.missing) return { verified: 'skipped', reason: `${cmd} not available` };
  if (r.timedOut) return { verified: 'skipped', reason: `${cmd} timed out after ${TIMEOUT_MS}ms` };
  if (r.ok) return { verified: 'ok', checker: cmd };
  return { verified: 'failed', checker: cmd, diagnostics: r.out };
}

/**
 * Attach verification to a write/edit/patch result.
 *
 * A failed check is surfaced as a THROWN error so the agent loop records it as a
 * failed tool result: the model sees red and fixes it, instead of a success payload
 * with a warning buried in a field it may not read. The file keeps the new content
 * either way — the message says so explicitly, so the model does not re-apply an
 * edit that already landed.
 */
async function withVerification(result, fullPath, relPath) {
  const v = await verifyFile(fullPath);
  if (v.verified === 'failed') {
    const err = new Error(
      `${relPath || fullPath} was written, but it does not parse — fix it in your next edit.\n`
      + `${v.checker}:\n${v.diagnostics}`,
    );
    err.verification = v;
    throw err;
  }
  return Object.assign({}, result, { verification: v });
}

module.exports = { verifyFile, withVerification, CHECKERS };
