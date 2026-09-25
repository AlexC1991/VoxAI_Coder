/**
 * Protocol regression tests — Phase 0.
 *
 * Offline: stubs global.fetch, makes no network calls, costs nothing.
 * Run:  node test/regression-protocol.js
 *
 * Every assertion here FAILED before the Phase 0 fixes:
 *   [1] tool-call name concatenated across fragments -> "readreadread" -> unknown tool
 *   [2] missing tool_calls[].index merged parallel calls into one corrupt call
 *   [3] Map insertion order emitted calls out of index order
 *   [4] finish_reason was never returned, so truncation looked like a clean finish
 *   [A] malformed arguments JSON orphaned a tool_call_id -> provider 400 -> dead session
 *   [B] sub-agent timeout called .abort() on the PARENT's AbortSignal — a no-op,
 *       and had it worked it would have killed the parent run and all siblings
 */
const path = require('path');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
const { chatCompletions } = require(path.join(ROOT, 'src/backend/providers/openrouter.js'));
const { runAgent, boundToolResult } = require(path.join(ROOT, 'src/backend/agent.js'));
const { makeSpawnTool } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

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
function stubOnce(chunks) {
  global.fetch = async () => ({ ok: true, body: sse(chunks), text: async () => '' });
}
const streamCall = () => chatCompletions({
  apiKey: 'k', model: 'test/model', messages: [],
  tools: [{ type: 'function', function: { name: 'x' } }],
});

async function streamingTests() {
  // [1] OpenRouter's Anthropic gateway reuses the content-block index, so a text
  // block takes 0 and the first tool call arrives at 1. Some upstreams also repeat
  // function.name on every delta.
  stubOnce([
    { choices: [{ delta: { content: 'thinking' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_a', function: { name: 'read', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'read', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'read', arguments: 'th":"a.py"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  let r = await streamCall();
  console.log('\n[1] index starts at 1, name repeated per fragment');
  check('name assigned, not concatenated', r.toolCalls[0].name === 'read', r.toolCalls[0].name);
  check('arguments reassembled', r.toolCalls[0].arguments === '{"path":"a.py"}', r.toolCalls[0].arguments);
  check('finishReason returned', r.finishReason === 'tool_calls', r.finishReason);

  // [2] Some providers omit index entirely on parallel calls.
  stubOnce([
    { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'c2', function: { name: 'grep', arguments: '{"query":"z"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  r = await streamCall();
  console.log('\n[2] parallel calls with no index');
  check('two distinct calls, not merged', r.toolCalls.length === 2, r.toolCalls.length);
  check('first is read', r.toolCalls[0] && r.toolCalls[0].name === 'read', r.toolCalls[0]);
  check('second is grep', r.toolCalls[1] && r.toolCalls[1].name === 'grep', r.toolCalls[1]);

  // [3] Fragments can interleave; emission must follow index, not arrival.
  stubOnce([
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'second', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'first', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  r = await streamCall();
  console.log('\n[3] out-of-order fragments');
  check('emitted in index order', r.toolCalls.map((t) => t.name).join(',') === 'first,second', r.toolCalls.map((t) => t.name));

  // [4] max_tokens hit mid-generation.
  stubOnce([
    { choices: [{ delta: { content: 'partial answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]);
  r = await streamCall();
  console.log('\n[4] truncated generation');
  check("finishReason === 'length'", r.finishReason === 'length', r.finishReason);
}

async function pairingTest() {
  // Turn 1 emits a tool call with truncated arguments JSON (what finish_reason
  // 'length' produces mid-call). Turn 2 finishes normally.
  const turns = [
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_broken', function: { name: 'read', arguments: '{"path":"a.p' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    [
      { choices: [{ delta: { content: 'recovered' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ],
  ];
  let n = 0;
  global.fetch = async () => ({ ok: true, body: sse(turns[Math.min(n++, turns.length - 1)]), text: async () => '' });

  const session = { id: 's1', workdir: process.cwd(), messages: [] };
  const events = [];
  const gen = runAgent({
    session, userText: 'read a file', apiKey: 'k', model: 'test/model',
    access: 'full', askPermission: async () => true, maxTurns: 3,
  });
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') break;
  }

  console.log('\n[A] tool_call / role:tool pairing after malformed arguments');
  const callIds = [];
  for (const m of session.messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) callIds.push(tc.id);
  }
  const resultIds = session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  check('the malformed call was still issued', callIds.includes('call_broken'), callIds);
  check('every tool_call id has a result', callIds.every((id) => resultIds.includes(id)), { callIds, resultIds });
  check('no orphaned result', resultIds.every((id) => callIds.includes(id)), { callIds, resultIds });
  const errMsg = session.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_broken');
  check('result explains the JSON failure', !!errMsg && /invalid JSON arguments/i.test(errMsg.content), errMsg && errMsg.content);
  check('run recovered and finished', events.some((e) => e.type === 'done'), events.map((e) => e.type));
}

async function subAgentIsolationTest() {
  console.log('\n[B] sub-agent cancellation isolation');
  const parentCtl = new AbortController();
  let childSignal = null;
  const fakeRunner = (opts) => {
    childSignal = opts.signal;
    return (async function* () {
      await new Promise((r) => setTimeout(r, 3000)); // never finishes on its own
      yield { type: 'done', content: 'too late' };
    })();
  };
  const spawn = makeSpawnTool({
    runner: fakeRunner,
    // The production floor is 10 s (a smaller timeout is always a units slip); lifted
    // here so the abort mechanism can be tested in 150 ms.
    agentOpts: { apiKey: 'k', model: 'm', workdir: process.cwd(), signal: parentCtl.signal, isSubAgent: false, budgetRemaining: 1, subTimeoutFloorMs: 0 },
    userData: null, live: null, emit: () => {},
  });
  const res = await spawn.run('spawn_agent', { task: 'hang', timeoutMs: 150 });
  check('child got its own signal, not the parent one', childSignal && childSignal !== parentCtl.signal, String(childSignal === parentCtl.signal));
  check('child signal was aborted by the timeout', childSignal && childSignal.aborted === true, childSignal && childSignal.aborted);
  check('PARENT signal survived', parentCtl.signal.aborted === false, parentCtl.signal.aborted);
  check('timeout was reported', res && res.ok === false && /timed out/i.test(res.error || ''), res);

  // The limit in Settings is a ceiling: with it at 10 s the model asked for 120 s and
  // a 40 s job ran to the end.
  const spawn2 = makeSpawnTool({
    runner: fakeRunner,
    agentOpts: { apiKey: 'k', model: 'm', workdir: process.cwd(), isSubAgent: false, budgetRemaining: 1, subTimeoutFloorMs: 0, defaultSubTimeoutMs: 150 },
    userData: null, live: null, emit: () => {},
  });
  const res2 = await spawn2.run('spawn_agent', { task: 'hang', timeoutMs: 60000 });
  check('the model cannot raise the time limit set in Settings', res2 && res2.ok === false && /timed out after 0s/.test(res2.error || ''), res2 && res2.error);
}

function captureBody() {
  const seen = {};
  global.fetch = async (_url, init) => {
    Object.assign(seen, JSON.parse(init.body));
    return { ok: true, body: sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]), text: async () => '' };
  };
  return seen;
}

async function cacheTests() {
  const bigSystem = 'SYSTEM PROMPT '.repeat(500); // > MIN_CACHEABLE_CHARS
  const hasBreakpoint = (m) => Array.isArray(m.content)
    && m.content.some((p) => p && p.cache_control && p.cache_control.type === 'ephemeral');

  // [C] explicit-breakpoint model (Anthropic): the stable head must be marked.
  let body = captureBody();
  await chatCompletions({
    apiKey: 'k', model: 'anthropic/claude-sonnet-4.5', sessionId: 'sess-1',
    tools: [{ type: 'function', function: { name: 'x' } }],
    messages: [
      { role: 'system', content: bigSystem },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
    ],
  });
  console.log('\n[C] cache breakpoints — explicit model');
  const sys = body.messages.find((m) => m.role === 'system');
  check('system message is marked', hasBreakpoint(sys), sys && sys.content);
  check('system text preserved', Array.isArray(sys.content) && sys.content[0].text === bigSystem, 'mismatch');
  const marked = body.messages.filter(hasBreakpoint);
  check('at most 2 breakpoints', marked.length <= 2, marked.length);
  const asst = body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  check('assistant tool_calls message NOT marked', !hasBreakpoint(asst), asst && asst.content);

  // [D] auto-caching model: payload must be left alone entirely.
  body = captureBody();
  await chatCompletions({
    apiKey: 'k', model: 'deepseek/deepseek-v4-flash', sessionId: 'sess-2',
    messages: [{ role: 'system', content: bigSystem }, { role: 'user', content: 'hi' }],
  });
  console.log('\n[D] cache breakpoints — auto-caching model');
  check('system content left as a plain string', typeof body.messages[0].content === 'string', typeof body.messages[0].content);
  check('no cache_control anywhere', !JSON.stringify(body.messages).includes('cache_control'), 'found cache_control');

  // [E] short conversation: nothing worth caching, leave it alone.
  body = captureBody();
  await chatCompletions({
    apiKey: 'k', model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'system', content: 'tiny' }, { role: 'user', content: 'hi' }],
  });
  console.log('\n[E] below the cacheable floor');
  check('no breakpoint on a tiny payload', !JSON.stringify(body.messages).includes('cache_control'), 'found cache_control');

  // [F] routing + overflow fields
  body = captureBody();
  await chatCompletions({
    apiKey: 'k', model: 'deepseek/deepseek-v4-flash', sessionId: 'sess-3',
    tools: [{ type: 'function', function: { name: 'x' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  console.log('\n[F] routing fields');
  check('session_id sent for sticky routing', body.session_id === 'sess-3', body.session_id);
  check('provider.require_parameters is true', body.provider && body.provider.require_parameters === true, body.provider);
  check('no provider.sort by default (it busts the cache)', !body.provider.sort, body.provider);
  check('transforms: middle-out as overflow net', JSON.stringify(body.transforms) === '["middle-out"]', body.transforms);
  check('stream_options requests usage', body.stream_options && body.stream_options.include_usage === true, body.stream_options);
}

function boundedResultTests() {
  console.log('\n[G] tool results bounded at write time');
  const short = 'x'.repeat(100);
  check('short result untouched', boundToolResult(short) === short, 'changed');
  const long = 'A'.repeat(5000) + 'MIDDLE' + 'B'.repeat(20000) + 'TAIL_MARKER';
  const out = boundToolResult(long);
  check('long result is shortened', out.length < long.length, out.length);
  check('head kept', out.startsWith('AAAA'), out.slice(0, 10));
  check('tail kept', out.endsWith('TAIL_MARKER'), out.slice(-20));
  check('truncation is announced', /characters truncated/.test(out), 'no marker');
}

(async () => {
  await streamingTests();
  await pairingTest();
  await subAgentIsolationTest();
  await cacheTests();
  boundedResultTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
