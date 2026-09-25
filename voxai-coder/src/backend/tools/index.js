/**
 * VoxAI tool surface — our own tools, inspired by (not copied from) Goose.
 *
 * Goose Amap: builtin extensions (developer: shell/file edits; computercontroller;
 * memory/tutorial) + MCP servers over stdio/HTTP, all exposed to the model as
 * tools through the agent loop.
 *
 * Ours: a small, auditable set of plain Node functions with JSON Schemas,
 * executed in-process by the agent loop. MCP stdio client support is stubbed
 * in `mcp.js` for later; tools below are the v0 set the Forge UI needs:
 *   read, write, edit, glob, grep, shell, todo
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, spawn } = require('child_process');
const procs = require('./procs');
const { eolOf, toEol } = require('./eol');
const { decodeOutput } = require('./decode');

function tool(name, description, parameters, run) {
  return { def: { type: 'function', function: { name, description, parameters } }, run };
}

const { markSeen, assertFresh, wasSeen } = require('./freshness');
const { withVerification } = require('./verify');

const READ_MAX_LINES = 2000;

const read = tool('read',
  'Read a text file. Returns numbered-range metadata so you know exactly what you got. '
  + 'Use `offset` (1-based first line) and `limit` to read part of a large file instead of the whole thing.', {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer', description: 'First line to return, 1-based. Default 1.' },
      limit: { type: 'integer', description: 'How many lines to return. Default 2000.' },
    },
    required: ['path'],
    // Without this an unknown argument is accepted and silently dropped. A model
    // asking for a range and being handed the whole file — believing it got the
    // range — is how the same file gets read twice and reasoned about wrongly.
    additionalProperties: false,
  }, async ({ path: p, offset, limit }, ctx) => {
    const full = resolveIn(ctx.workdir, p);
    const buf = await fsp.readFile(full);
    // A binary file read as text came back as mangled bytes the model then reasoned
    // about. Say what it is instead. (A NUL in the first 8 KB is what git calls binary.)
    if (buf.subarray(0, 8192).includes(0)) {
      const ext = path.extname(full).toLowerCase();
      const image = /^\.(png|jpe?g|gif|webp|bmp|ico|svgz)$/.test(ext);
      throw new Error(`${p} is a binary file (${buf.length.toLocaleString()} bytes${ext ? ', ' + ext.slice(1) : ''}), not text, so it cannot be read.`
        + (image ? ' To look at an image, open it with the computer tool (nativePath).' : ''));
    }
    const text = buf.toString('utf8');
    markSeen(full, text); // arms the freshness guard for later edits
    // The newline that ends the last line does not start another: a one-line file
    // read as "2 lines". Found in a live run.
    const lines = text === '' ? [] : text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    const start = Math.max(1, Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 1);
    const count = Math.max(1, Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : READ_MAX_LINES);
    const from = Math.min(start, lines.length || 1);
    const slice = lines.slice(from - 1, from - 1 + count);
    const to = from + slice.length - 1;

    return {
      path: full,
      lines: lines.length,             // total in the file
      from,                            // first line returned (1-based)
      to,                              // last line returned
      returned: slice.length,
      // `truncated` means "there is more AFTER what you got", which is the thing
      // the model needs to decide whether to read on.
      truncated: to < lines.length,
      content: slice.join('\n'),
    };
  });

const write = tool('write', 'Create or overwrite a file (creates parent dirs).', {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
}, async ({ path: p, content }, ctx) => {
  await ctx.checkPermission('write-file', p);
  const full = resolveIn(ctx.workdir, p);
  await assertFresh(full, p);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  // Rewriting a Windows file keeps its line endings: otherwise every line shows as
  // changed in a diff.
  let existing = null;
  try { existing = await fsp.readFile(full, 'utf8'); } catch { existing = null; }
  // Overwriting a file the model has never looked at replaced "important user notes"
  // without a word. It has to read it first -- one step, and nothing is lost unseen.
  if (existing != null && existing.length && !wasSeen(full)) {
    throw new Error(`${p} already exists and you have not read it yet, so it was NOT overwritten. `
      + 'Read it first, then write it (or use edit to change part of it), so nothing in it is lost unseen.');
  }
  if (existing != null) content = toEol(content, eolOf(existing));
  await fsp.writeFile(full, content, 'utf8');
  markSeen(full, content);
  // Syntax-check what we just wrote and hand the diagnostics straight back.
  return withVerification({ path: full, bytes: Buffer.byteLength(content) }, full, p);
});

/**
 * Locate `before` in `text`, tolerating the one difference models reliably get
 * wrong: leading/trailing whitespace per line. Everything else stays exact —
 * fail sharply and let the caller retry with better context, rather than guessing
 * at a fuzzy match and silently editing the wrong region.
 */
function locate(text, before) {
  const exact = text.indexOf(before);
  if (exact !== -1) return { start: exact, end: exact + before.length, how: 'exact' };

  const needle = before.split('\n').map((l) => l.trim());
  // strip a trailing blank line produced by a template literal
  while (needle.length && needle[needle.length - 1] === '') needle.pop();
  if (!needle.length) return null;

  const lines = text.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }

  for (let i = 0; i + needle.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j].trim() !== needle[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const start = starts[i];
    const lastIdx = i + needle.length - 1;
    const end = starts[lastIdx] + lines[lastIdx].length;
    return { start, end, how: 'line-trimmed' };
  }
  return null;
}

const edit = tool('edit', 'Replace the first occurrence of `before` with `after` in a file. Matching is exact, with a fallback that ignores per-line leading/trailing whitespace.', {
  type: 'object',
  properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } },
  required: ['path', 'before', 'after'],
}, async (args, ctx) => {
  // Models trained on other tools send old_string/new_string. That crashed with
  // "Cannot read properties of undefined (reading 'split')", which told them nothing.
  const p = args.path;
  const before = args.before !== undefined ? args.before : (args.old_string !== undefined ? args.old_string : args.old_str);
  const after = args.after !== undefined ? args.after : (args.new_string !== undefined ? args.new_string : args.new_str);
  if (typeof before !== 'string' || typeof after !== 'string') {
    throw new Error('edit needs `before` (the exact text to replace, copied from the file) and `after` (what replaces it), both strings.');
  }
  await ctx.checkPermission('write-file', p);
  const full = resolveIn(ctx.workdir, p);
  await assertFresh(full, p);
  const text = await fsp.readFile(full, 'utf8');
  const eol = eolOf(text);

  const hit = locate(text, toEol(before, eol)) || (eol === '\r\n' ? locate(text, before) : null);
  if (!hit) {
    // Give the retry something to aim at: the model cannot fix a match it cannot see.
    const firstLine = String(before).split('\n').find((l) => l.trim()) || '';
    const probe = firstLine.trim().slice(0, 60);
    const near = [];
    if (probe) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && near.length < 5; i++) {
        if (lines[i].includes(probe)) near.push(`${i + 1}: ${lines[i].slice(0, 160)}`);
      }
    }
    throw new Error(
      `edit: 'before' text not found in ${p}.`
      + (near.length
        ? ` Closest lines containing "${probe}":\n${near.join('\n')}\nRe-read the file and copy the exact text.`
        : ` No line contains "${probe}" either — re-read ${p} before retrying.`),
    );
  }

  const next = text.slice(0, hit.start) + toEol(after, eol) + text.slice(hit.end);
  await fsp.writeFile(full, next, 'utf8');
  markSeen(full, next);
  return withVerification({ path: full, replaced: hit.end - hit.start, match: hit.how }, full, p);
});

const glob = tool('glob', 'List files matching a glob-ish pattern (supports * and **).', {
  type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'],
}, async ({ pattern }, ctx) => {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 12 || out.length > 500) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (matchGlob(path.relative(ctx.workdir, full), pattern)) out.push(path.relative(ctx.workdir, full));
    }
  }
  await walk(ctx.workdir, 0);
  return { pattern, files: out.slice(0, 200), total: out.length };
});

const grep = tool('grep', 'Search file contents for a substring or /regex/flags.', {
  type: 'object',
  properties: { query: { type: 'string' }, include: { type: 'string' } },
  required: ['query'],
}, async ({ query, include }, ctx) => {
  let re;
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(query);
  re = m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : null;
  const hits = [];
  async function walk(dir, depth) {
    if (depth > 10 || hits.length > 200) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (include && !matchGlob(e.name, include)) continue;
      let text;
      try {
        const st = await fsp.stat(full);
        if (st.size > 512 * 1024) continue;
        text = await fsp.readFile(full, 'utf8');
      } catch { continue; }
      const lines = text.split('\n');
      lines.forEach((ln, i) => {
        const ok = re ? (re.lastIndex = 0, re.test(ln)) : ln.includes(query);
        if (ok && hits.length < 200) hits.push({ file: path.relative(ctx.workdir, full), line: i + 1, text: ln.slice(0, 300) });
      });
    }
  }
  await walk(ctx.workdir, 0);
  return { query, hits };
});

// Name the shell. Without this the model assumes bash: in one session its FIRST
// command was `ls -la && ... 2>/dev/null`, cmd.exe answered "'ls' is not recognized",
// and later a `powershell -Command "...$PSVersionTable..."` came back mangled because
// cmd had already eaten the quoting. Each of those is a wasted turn.
const SHELL_DESC = process.platform === 'win32'
  ? 'Run a command in the session workdir. This is WINDOWS and it runs in cmd.exe, not bash: '
    + 'use dir / type / where / findstr, chain with &&, env vars as %VAR%, discard output with >NUL. '
    + 'There is no ls, cat, grep, head or 2>/dev/null. Avoid nesting powershell -Command "..." — cmd '
    + 'mangles the quoting; for anything beyond one simple command, write a .py/.js/.ps1 file and run '
    + 'that instead. Long output is truncated. '
    + 'For a server, a watcher or anything else that keeps running, pass background: true (do not use start /b): '
    + 'it returns once it has started and keeps running until the app closes.'
  : 'Run a command in the session workdir with /bin/sh. Long output is truncated. '
    + 'For a server, a watcher or anything else that keeps running, pass background: true (do not use &): '
    + 'it returns once it has started and keeps running until the app closes.';
const shell = tool('shell', SHELL_DESC, {
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeout_secs: { type: 'number' },
    background: { type: 'boolean', description: 'Keep it running after this call returns (servers, watchers). Returns its first output and its pid.' },
  },
  required: ['command'],
}, ({ command, timeout_secs, background }, ctx) => new Promise(async (resolve, reject) => {
  try { await ctx.checkPermission('shell', command); }
  catch (e) { reject(e); return; }
  if (background) {
    resolve(await procs.startBackground(command, { cwd: ctx.workdir, sessionId: ctx.session && ctx.session.id }));
    return;
  }
  const isWin = process.platform === 'win32';
  // cmd.exe gets the command exactly as written, wrapped in the one pair of quotes /s
  // strips -- what Node's own shell:true does. Left to execFile, every " was escaped
  // as \" first: `node -e "process.exit(3)"` evaluated a string and reported exit 0,
  // and `node -e "console.log('hi there')"` died with a syntax error. Found in a live run.
  // Stop and the time limit end the whole process tree. Ending cmd.exe alone left its
  // children running -- after Stop, a `ping -n 40` carried on to the end. Found in a
  // live run. On Windows that takes taskkill /T; elsewhere the shell's process.
  const killTree = (c) => {
    try {
      if (isWin) execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else c.kill('SIGKILL');
    } catch {}
  };
  let timedOut = false, stopped = false, heldOpen = false, left = [];
  const [exe, argv] = procs.shellArgs(command);
  // Output is kept as a rolling tail, however much there is. A 4 MB buffer used to be
  // the limit: a test run printing 7 MB was killed part-way and reported "exit 1", with
  // its final "ALL TESTS PASSED" line never seen. Found in a live run.
  const TAIL = 256 * 1024;
  const sink = () => ({ chunks: [], size: 0, total: 0 });
  const outS = sink(), errS = sink();
  const keep = (s, b) => {
    s.chunks.push(b); s.size += b.length; s.total += b.length;
    while (s.size - s.chunks[0].length >= TAIL) s.size -= s.chunks.shift().length;
  };
  const child = spawn(exe, argv, { cwd: ctx.workdir, env: procs.childEnv(), windowsHide: true, windowsVerbatimArguments: isWin });
  child.stdout.on('data', (b) => keep(outS, b));
  child.stderr.on('data', (b) => keep(errS, b));
  child.on('close', async (code) => {
    clearTimeout(timer); clearTimeout(graceTimer);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onStop);
    const cap = (s) => decodeOutput(Buffer.concat(s.chunks)).split('\n').slice(-400).join('\n').slice(-12000);
    const skipped = (s) => Math.max(0, s.total - Buffer.byteLength(cap(s)));
    const out = { command, exit: typeof code === 'number' ? code : 1, stdout: cap(outS), stderr: cap(errS),
      ...(timedOut ? { timedOut: true } : {}), ...(stopped ? { stopped: true } : {}) };
    // Say how much was left out, so a long log is not mistaken for the whole of it.
    if (skipped(outS) > 0) out.stdoutOmitted = `${skipped(outS).toLocaleString()} earlier bytes of output are not shown; this is the end of it`;
    if (heldOpen) {
      // The shell is done but something it started is not. Say what, and keep track of
      // it so it does not outlive the app.
      left = await procs.leftovers(child.pid);
      for (const p of left) procs.track({ pid: p.pid, name: p.name, command, sessionId: ctx.session && ctx.session.id });
      out.stillRunning = left;
      out.note = left.length
        ? `The command finished, but ${left.map((p) => `${p.name} (pid ${p.pid})`).join(', ')} it started is still running and kept its output open. `
          + 'It keeps running until the app closes. For servers and watchers pass background: true instead; '
          + `to end it now: ${isWin ? `taskkill /pid ${left[0].pid} /T /F` : `kill ${left[0].pid}`}.`
        : 'The command finished, but something it started held its output open for a while.';
    }
    resolve(out);
  });
  let graceTimer = null;
  // When the shell itself has exited, its output is complete: anything still holding
  // the pipe is a process it left behind (a server started with start /b or &). Waiting
  // for that pipe to close is what hung the run. Give it a moment, then stop waiting.
  child.on('exit', () => {
    graceTimer = setTimeout(() => {
      heldOpen = true;
      try { child.stdout && child.stdout.destroy(); } catch {}
      try { child.stderr && child.stderr.destroy(); } catch {}
    }, 1500);
  });
  // The time limit and Stop end what the command left behind, too: killing a shell that
  // had already exited ended nothing.
  const endAll = () => { killTree(child); procs.leftovers(child.pid).then((ps) => ps.forEach((p) => procs.killTree(p.pid))); };
  const timer = setTimeout(() => { timedOut = true; endAll(); }, Math.min(Math.max(timeout_secs || 120, 5), 600) * 1000);
  const onStop = () => { stopped = true; endAll(); };
  if (ctx.signal) { if (ctx.signal.aborted) onStop(); else ctx.signal.addEventListener('abort', onStop, { once: true }); }
  child.on('error', reject);
}));

// The plan. The user watches it pinned above the message box, so it is only useful
// if it moves: the old description ("Keep a running to-do list visible in the UI")
// never said to call it again, and models wrote a plan once and never ticked a step.
const todo = tool('todo', 'The plan for this task, pinned above the user\'s message box where they follow it. '
  + 'Call it once with every step before you start, then call it again with the whole list each time a step '
  + 'starts or finishes: `active` is the step you are on now, `done` lists finished steps. Keep steps short.', {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'string' }, description: 'Every step, in order, each time.' },
    done: { type: 'array', items: { type: 'number' }, description: '0-based indexes of finished steps.' },
    active: { type: 'number', description: '0-based index of the step in progress now.' },
  },
  required: ['items'],
}, async ({ items, done = [], active }, ctx) => {
  const doneSet = new Set((Array.isArray(done) ? done : []).map(Number));
  ctx.session.todos = (items || []).map((text, i) => ({ text: String(text), done: doneSet.has(i), active: i === Number(active) && !doneSet.has(i) }));
  ctx.emit({ type: 'todos', todos: ctx.session.todos });
  return { todos: ctx.session.todos };
});

function resolveIn(workdir, p) {
  const full = path.resolve(workdir, p);
  const rel = path.relative(workdir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path escapes workdir: ${p}`);
  return full;
}

function matchGlob(str, pattern) {
  // tiny matcher: **, *, ? — good enough for v0
  const rx = '^' + String(pattern).split('/').map((seg) => {
    if (seg === '**') return '.*';
    return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  }).join('/') + '$';
  return new RegExp(rx).test(str.replace(/\\/g, '/'));
}

const { makePatchTool } = require('./patch');
const { makeMemoryTool } = require('./memory');
const { makeWorktreeTool } = require('./worktree');
const { makeRagTool } = require('./rag');
const { makeWebFetchTool } = require('./web_fetch');
const { makeWebSearchTool } = require('./web_search');
const { makeLspTool } = require('./lsp');
const { makeSnapshotTool } = require('./snapshot');
const { makeReplTool } = require('./node_repl');

/** Build the tool list for one agent run (context-aware tools get ctx helpers). */
/**
 * Facade specs: one surface, several underlying tools, selected by `action`.
 *
 * `members` maps action value -> the real tool name it dispatches to. Permission is
 * still decided per action (see policyKey in sandbox.js), so folding a read-only op
 * in with mutating ones does not escalate it.
 */
const FACADES = [
  {
    name: 'computer',
    describe: 'Drive the in-app browser: open a page, read its state, click, type, press keys, scroll, '
      + 'and capture screenshots. Every action operates on the SAME attached surface, so `state` after '
      + '`open` shows the page you just opened.',
    members: {
      // `open` MUST be the CDP-attaching path. It used to route to browser_open,
      // which opens the Atlas view WITHOUT attaching the debugger — so the very next
      // `state` read an unattached target and reported about:blank for a page that
      // was visibly loaded. One tool implying one surface has to actually be one
      // surface; folding two families behind `computer` is what made that trap.
      open: 'cu_launch',
      state: 'cu_state',
      click: 'cu_click',
      type: 'cu_type',
      press: 'cu_press',
      scroll: 'cu_scroll',
      screenshot: 'cu_screenshot',
      list: 'cu_list',
    },
    // Folded away but NOT exposed as actions: the non-CDP browser_* family is
    // strictly less capable than cu_* and mixing the two is the bug above.
    hide: ['browser_open', 'browser_act', 'browser_screenshot'],
  },
  {
    name: 'fs',
    describe: 'File-system operations that are not read/write/edit: stat a path, create a directory, move, or remove. Use `action` to pick the operation.',
    members: { stat: 'stat', mkdir: 'mkdir', move: 'move', remove: 'remove' },
  },
  {
    name: 'skill',
    describe: 'Project skills: list the available skills, or load one by name. Use `action` to pick.',
    members: { list: 'skills_list', load: 'skill_load' },
  },
  {
    name: 'mcp',
    describe: 'MCP servers: list the tools an MCP server exposes, or call one. Use `action` to pick.',
    members: { list_tools: 'mcp_list_tools', call: 'mcp_call' },
  },
];

/** Build one facade tool from the member defs, merging their parameter schemas. */
function makeFacade(spec, members) {
  const byAction = {};
  const properties = {
    action: {
      type: 'string',
      enum: Object.keys(spec.members).filter((a) => members.some((m) => m.def.function.name === spec.members[a])),
      description: 'Which operation to perform.',
    },
  };
  const perAction = [];
  for (const [action, toolName] of Object.entries(spec.members)) {
    const m = members.find((x) => x.def.function.name === toolName);
    if (!m) continue;
    byAction[action] = m;
    const p = (m.def.function.parameters && m.def.function.parameters.properties) || {};
    const req = (m.def.function.parameters && m.def.function.parameters.required) || [];
    // Members' own params become optional at the facade level; which ones matter for
    // which action is documented in the description, where the model actually reads it.
    for (const [k, v] of Object.entries(p)) if (!properties[k]) properties[k] = v;
    perAction.push(`${action}${req.length ? ` (needs ${req.join(', ')})` : ''}`);
  }
  return {
    def: {
      type: 'function',
      function: {
        name: spec.name,
        description: `${spec.describe}\nActions: ${perAction.join('; ')}.`,
        parameters: { type: 'object', properties, required: ['action'], additionalProperties: false },
      },
    },
    run: (args, c) => {
      const action = args && args.action;
      const m = byAction[action];
      if (!m) {
        // A result, not a throw — the model corrects itself from this.
        throw new Error(`${spec.name}: unknown action "${action}". Valid actions: ${Object.keys(byAction).join(', ')}.`);
      }
      const { action: _drop, ...rest } = args || {};
      return m.impl.run(m.def.function.name, rest, c);
    },
  };
}

function buildTools(opts) {
  const { workdir, session, emit, checkPermission, userData, live, resolveIn, userInput, showInApp, attachAtlas } = opts || {};
  const ctx = {
    workdir,
    session,
    emit,
    resolveIn,
    checkPermission,
    userData,
    live,
    userInput: userInput || (async () => ({ answer: null, cancelled: true })),
  };
  const patchT = makePatchTool({ resolveIn, checkPermission });
  const memT = makeMemoryTool({ resolveIn });
  const bsT = require('./build_state').makeBuildStateTool();
  const agT = require('./agents').makeAgentsTool();
  const wtT = makeWorktreeTool();
  const ragT = makeRagTool();
  const wfT = makeWebFetchTool({ checkPermission });
  const wsT = makeWebSearchTool({ checkPermission, agentOpts: opts.agentOpts || {} });
  const lspT = makeLspTool();
  const snapT = makeSnapshotTool({ userData, live });
  const replT = makeReplTool();
  // ---- feature set 1-8 (gap-fill) ----
  const { makeMcpTool } = require('./mcp');
  const { makeSkillsTool } = require('./skills');
  const { makeFsOpsTool } = require('./fsops');
  const { makeDocRagTool } = require('./docrag');
  const { makeSpawnTool } = require('./spawn');
  const { makeBrowserTool } = require('./browser');
  const { makeSandboxTool } = require('./sandbox');
  const { makeArtifactTool } = require('./artifact');
  const { makeComputerUseTool } = require('../cu');

  const mcpT = makeMcpTool({ getSettings: opts.getSettings, mcpDir: opts.mcpDir });
  const skillsT = makeSkillsTool();
  const fsT = makeFsOpsTool({ resolveIn, checkPermission });
  const docRagT = makeDocRagTool({ resolveIn, checkPermission });
  const spawnT = makeSpawnTool({ runner: opts.runner, agentOpts: opts.agentOpts || {}, userData, live, emit });
  const browserT = makeBrowserTool({ resolveIn, checkPermission });
  const sandboxT = makeSandboxTool({ getAccess: opts.getAccess });
  const artT = makeArtifactTool({ resolveIn, userData, emit });
  const cuT = makeComputerUseTool({ showInApp, attachAtlas });

  // feature 1-8 tools each expose defs[] + a run(name,args,ctx) dispatcher
  const featureDeps = [
    [mcpT, 'mcp_'], [skillsT, 'skill'], [fsT, 'fsops'], [docRagT, 'doc'],
    [spawnT, 'spawn'], [browserT, 'browser_'], [sandboxT, 'sandbox'], [artT, 'artifact'],
    [cuT, 'cu'],
  ];
  const featureTools = [];
  for (const [impl] of featureDeps) if (impl && Array.isArray(impl.defs)) {
    for (const def of impl.defs) featureTools.push({ def, impl });
  }

  // ask_user / ask_confirm: the model pauses and asks the user (Codex / Claude
  // Code / goose style) when it needs a decision. Returns the chosen option.
  // Options are plain strings. As {label, value} objects models left them out -- asked
  // for "two options", one sent only the question and the user got a text box. Found
  // in a live run. Objects from older prompts still work.
  const askUser = tool('ask_user', 'Pause and ask the user a question. Returns their answer. Whenever there is a set of choices, list every one in `options` -- each becomes a button; without options the user must type. Only use when you genuinely need input.', {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user.' },
      options: { type: 'array', items: { type: 'string' }, description: 'The choices, one button each, e.g. ["inches <-> cm", "kg <-> lb"]. Leave out only for a free-text answer.' },
      default: { type: 'string', description: 'Optional default answer if the user dismisses.' },
    },
    required: ['question'], additionalProperties: false,
  }, async (args, c) => {
    const options = (Array.isArray(args.options) ? args.options : [])
      .map((o) => (o && typeof o === 'object' ? { label: String(o.label || o.value || ''), value: String(o.value || o.label || '') } : { label: String(o), value: String(o) }))
      .filter((o) => o.label);
    const res = await c.userInput({ question: String(args.question || ''), options, kind: 'ask' });
    return { answer: res ? res.answer : (args.default || null), cancelled: res ? !!res.cancelled : true };
  });

  const askConfirm = tool('ask_confirm', 'Pause and ask the user to confirm / deny a single action. Returns {confirmed: true|false}. Use for risky or destructive operations.', {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'What you want to do, to be confirmed.' },
    },
    required: ['message'], additionalProperties: false,
  }, async (args, c) => {
    const res = await c.userInput({ question: String(args.message || ''), options: [{ label: 'Confirm', value: 'yes' }, { label: 'Deny', value: 'no' }], kind: 'confirm' });
    return { confirmed: res ? res.answer === 'yes' : false, cancelled: res ? !!res.cancelled : true };
  });

  const ALL = [
    read, write, edit, glob, grep, shell, todo, askUser, askConfirm,
    patchT, memT, bsT, agT, wtT, ragT, wfT, wsT, lspT, snapT, replT,
  ];
  if (opts.includeFeatures !== false) {
    // Fold related tools behind a single `action` enum. Tool-choice accuracy falls
    // as the surface grows, and 42 separate schemas cost ~4.5k tokens on every
    // request. Each facade dispatches to the SAME underlying implementation, so no
    // capability is lost — only the number of things the model must choose between.
    const folded = new Set();
    for (const spec of FACADES) {
      // spec.members maps ACTION -> tool name, so match on the values.
      const memberNames = new Set(Object.values(spec.members));
      const members = featureTools.filter((ft) => memberNames.has(ft.def.function.name));
      if (members.length < 2) continue;      // nothing to fold on this build
      members.forEach((m) => folded.add(m.def.function.name));
      // Hidden members are removed from the surface without getting an action.
      for (const h of (spec.hide || [])) folded.add(h);
      ALL.push(makeFacade(spec, members));
    }
    for (const ft of featureTools) {
      if (folded.has(ft.def.function.name)) continue;
      ALL.push({
        def: ft.def,
        run: (args, c) => ft.impl.run(ft.def.function.name, args, c),
      });
    }
  }
  return { ALL, ctx };
}

module.exports = {
  buildTools,
  definitions: (opts = {}) => {
    const stubCtx = {
      workdir: opts.workdir || process.cwd(),
      session: opts.session || { id: 'x', workdir: opts.workdir || process.cwd(), messages: [], todos: [] },
      emit: () => {},
      resolveIn: (wd, p) => require('path').resolve(wd, p),
      checkPermission: async () => {},
      userData: opts.userData,
      live: opts.live,
    };
    return buildTools(stubCtx).ALL.map((t) => t.def);
  },
};
