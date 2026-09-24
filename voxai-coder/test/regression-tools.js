/**
 * Tool + reliability regression tests — Phase 2.
 * Offline; uses a temp workdir. Run: node test/regression-tools.js
 *
 *   [H] edit: exact match, line-trimmed fallback, and a useful failure message
 *   [I] freshness guard: refuse to write a file that changed since it was read
 *   [J] build_state: durable record + how it renders into the system prompt
 *   [K] loop detection: an identical repeated tool call is interrupted
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
const tools = require(path.join(ROOT, 'src/backend/tools'));
const { runAgent } = require(path.join(ROOT, 'src/backend/agent.js'));
const bs = require(path.join(ROOT, 'src/backend/tools/build_state.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-tools-'));

function toolset() {
  const { ALL } = tools.buildTools({
    workdir: WD, session: { messages: [] }, emit: () => {},
    checkPermission: async () => {}, resolveIn: (wd, p) => path.resolve(wd, p),
    getSettings: () => ({}), getAccess: () => 'full',
  });
  const ctx = { workdir: WD, checkPermission: async () => {}, resolveIn: (wd, p) => path.resolve(wd, p) };
  const byName = (n) => ALL.find((t) => t.def.function.name === n);
  return { byName, ctx };
}

async function editTests() {
  const { byName, ctx } = toolset();
  const read = byName('read'); const edit = byName('edit');
  console.log('\n[H] edit matching');

  const f = path.join(WD, 'a.js');
  await fsp.writeFile(f, 'function go() {\n    return 1;\n}\n', 'utf8');

  await read.run({ path: 'a.js' }, ctx);
  let r = await edit.run({ path: 'a.js', before: '    return 1;', after: '    return 2;' }, ctx);
  check('exact match applies', r.match === 'exact', r);
  check('file updated', (await fsp.readFile(f, 'utf8')).includes('return 2'), 'not updated');

  // The model reproduces a multi-line block with its own indentation — the single
  // most common near-miss, and not an exact substring of the file. Exact-only
  // matching rejects this; the line-trimmed pass should take it.
  await read.run({ path: 'a.js' }, ctx);
  r = await edit.run({
    path: 'a.js',
    before: 'function go() {\nreturn 2;\n}',
    after: 'function go() {\n    return 3;\n}',
  }, ctx);
  check('line-trimmed fallback applies', r.match === 'line-trimmed', r);
  check('fallback wrote the right content', (await fsp.readFile(f, 'utf8')).includes('return 3'), await fsp.readFile(f, 'utf8'));

  // A genuine miss must fail loudly AND point at the nearest real line.
  await read.run({ path: 'a.js' }, ctx);
  let msg = '';
  try { await edit.run({ path: 'a.js', before: 'return 99;', after: 'x' }, ctx); }
  catch (e) { msg = e.message; }
  check('genuine miss throws', /not found/.test(msg), msg);
  check('failure names the nearest line', /Closest lines|No line contains/.test(msg), msg);
}

async function rangeReadTests() {
  console.log('\n[X] read: line ranges');
  const { byName, ctx } = toolset();
  const read = byName('read');
  await fsp.writeFile(path.join(WD, 'long.txt'), Array.from({length: 50}, (_, i) => 'line' + (i + 1)).join('\n'), 'utf8');

  const all = await read.run({ path: 'long.txt' }, ctx);
  check('whole file reports its true length', all.lines === 50 && all.returned === 50, all);
  check('whole file is not marked truncated', all.truncated === false, all.truncated);

  // The real failure this came from: a model asked for a range and was handed the
  // whole file, believing it had the range.
  const mid = await read.run({ path: 'long.txt', offset: 10, limit: 5 }, ctx);
  const want = ['line10','line11','line12','line13','line14'].join('\n');
  check('offset/limit actually slice', mid.content === want, mid.content);
  check('range reports where it starts', mid.from === 10 && mid.to === 14, { from: mid.from, to: mid.to });
  check('range says more follows', mid.truncated === true, mid.truncated);
  check('total length still reported', mid.lines === 50, mid.lines);

  const tail = await read.run({ path: 'long.txt', offset: 48 }, ctx);
  check('reading past the middle returns the tail', tail.returned === 3 && tail.to === 50, { returned: tail.returned, to: tail.to });
  check('tail is not marked truncated', tail.truncated === false, tail.truncated);

  // An unknown argument must be REJECTED by the schema, not silently dropped.
  const def = read.def.function.parameters;
  check('read schema forbids unknown args', def.additionalProperties === false, def.additionalProperties);
  check('offset and limit are declared', !!def.properties.offset && !!def.properties.limit, Object.keys(def.properties));
}

async function freshnessTests() {
  const { byName, ctx } = toolset();
  const read = byName('read'); const edit = byName('edit'); const write = byName('write');
  console.log('\n[I] freshness guard');

  const f = path.join(WD, 'b.txt');
  await fsp.writeFile(f, 'original\n', 'utf8');
  await read.run({ path: 'b.txt' }, ctx);

  // Someone else edits the file between the model's read and its write.
  await fsp.writeFile(f, 'changed by someone else\n', 'utf8');

  let msg = '';
  try { await edit.run({ path: 'b.txt', before: 'original', after: 'model edit' }, ctx); }
  catch (e) { msg = e.message; }
  check('stale edit refused', /changed on disk/.test(msg), msg);
  check('the other change survived', (await fsp.readFile(f, 'utf8')).includes('someone else'), await fsp.readFile(f, 'utf8'));

  // After re-reading, the same edit is allowed again.
  await read.run({ path: 'b.txt' }, ctx);
  const r = await edit.run({ path: 'b.txt', before: 'changed by someone else', after: 'model edit' }, ctx);
  check('edit allowed after a fresh read', !!r.path, r);

  // A brand-new file was never read, so there is nothing to guard against.
  const r2 = await write.run({ path: 'c.txt', content: 'new file' }, ctx);
  check('creating a new file is not blocked', !!r2.path, r2);
}

async function buildStateTests() {
  const { byName, ctx } = toolset();
  const t = byName('build_state');
  console.log('\n[J] build state');
  check('build_state tool is registered', !!t, 'missing');

  let r = await t.run({ action: 'get' }, ctx);
  check('starts empty', bs.isEmptyState(r.state), r.state);

  await t.run({ action: 'set', task: 'Wire native tool calling', done: ['streaming accumulator'], next: ['cache breakpoints'] }, ctx);
  r = await t.run({ action: 'merge', done: ['freshness guard'], decisions: ['OpenRouter only'] }, ctx);
  check('merge appends rather than replacing', r.state.done.length === 2, r.state.done);
  check('merge keeps earlier fields', r.state.task === 'Wire native tool calling', r.state.task);
  check('decisions recorded', r.state.decisions.includes('OpenRouter only'), r.state.decisions);
  check('persisted to disk', fs.existsSync(path.join(WD, '.voxai', 'build_state.json')), 'missing file');

  const loaded = await bs.loadBuildState(WD);
  const text = bs.formatBuildState(loaded);
  check('renders for the system prompt', /BUILD STATE/.test(text) && /Wire native tool calling/.test(text), text);
  // The prefix must be byte-identical between turns or it moves the cache boundary.
  check('rendering is deterministic', bs.formatBuildState(loaded) === text, 'unstable');
}

function sse(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

async function loopTests() {
  console.log('\n[K] loop detection');
  // The model calls the same tool with identical arguments, over and over.
  const spin = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{"path":"a.js"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  global.fetch = async () => ({ ok: true, body: sse(spin), text: async () => '' });

  const session = { id: 'loop1', workdir: WD, messages: [] };
  const events = [];
  for await (const ev of runAgent({
    session, userText: 'go', apiKey: 'k', model: 'test/model',
    access: 'full', askPermission: async () => true, maxTurns: 8,
  })) {
    events.push(ev);
    if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled' || ev.type === 'limit_reached') break;
  }
  const warned = events.find((e) => e.type === 'warning' && e.code === 'tool-loop');
  check('repeated identical call is caught', !!warned, events.filter((e) => e.type === 'warning'));
  const nudge = session.messages.find((m) => m.role === 'tool' && /identical arguments/.test(String(m.content || '')));
  check('the model is told what it is repeating', !!nudge, 'no nudge message');
  check('every tool_call still has a result', (() => {
    const ids = [];
    for (const m of session.messages) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) ids.push(tc.id);
    const res = session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    return ids.every((id) => res.includes(id));
  })(), 'pairing broken');

  // And the runaway guard is a resumable pause, not an error.
  const ev = events[events.length - 1];
  check('ends resumable, not as an error', ev.type === 'limit_reached' && ev.resumable === true, ev.type);
}

async function computerSurfaceTests() {
  console.log('\n[Y] computer: one surface');
  const { byName } = toolset();
  const comp = byName('computer');
  const acts = comp.def.function.parameters.properties.action.enum;

  // The bug this came from: `open` routed to browser_open (no CDP attach) while
  // `state` read the CDP target, so state reported about:blank for a page that had
  // visibly loaded — and the model then told the user it was displayed.
  check('open exists', acts.includes('open'), acts);
  check('no second way to open', !acts.includes('launch'), acts);
  check('state/click/screenshot are on the same surface', ['state','click','screenshot'].every((a)=>acts.includes(a)), acts);

  const { ALL } = tools.buildTools({
    workdir: WD, session: { id: 's', messages: [] }, emit: () => {},
    checkPermission: async () => {}, resolveIn: (wd, p) => path.resolve(wd, p),
    getSettings: () => ({}), getAccess: () => 'full',
  });
  const names = ALL.map((t) => t.def.function.name);
  check('the non-CDP browser_* family is not exposed', !names.some((n) => /^browser_/.test(n)),
    names.filter((n) => /^browser_/.test(n)));

  // Every action must map to the cu_* family, or the surfaces diverge again.
  const src = fs.readFileSync(path.join(ROOT, 'src/backend/tools/index.js'), 'utf8');
  const block = /name: 'computer'[\s\S]*?hide:/.exec(src)[0];
  const targets = [...block.matchAll(/:\s*'(cu_[a-z]+|browser_[a-z_]+)'/g)].map((m) => m[1]);
  check('every computer action targets cu_*', targets.length > 0 && targets.every((t) => t.startsWith('cu_')), targets);
}

async function facadeTests() {
  console.log('\n[L] folded tool surface');
  const { byName, ctx } = toolset();
  const { ALL } = tools.buildTools({
    workdir: WD, session: { messages: [] }, emit: () => {},
    checkPermission: async () => {}, resolveIn: (wd, p) => path.resolve(wd, p),
    getSettings: () => ({}), getAccess: () => 'full',
  });
  const names = ALL.map((t) => t.def.function.name);

  check('facades are present', ['computer', 'fs', 'skill', 'mcp'].every((n) => names.includes(n)), names);
  check('members are gone from the surface', !names.some((n) => /^cu_|^browser_|^mcp_|^skills?_|^spawn_parallel$/.test(n)
    || ['stat', 'mkdir', 'move', 'remove'].includes(n)), names.filter((n) => /^cu_|^browser_/.test(n)));
  check('surface is under 30 tools', names.length < 30, names.length);

  const fsT = byName('fs');
  check('fs advertises its actions', fsT.def.function.parameters.properties.action.enum.join(',') === 'stat,mkdir,move,remove',
    fsT.def.function.parameters.properties.action.enum);

  // The facade must actually dispatch, not just exist.
  await fsp.writeFile(path.join(WD, 'd.txt'), 'hi', 'utf8');
  const st = await fsT.run({ action: 'stat', path: 'd.txt' }, ctx);
  check('fs dispatches to the real implementation', !!st && (st.size !== undefined || st.bytes !== undefined || st.exists !== undefined), st);

  let bad = '';
  try { await fsT.run({ action: 'nope' }, ctx); } catch (e) { bad = e.message; }
  check('unknown action names the valid ones', /unknown action/.test(bad) && /stat/.test(bad), bad);
}

function permissionTests() {
  console.log('\n[M] action-aware permissions');
  const { checkToolAllowed } = require(path.join(ROOT, 'src/backend/tools/sandbox.js'));

  // Folding must not escalate a read-only op to the permission level of its
  // most restrictive sibling.
  const statAsk = checkToolAllowed('fs', 'ask', { action: 'stat' });
  const rmAsk = checkToolAllowed('fs', 'ask', { action: 'remove' });
  check('fs:stat still auto-allowed at "ask"', statAsk.allowed === true, statAsk);
  check('fs:remove still gated at "ask"', rmAsk.allowed === false, rmAsk);

  const rmEdit = checkToolAllowed('fs', 'edit', { action: 'remove' });
  check('fs:remove allowed once editing is permitted', rmEdit.allowed === true, rmEdit);

  // And a folded surface that is dangerous throughout stays gated.
  const comp = checkToolAllowed('computer', 'test', { action: 'click' });
  check('computer prompts below full access', comp.needsPermission === true, comp);
  const compFull = checkToolAllowed('computer', 'full', { action: 'click' });
  check('computer auto-allows at full access', compFull.allowed === true, compFull);

  // Unfolded tools must behave exactly as before.
  check('shell unchanged at "ask"', checkToolAllowed('shell', 'ask', {}).allowed === false, 'changed');
  check('read unchanged at "ask"', checkToolAllowed('read', 'ask', {}).allowed === true, 'changed');
}

async function backgroundTests() {
  console.log('\n[R] background sub-agents');
  const { makeSpawnTool } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));
  const bg = require(path.join(ROOT, 'src/backend/background.js'));

  const SESSION = 'bgsess';
  bg.clear(SESSION);
  const ctx = { session: { id: SESSION }, workdir: WD };

  // A worker that takes a while and edits a file.
  const slowRunner = () => (async function* () {
    await new Promise((r) => setTimeout(r, 250));
    yield { type: 'tool_end', id: '1', name: 'write', ok: true, result: '{}', mutated: { path: 'bg/out.js', tool: 'write', verified: 'ok' } };
    yield { type: 'done', content: 'background work complete' };
  })();
  const spawn = makeSpawnTool({
    runner: slowRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: 1 },
    userData: null, live: null, emit: () => {},
  });

  const t0 = Date.now();
  const started = await spawn.run('spawn_agent', { task: 'long job', background: true }, ctx);
  const dispatchMs = Date.now() - t0;
  check('background dispatch returns immediately', dispatchMs < 200, dispatchMs + 'ms');
  check('status is running', started.status === 'running' && started.ok === true, started);
  check('a REAL subId is returned, not a placeholder', typeof started.subId === 'string' && !/^pending_/.test(started.subId), started.subId);
  check('registry sees it in flight', bg.runningCount(SESSION) === 1, bg.runningCount(SESSION));

  // Nothing to collect while it is still going.
  check('no premature delivery', bg.drain(SESSION).length === 0, 'drained early');

  const settled = await bg.waitForAll(SESSION, 5000);
  check('it finishes', settled && bg.runningCount(SESSION) === 0, bg.runningCount(SESSION));

  const delivered = bg.drain(SESSION);
  check('the completed run is delivered once', delivered.length === 1, delivered.length);
  check('and only once', bg.drain(SESSION).length === 0, 'delivered twice');
  const note = bg.formatCompletion(delivered[0]);
  check('notice names the files changed', /bg\/out\.js/.test(note), note.slice(0, 120));
  check('notice carries the report', /background work complete/.test(note), note.slice(-120));
  check('notice is framed as automated, not a user instruction', /automated completion notice/.test(note), 'unframed');

  // Cancellation.
  bg.clear(SESSION);
  const hangRunner = () => (async function* () {
    await new Promise((r) => setTimeout(r, 5000));
    yield { type: 'done', content: 'too late' };
  })();
  const spawn2 = makeSpawnTool({
    runner: hangRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: 1 },
    userData: null, live: null, emit: () => {},
  });
  const h = await spawn2.run('spawn_agent', { task: 'hang', background: true }, ctx);
  check('cancel finds the running agent', bg.cancel(SESSION, h.subId) === true, h.subId);
  check('cancelling a stranger returns false', bg.cancel(SESSION, 'not_a_real_id') === false, 'true');
  bg.cancelAll(SESSION);
  bg.clear(SESSION);

  // Fan-out in the background.
  const fan = await makeSpawnTool({
    runner: slowRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: 1 },
    userData: null, live: null, emit: () => {},
  }).run('spawn_agent', { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }], background: true }, ctx);
  check('fan-out starts them all in the background', fan.started && fan.started.length === 3, fan.started);
  check('three are in flight', bg.runningCount(SESSION) === 3, bg.runningCount(SESSION));
  await bg.waitForAll(SESSION, 5000);
  check('all three deliver', bg.drain(SESSION).length === 3, 'missing reports');
  bg.clear(SESSION);

  // THE INVARIANT: a run must not finish while work is still in flight.
  bg.clear('loopsess');
  const turns = [
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 's1', function: { name: 'spawn_agent', arguments: JSON.stringify({ task: 'go do it', background: true }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [
      { choices: [{ delta: { content: 'All done!' } }] },          // model tries to finish early
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
    [
      { choices: [{ delta: { content: 'Now I have the report.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
  ];
  let n = 0;
  global.fetch = async () => ({ ok: true, body: sse(turns[Math.min(n++, turns.length - 1)]), text: async () => '' });

  const session = { id: 'loopsess', workdir: WD, messages: [] };
  const events = [];
  for await (const ev of runAgent({
    session, userText: 'delegate it', apiKey: 'k', model: 'test/model',
    access: 'full', askPermission: async () => true, maxTurns: 6,
  })) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  check('run waits rather than finishing early', events.some((e) => e.type === 'awaiting_agents'), events.map((e) => e.type));
  check('the completion is announced', events.some((e) => e.type === 'agent_finished'), events.map((e) => e.type));
  const injected = session.messages.find((m) => m.role === 'user' && /BACKGROUND AGENT FINISHED/.test(String(m.content)));
  check('the report reaches the model transcript', !!injected, 'not injected');
  check('the model got a turn after the report', events[events.length - 1].type === 'done', events[events.length - 1]);
  bg.clear('loopsess');
}

async function subAgentReceiptTests() {
  console.log('\n[Q] sub-agent roles, receipts and resume');
  const { makeSpawnTool, ROLES, READ_TOOLS } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));

  // --- roles are enforced by the TOOL SURFACE, not by prompt text ---
  check('explore is read-only', !ROLES.explore.tools.some((t) => ['write', 'edit', 'patch', 'shell'].includes(t)), ROLES.explore.tools);
  check('review is read-only', !ROLES.review.tools.some((t) => ['write', 'edit', 'patch', 'shell'].includes(t)), ROLES.review.tools);
  check('build can write and run', ROLES.build.tools.includes('write') && ROLES.build.tools.includes('shell'), ROLES.build.tools);
  check('read-only roles pin access low', ROLES.explore.access === 'ask' && ROLES.review.access === 'ask',
    [ROLES.explore.access, ROLES.review.access]);

  let captured = null;
  const capturingRunner = (o) => {
    captured = o;
    return (async function* () { yield { type: 'done', content: 'ok' }; })();
  };
  const mk = (runner, extra = {}) => makeSpawnTool({
    runner,
    agentOpts: Object.assign({ apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: 1 }, extra),
    userData: null, live: null, emit: () => {},
  });

  await mk(capturingRunner).run('spawn_agent', { task: 'look', role: 'explore' });
  check('explore run gets the read-only toolset', JSON.stringify(captured.allowTools) === JSON.stringify(READ_TOOLS), captured.allowTools);
  check('explore run gets a low access level', captured.access === 'ask', captured.access);
  check('role brief is prepended to the task', /read-only research agent/i.test(captured.userText) && /look/.test(captured.userText), captured.userText.slice(0, 80));

  await mk(capturingRunner, { access: 'full' }).run('spawn_agent', { task: 'do it', role: 'build' });
  check('build inherits the parent access level', captured.access === 'full', captured.access);
  check('build can write', captured.allowTools.includes('write'), captured.allowTools);

  // --- the receipt: which files changed, not a sentence about them ---
  const mutatingRunner = () => (async function* () {
    yield { type: 'tool_start', id: '1', name: 'write' };
    yield { type: 'tool_end', id: '1', name: 'write', ok: true, result: '{}', mutated: { path: 'src/a.js', tool: 'write', verified: 'ok', bytes: 120 } };
    yield { type: 'tool_start', id: '2', name: 'edit' };
    yield { type: 'tool_end', id: '2', name: 'edit', ok: true, result: '{}', mutated: { path: 'src/a.js', tool: 'edit', verified: 'ok', match: 'exact' } };
    yield { type: 'tool_end', id: '3', name: 'patch', ok: false, result: 'x', mutated: { path: 'src/b.js', tool: 'patch', verified: 'failed' } };
    yield { type: 'done', content: 'I changed some files.' };
  })();
  const r = await mk(mutatingRunner).run('spawn_agent', { task: 'edit things' });
  check('receipt lists changed files', Array.isArray(r.files_changed) && r.files_changed.length === 2, r.files_changed);
  check('a file edited twice appears once', r.files_changed.filter((f) => f.path === 'src/a.js').length === 1, r.files_changed);
  check('latest operation per file wins', r.files_changed.find((f) => f.path === 'src/a.js').tool === 'edit', r.files_changed);
  check('verification status carried through', r.files_changed.find((f) => f.path === 'src/b.js').verified === 'failed', r.files_changed);
  check('failed verification is flagged for attention', Array.isArray(r.needs_attention) && r.needs_attention.includes('src/b.js'), r.needs_attention);
  check('subId returned for follow-ups', typeof r.subId === 'string' && r.subId.length > 0, r.subId);
  check('stopReason says it completed', r.stopReason === 'completed' && r.complete === true, r);

  // --- a truncated run must not look finished ---
  const cappedRunner = () => (async function* () {
    yield { type: 'tool_end', id: '1', name: 'write', ok: true, result: '{}', mutated: { path: 'src/c.js', tool: 'write', verified: 'ok' } };
    yield { type: 'limit_reached', turns: 25, resumable: true, message: 'Paused after 25 tool turns.' };
  })();
  const r2 = await mk(cappedRunner).run('spawn_agent', { task: 'big job' });
  check('turn-limited run is not marked ok', r2.ok === false && r2.stopReason === 'turn_limit', r2.stopReason);
  check('it still reports the work it did', r2.files_changed.length === 1, r2.files_changed);
  check('the result says it stopped early', /turn limit/i.test(r2.result), r2.result);

  // --- fan-out aggregates receipts ---
  const fan = await mk(mutatingRunner).run('spawn_agent', { tasks: [{ task: 'a' }, { task: 'b' }] });
  check('fan-out aggregates files_changed', fan.files_changed.length === 4, fan.files_changed.length);
  check('fan-out reports per-task results', fan.task_results.length === 2, fan.task_results.length);
  check('fan-out surfaces attention items', fan.needs_attention.length === 2, fan.needs_attention);

  // --- resume: continue an existing worker instead of paying to rebuild it ---
  const store = require(path.join(ROOT, 'src/backend/sessions.js'));
  const prior = store.createSession({ workdir: WD, model: 'm', title: 'subagent:build' });
  prior.messages.push({ role: 'user', content: 'first task' }, { role: 'assistant', content: 'did it' });
  await store.saveSession(WD, prior);

  captured = null;
  const res = await makeSpawnTool({
    runner: capturingRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: 1 },
    userData: WD, live: null, emit: () => {},
  }).run('spawn_agent', { resume: prior.id, task: 'follow-up question' });
  check('resume reuses the existing session', res.resumed === true && res.subId === prior.id, { resumed: res.resumed, subId: res.subId });
  check('resumed worker keeps its context', captured.session.messages.some((m) => m.content === 'did it'), captured.session.messages.length);
  check('follow-up is sent verbatim, without the role brief', captured.userText === 'follow-up question', captured.userText);

  const missing = await makeSpawnTool({
    runner: capturingRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: 1 },
    userData: WD, live: null, emit: () => {},
  }).run('spawn_agent', { resume: 'nope_does_not_exist', task: 'x' });
  check('resuming a missing worker fails clearly', missing.ok === false && /no such session/i.test(missing.error), missing);
}

async function verifyTests() {
  console.log('\n[P] verification in the tool result');
  const { byName, ctx } = toolset();
  const write = byName('write'); const edit = byName('edit'); const read = byName('read');

  // Valid JS: the result should carry a passing verification.
  let r = await write.run({ path: 'ok.js', content: 'function a(){ return 1; }\n' }, ctx);
  check('valid JS verifies ok', r.verification && r.verification.verified === 'ok', r.verification);

  // Broken JS: the tool must FAIL, so the model sees red on the next turn.
  let msg = '';
  try { await write.run({ path: 'bad.js', content: 'function a( { return 1;\n' }, ctx); }
  catch (e) { msg = e.message; }
  check('broken JS fails the tool call', /does not parse/.test(msg), msg);
  check('failure carries the checker diagnostics', /node/i.test(msg) && msg.length > 40, msg);
  check('failure says the file WAS written', /was written/.test(msg), msg);
  check('the file really is on disk', fs.existsSync(path.join(WD, 'bad.js')), 'missing');

  // The model must be able to repair it with a normal edit.
  await read.run({ path: 'bad.js' }, ctx);
  r = await edit.run({ path: 'bad.js', before: 'function a( { return 1;', after: 'function a() { return 1; }' }, ctx);
  check('a corrective edit verifies clean', r.verification && r.verification.verified === 'ok', r.verification);

  // JSON is checked in-process and reports a location.
  try { msg = ''; await write.run({ path: 'bad.json', content: '{"a": 1,,}' }, ctx); }
  catch (e) { msg = e.message; }
  check('broken JSON fails', /does not parse/.test(msg), msg);
  check('JSON error names a line/column', /line \d+, column \d+/.test(msg), msg);
  r = await write.run({ path: 'good.json', content: '{"a": 1}' }, ctx);
  check('valid JSON verifies ok', r.verification && r.verification.verified === 'ok', r.verification);

  // Unknown types must be skipped, never failed.
  r = await write.run({ path: 'notes.md', content: '# hello\n' }, ctx);
  check('unknown file type is skipped, not failed', r.verification && r.verification.verified === 'skipped', r.verification);
  r = await write.run({ path: 'a.css', content: 'body { color: red }\n' }, ctx);
  check('css is skipped too', r.verification && r.verification.verified === 'skipped', r.verification);

  // The kill switch must work — verification can never be the thing that blocks work.
  process.env.VOX_DISABLE_VERIFY = '1';
  r = await write.run({ path: 'bad2.js', content: 'function a( {\n' }, ctx);
  check('VOX_DISABLE_VERIFY bypasses the check', r.verification && r.verification.verified === 'skipped', r.verification);
  delete process.env.VOX_DISABLE_VERIFY;

  // End to end: the model writes broken code and must SEE the compiler error in its
  // own transcript on the next turn. This is the whole point — if the diagnostics do
  // not reach the messages array, the loop cannot self-correct.
  const turns = [
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write', arguments: JSON.stringify({ path: 'e2e.js', content: 'function q( {\n' }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [
      { choices: [{ delta: { content: 'I see the syntax error.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
  ];
  let n = 0;
  global.fetch = async () => ({ ok: true, body: sse(turns[Math.min(n++, turns.length - 1)]), text: async () => '' });
  const session = { id: 'v1', workdir: WD, messages: [] };
  const events = [];
  for await (const ev of runAgent({
    session, userText: 'write it', apiKey: 'k', model: 'test/model',
    access: 'full', askPermission: async () => true, maxTurns: 3,
  })) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  const toolMsg = session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'w1');
  check('diagnostics reach the model transcript', !!toolMsg && /does not parse/.test(String(toolMsg.content)), toolMsg && toolMsg.content);
  const te = events.find((e) => e.type === 'tool_end' && e.id === 'w1');
  check('UI sees the write as failed', te && te.ok === false, te);
  check('run continues after the failure', events.some((e) => e.type === 'done'), events.map((e) => e.type));
}

/** Stream N turns, each reporting `costPerTurn` in usage, then a final answer. */
function stubCostedTurns(costPerTurn, opts = {}) {
  global.fetch = async () => ({
    ok: true,
    text: async () => '',
    body: sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + Math.random(), function: { name: 'read', arguments: '{"path":"z.txt"}' } }] } }] },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: Object.assign(
          { prompt_tokens: 1000, completion_tokens: 100 },
          opts.noCost ? {} : { cost: costPerTurn },
        ),
      },
    ]),
  });
}

async function budgetTests() {
  console.log('\n[N] spend cap');
  await fsp.writeFile(path.join(WD, 'z.txt'), 'z', 'utf8');

  // Each turn costs $0.30 against a $1.00 cap: the run must stop rather than
  // continue to the 20-turn ceiling.
  stubCostedTurns(0.30);
  let session = { id: 'b1', workdir: WD, messages: [] };
  let events = [];
  for await (const ev of runAgent({
    session, userText: 'go', apiKey: 'k', model: 'test/model', access: 'full',
    askPermission: async () => true, maxTurns: 20, budgetUsd: 1.0,
  })) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  const stop = events.find((e) => e.type === 'budget_reached');
  check('run stops on the cap', !!stop, events.map((e) => e.type).slice(-3));
  check('stopped before the turn ceiling', events.filter((e) => e.type === 'tool_start').length < 20,
    events.filter((e) => e.type === 'tool_start').length);
  check('reports what was spent', stop && stop.spent >= 1.0 && stop.budget === 1.0, stop);
  check('cap is not overshot by a whole turn', stop && stop.spent <= 1.35, stop && stop.spent);
  check('live budget events emitted', events.some((e) => e.type === 'budget'), 'none');
  check('pairing survives the stop', (() => {
    const ids = [];
    for (const m of session.messages) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) ids.push(tc.id);
    const res = session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    return ids.every((id) => res.includes(id));
  })(), 'pairing broken');

  // A cheap run must NOT be stopped.
  stubCostedTurns(0.001);
  session = { id: 'b2', workdir: WD, messages: [] };
  events = [];
  for await (const ev of runAgent({
    session, userText: 'go', apiKey: 'k', model: 'test/model', access: 'full',
    askPermission: async () => true, maxTurns: 4, budgetUsd: 1.0,
  })) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  check('cheap run is not stopped', !events.some((e) => e.type === 'budget_reached'), 'stopped early');

  // THE DANGEROUS CASE: provider reports no cost and no catalogue price is known.
  // Silently treating that as $0 is how an account gets drained, so it must warn.
  stubCostedTurns(0, { noCost: true });
  session = { id: 'b3', workdir: WD, messages: [] };
  events = [];
  for await (const ev of runAgent({
    session, userText: 'go', apiKey: 'k', model: 'test/model', access: 'full',
    askPermission: async () => true, maxTurns: 3, budgetUsd: 1.0,
  })) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  const warn = events.find((e) => e.type === 'warning' && e.code === 'budget-unenforceable');
  check('unenforceable cap is announced, not silent', !!warn, events.filter((e) => e.type === 'warning'));
  check('warned only once', events.filter((e) => e.type === 'warning' && e.code === 'budget-unenforceable').length === 1,
    events.filter((e) => e.type === 'warning' && e.code === 'budget-unenforceable').length);

  // With catalogue prices available the cap still works without a reported cost.
  stubCostedTurns(0, { noCost: true });
  session = { id: 'b4', workdir: WD, messages: [] };
  events = [];
  for await (const ev of runAgent({
    session, userText: 'go', apiKey: 'k', model: 'test/model', access: 'full',
    askPermission: async () => true, maxTurns: 20, budgetUsd: 0.05,
    priceIn: 0.00002, priceOut: 0.00006,   // $20/M in, $60/M out
  })) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  check('estimated cost still enforces the cap', events.some((e) => e.type === 'budget_reached'),
    events.map((e) => e.type).slice(-3));
  check('estimate is flagged as estimated', events.some((e) => e.type === 'budget' && e.estimated === true), 'not flagged');
}

function subAgentBudgetTests() {
  console.log('\n[O] sub-agent budget');
  const { makeSpawnTool } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));
  const seen = [];
  const fakeRunner = (o) => {
    seen.push(o.budgetUsd);
    return (async function* () { yield { type: 'done', content: 'ok' }; })();
  };
  const mk = (remaining) => makeSpawnTool({
    runner: fakeRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: WD, isSubAgent: false, budgetRemaining: remaining },
    userData: null, live: null, emit: () => {},
  });

  return (async () => {
    seen.length = 0;
    await mk(0.80).run('spawn_agent', { task: 'one' });
    check('single sub-agent gets the parent remainder', seen[0] === 0.80, seen);

    seen.length = 0;
    await mk(0.60).run('spawn_agent', { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] });
    check('fan-out splits the remainder', seen.length === 3 && seen.every((b) => Math.abs(b - 0.2) < 1e-9), seen);
    check('fan-out total cannot exceed the parent', seen.reduce((a, b) => a + b, 0) <= 0.60 + 1e-9, seen);

    const none = await mk(0).run('spawn_agent', { task: 'x' });
    check('refuses to spawn with no budget left', none.ok === false && /budget/i.test(none.error), none);

    // An UNSET budget is not the same as an exhausted one: it means the embedder
    // never wired budgets, and the sub-run still applies its own default cap.
    seen.length = 0;
    const un = await mk(undefined).run('spawn_agent', { task: 'y' });
    check('unset budget still spawns', un.ok !== false || !/budget/i.test(un.error || ''), un);
    check('unset budget defers to the sub-run default', seen[0] === undefined, seen);
  })();
}


/**
 * A sub-agent's progress must reach the consumer WHILE it is still running.
 *
 * `yield` cannot cross an `await`: with the generator suspended inside
 * impl.run(), everything a tool emitted piled into an internal queue and was only
 * flushed once the call returned. A 5-way fan-out therefore rendered nothing at all
 * -- no card, no tool rows, no token counts -- until the last worker finished, which
 * is indistinguishable from a hang.
 *
 * Ordering alone cannot catch this (the flush happened just before tool_end either
 * way), so this asserts CAUSALLY: by the time the sub-agent makes its second network
 * call, the parent's consumer must ALREADY have been handed its progress events.
 */
async function subAgentStreamingTests() {
  console.log('\n[AL] sub-agent progress streams while it runs');
  fs.writeFileSync(path.join(WD, 'streamed.js'), 'module.exports = 1;');

  let sawSubEventBeforeSubFinished = null;
  let call = 0;
  const seen = { sub: false };

  global.fetch = async () => {
    call += 1;
    let chunks;
    if (call === 1) {
      // parent: delegate
      chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'sp1', function: { name: 'spawn_agent', arguments: JSON.stringify({ task: 'look at streamed.js', role: 'explore' }) } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];
    } else if (call === 2) {
      // sub turn 1: emits a tool_start, which the parent broadcasts as a `sub` event
      chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', function: { name: 'read', arguments: JSON.stringify({ path: 'streamed.js' }) } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];
    } else if (call === 3) {
      // sub turn 2 — the sub-run is still in flight, so the parent is still awaiting
      // impl.run(). Its consumer must already hold the events from turn 1.
      sawSubEventBeforeSubFinished = seen.sub;
      chunks = [
        { choices: [{ delta: { content: 'report' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
    } else {
      chunks = [
        { choices: [{ delta: { content: 'all done' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
    }
    return { ok: true, body: sse(chunks), text: async () => '' };
  };

  const session = { id: 'substream', workdir: WD, messages: [] };
  const events = [];
  for await (const ev of runAgent({
    session, userText: 'delegate', apiKey: 'k', model: 'test/model',
    access: 'full', askPermission: async () => true, maxTurns: 6, userData: WD,
  })) {
    events.push(ev);
    if (ev.type === 'sub') seen.sub = true;
    if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled' || ev.type === 'limit_reached') break;
  }

  const subEvents = events.filter((e) => e.type === 'sub');
  check('the parent emits sub-agent events at all', subEvents.length > 0, subEvents.length);
  check('progress arrives before the sub-agent finishes', sawSubEventBeforeSubFinished === true, sawSubEventBeforeSubFinished);
  check('the worker says what it is up front', subEvents.some((e) => e.ev === 'start' && e.role === 'explore'), subEvents.map((e) => e.ev));
  check('its tool calls are reported', subEvents.some((e) => e.ev === 'tool_start' && e.name === 'read'), subEvents.map((e) => e.ev));
  const end = events.find((e) => e.type === 'tool_end' && e.name === 'spawn_agent');
  check('the delegation still completes', !!end && end.ok === true, end && end.result);
  // A tool that throws must still surface as a failed call, not vanish into the pump.
  check('the run reaches a final answer', events.some((e) => e.type === 'done'), events[events.length - 1]);
}

(async () => {
  await editTests();
  await rangeReadTests();
  await freshnessTests();
  await buildStateTests();
  await loopTests();
  await computerSurfaceTests();
  await facadeTests();
  permissionTests();
  await budgetTests();
  await subAgentBudgetTests();
  await verifyTests();
  await subAgentReceiptTests();
  await backgroundTests();
  await subAgentStreamingTests();
  try { fs.rmSync(WD, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
