/**
 * lsp — bounded syntax/type diagnostics for the project (lsp.inspect).
 * Inspired by AI_GUI's lsp.inspect / tests. Runs tsc / py_compile / node --check /
 * eslint-ish checks per file type without a full LSP server (fast, dependency-light).
 */
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

/**
 * Run a checker. Two ways it went wrong on Windows, both found in a live run:
 *  - a .cmd launcher (npx.cmd) cannot be spawned without a shell -- Node refuses with
 *    EINVAL -- so every TypeScript check "failed"; it now goes through cmd.exe;
 *  - `node --check` used process.execPath, which inside the app is the app itself:
 *    each JS file started another Electron that sat until the timeout and "failed".
 *    Callers pass { node: true } to run it as plain Node.
 */
function run(cmd, args, cwd, timeoutMs = 60000, { node = false } = {}) {
  return new Promise((resolve) => {
    try {
      const opts = { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
      if (node) opts.env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
        const q = (a) => (/[\s"&|<>^]/.test(a) ? '"' + String(a).replace(/"/g, '""') + '"' : a);
        args = ['/d', '/s', '/c', '"' + [cmd, ...args].map(q).join(' ') + '"'];
        cmd = 'cmd.exe';
        opts.windowsVerbatimArguments = true;
      }
      execFile(cmd, args, opts, (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch { resolve({ code: 1, stdout: '', stderr: 'failed to launch ' + cmd }); }
  });
}

async function resolveFiles(workdir, paths, limit = 50) {
  const out = [];
  for (const p of (paths && paths.length ? paths : ['src', '.'])) {
    const full = path.join(workdir, p);
    try { const st = await fsp.stat(full); if (st.isFile()) out.push(full); }
    catch { /* skip */ }
  }
  if (!paths || !paths.length) {
    // scan for common source dirs
    for (const dir of ['src', 'lib', 'core', 'services', 'app']) {
      try {
        const ents = await fsp.readdir(path.join(workdir, dir), { withFileTypes: true });
        for (const e of ents) if (e.isFile()) out.push(path.join(workdir, dir, e.name));
      } catch {}
    }
  }
  return out.slice(0, limit);
}

function kindFor(file) {
  if (/\.(ts|tsx)$/i.test(file)) return 'ts';
  if (/\.(js|jsx|mjs|cjs)$/i.test(file)) return 'js';
  if (/\.py$/i.test(file)) return 'py';
  if (/\.(json)$/i.test(file)) return 'json';
  return null;
}

function makeLspTool() {
  return {
    def: {
      type: 'function',
      function: {
        name: 'lsp',
        description: 'Run fast syntax/type diagnostics on project files (tsc for TS/JS, python -m py_compile for Python, JSON.parse for JSON, node --check for JS). Returns checked/failed/unsupported counts and the first errors. Use after edits to verify before claiming done.',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: 'Optional file paths relative to workdir. Omit to check the common source set.' },
            timeout_secs: { type: 'number', minimum: 5, maximum: 300 },
          },
          additionalProperties: false,
        },
      },
    },
    async run(args, ctx) {
      const files = await resolveFiles(ctx.workdir, args.paths);
      const results = { checked: 0, failed: 0, unsupported: 0, errors: [] };
      const byKind = {};
      for (const f of files) {
        const k = kindFor(f);
        if (!k) { results.unsupported += 1; continue; }
        (byKind[k] = byKind[k] || []).push(f);
      }
      for (const [kind, list] of Object.entries(byKind)) {
        const rel = list.map((f) => path.relative(ctx.workdir, f));
        if (kind === 'ts') {
          if (await hasBinary('tsc')) {
            const r = await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--noEmit', ...rel], ctx.workdir, (args.timeout_secs || 120) * 1000);
            results.checked += list.length;
            if (r.code) { results.failed += list.length; results.errors.push({ kind: 'tsc', files: rel.slice(0, 10), total: list.length, output: (r.stdout || r.stderr).slice(0, 2000) }); }
          } else {
            // fallback: node --check-ish via tsc unavailable → per-file JS check below
            results.unsupported += list.length;
          }
        } else if (kind === 'js' || kind === 'json') {
          for (const f of list) {
            const r = kind === 'json'
              ? await (async () => { try { JSON.parse(await fsp.readFile(f, 'utf8')); return { code: 0 }; } catch (e) { return { code: 1, stderr: e.message }; } })()
              : await run(process.execPath, ['--check', f], ctx.workdir, 60000, { node: true });
            results.checked += 1;
            if (r.code) { results.failed += 1; results.errors.push({ kind, file: path.relative(ctx.workdir, f), output: (r.stderr || r.stdout || 'syntax error').slice(0, 1000) }); }
          }
        } else if (kind === 'py') {
          for (const f of list) {
            // python3 off Windows: most Linux distributions have no plain "python" (see verify.js).
            const r = await run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', f], ctx.workdir);
            results.checked += 1;
            if (r.code) { results.failed += 1; results.errors.push({ kind: 'python', file: path.relative(ctx.workdir, f), output: (r.stderr || '').slice(0, 1000) }); }
          }
        }
      }
      results.errors = results.errors.slice(0, 8);
      return results;
    },
  };
}

function hasBinary(name) {
  return new Promise((resolve) => {
    try {
      execFile(process.platform === 'win32' ? 'where' : 'which', [name], (err) => resolve(!err));
    } catch { resolve(false); }
  });
}

module.exports = { makeLspTool };