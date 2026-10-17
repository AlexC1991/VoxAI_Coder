/**
 * Token and cost savings, offline: a fake OpenRouter records what each request carries.
 * Run: node test/regression-cost.js
 *
 *   [P1] the start of every request stays the same through a session; project changes are told
 *        in a note instead, and a summary or a change of mode builds the prompt afresh
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

// Every request the agent sends, in order, with the script deciding each reply.
const SENT = [];
function fakeOpenRouter(script) {
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.stream === false) return { ok: true, text: async () => '' };
    SENT.push(body);
    const n = (body.messages || []).filter((m) => m && m.role === 'assistant').length + 1;
    const chunks = script(n, body);
    const enc = new TextEncoder();
    return {
      ok: true, text: async () => '',
      body: new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
    };
  };
}
const say = (text) => [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
const call = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];
async function drain(gen) {
  const events = [];
  for await (const ev of gen) {
    events.push(ev);
    if (['done', 'error', 'cancelled', 'limit_reached', 'budget_reached'].includes(ev.type)) break;
  }
  return events;
}
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));

(async () => {
  const { runAgent } = require(path.join(ROOT, 'src/backend/agent.js'));
  const prefix = require(path.join(ROOT, 'src/backend/prefix.js'));
  const store = require(path.join(ROOT, 'src/backend/sessions.js'));

  // ------------------------------------------------------------------ [P1]
  console.log('\n[P1] a fixed start for every request in a session');
  {
    const mem = (facts) => '[PROJECT MEMORY] (n stored facts)\n' + facts.map((f) => '- ' + f).join('\n');
    const d1 = mem(['uses pnpm', 'tests in test/']) + '\n\n[BUILD STATE] step 1';
    const d2 = mem(['uses pnpm', 'tests in test/', 'deploys to Pages']) + '\n\n[BUILD STATE] step 1';
    check('nothing changed, nothing said', prefix.durableChanges(d1, d1, '2026-10-18', '2026-10-18') === '', 'note');
    const n = prefix.durableChanges(d1, d2, '2026-10-18', '2026-10-18');
    check('a new memory fact is told, and only it', /^\[VOX CONTEXT\]/.test(n) && n.includes('New in project memory:\n- deploys to Pages') && !n.includes('- uses pnpm'), n);
    const g = prefix.durableChanges(d2, mem(['uses pnpm', 'deploys to Pages']) + '\n\n[BUILD STATE] step 2', '2026-10-18', '2026-10-19');
    check('a removed fact, a changed build state and a new day are told', g.includes('Removed from project memory') && g.includes('- tests in test/') && g.includes('It now reads:\n[BUILD STATE] step 2') && g.includes("Today's date is now 2026-10-19."), g);

    const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost-'));
    fs.mkdirSync(path.join(WD, '.voxai'));
    const writeMem = (facts) => fs.writeFileSync(path.join(WD, '.voxai', 'memory.json'), JSON.stringify({ facts: facts.map((text) => ({ text, at: '2026-10-18T00:00:00Z' })) }));
    writeMem(['uses pnpm']);
    fakeOpenRouter(() => say('ok'));
    const session = { id: 'p1', workdir: WD, messages: [] };
    const run = (text, extra) => drain(runAgent({ session, userText: text, apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2, ...(extra || {}) }));

    SENT.length = 0; await run('first');
    const sys1 = SENT[0].messages[0].content;
    writeMem(['uses pnpm', 'deploys to Cloudflare Pages']);
    SENT.length = 0; await run('second');
    const req2 = SENT[0].messages;
    check('after the agent saved a fact, the next message starts exactly as before', req2[0].content === sys1, 'prompt changed');
    const noteAt = req2.findIndex((m) => m.role === 'user' && /^\[VOX CONTEXT\]/.test(textOf(m)));
    const askAt = req2.findIndex((m) => m.role === 'user' && textOf(m) === 'second');
    check('the new fact goes in a note just before the message', noteAt > 0 && askAt === noteAt + 1 && textOf(req2[noteAt]).includes('- deploys to Cloudflare Pages'), { noteAt, askAt });
    check('the earlier part of the conversation is untouched', JSON.stringify(req2.slice(0, 3)) === JSON.stringify(SENT[0].messages.slice(0, 3)) && textOf(req2[1]) === 'first', req2.slice(0, 3).map(textOf));
    SENT.length = 0; await run('third');
    const notes3 = SENT[0].messages.filter((m) => /^\[VOX CONTEXT\]/.test(textOf(m))).length;
    check('nothing new, no second note', notes3 === 1 && SENT[0].messages[0].content === sys1, notes3);

    // Saved and opened again (an app restart): the same prompt still.
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost-ud-'));
    Object.assign(session, { title: 't', model: 'm', createdAt: new Date().toISOString(), usage: [], todos: [] });
    await store.saveSession(UD, session);
    const back = await store.loadSession(UD, 'p1');
    check('the prompt is kept with the session across a restart', back.promptFrozen && back.promptFrozen.text === sys1, !!back.promptFrozen);

    // The user switched permission mode: the prompt says it, so it is built afresh.
    SENT.length = 0; await run('fourth', { access: 'ask' });
    check('a change of mode builds the prompt afresh', SENT[0].messages[0].content !== sys1 && SENT[0].messages[0].content.includes('deploys to Cloudflare Pages'), 'kept');
    const sys4 = SENT[0].messages[0].content;

    // A summary replaced the conversation's start: built afresh, with everything current.
    writeMem(['uses pnpm', 'deploys to Cloudflare Pages', 'Node 24']);
    session.messages.splice(0, 1, { role: 'user', content: '[VOX COMPACTED CONTEXT] earlier turns' });
    SENT.length = 0; await run('fifth', { access: 'ask' });
    const sys5 = SENT[0].messages[0].content;
    check('after a summary the prompt is built afresh, holding the newest memory', sys5 !== sys4 && sys5.includes('- Node 24') && !SENT[0].messages.some((m, i) => i > 0 && /^\[VOX CONTEXT\]/.test(textOf(m)) && textOf(m).includes('Node 24')), 'stale');

    // A resumed step (answering a question mid-run) never gets a note between a call and its result.
    writeMem(['uses pnpm', 'deploys to Cloudflare Pages', 'Node 24', 'ESM only']);
    const before = session.messages.length;
    SENT.length = 0; await drain(runAgent({ session, userText: '', resume: true, apiKey: 'k', model: 'm', access: 'ask', askPermission: async () => true, maxTurns: 2 }));
    check('no note on a resume; it waits for the next message', !session.messages.slice(before).some((m) => /^\[VOX CONTEXT\]/.test(textOf(m))), 'note on resume');
    SENT.length = 0; await run('sixth', { access: 'ask' });
    check('and comes with the next message', SENT[0].messages.some((m) => /^\[VOX CONTEXT\]/.test(textOf(m)) && textOf(m).includes('- ESM only')), 'lost');

    const HM = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    check('the chat does not draw the note as your message', HM.includes("if (/^\\[VOX CONTEXT\\]/.test(first)) continue;"), 'drawn');
    fs.rmSync(WD, { recursive: true, force: true }); fs.rmSync(UD, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ [P2]
  console.log('\n[P2] thinking: honest costs, Model default, helpers never at a dear level');
  {
    const OR = require(path.join(ROOT, 'src/backend/providers/openrouter.js'));
    check('a helper runs at the model\'s default at most; a lower choice carries over',
      OR.helperEffort('high') === 'default' && OR.helperEffort('max') === 'default' && OR.helperEffort('xhigh') === 'default' && OR.helperEffort('low') === 'low' && OR.helperEffort('default') === 'default' && OR.helperEffort('none') === 'none', [OR.helperEffort('high'), OR.helperEffort('low')]);
    check('sub-agents get the helper level, not the session\'s', fs.readFileSync(path.join(ROOT, 'src/backend/tools/spawn.js'), 'utf8').includes("reasoningEffort: require('../providers/openrouter').helperEffort(agentOpts.reasoningEffort),"), 'inherits');
    // The screenshot describer asks for low thinking, so a 900-token answer is not thought away.
    let sent = null;
    global.fetch = async (_u, opts) => { sent = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'a page' } }], usage: {} }), text: async () => JSON.stringify({ choices: [{ message: { content: 'a page' } }], usage: {} }) }; };
    const { describeScreenshot } = require(path.join(ROOT, 'src/backend/agent.js'));
    await describeScreenshot({ apiKey: 'k', model: 'vision/m', url: 'data:image/png;base64,AAAA', about: 'a click', request: 'check it' });
    check('the screenshot describer thinks briefly', sent && sent.reasoning && sent.reasoning.effort === 'low' && sent.max_tokens === 900, sent && { reasoning: sent.reasoning, max_tokens: sent.max_tokens });
    const HM = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    check('the Thinking menu leads with Model default, which follows each model', HM.includes("const rows = [{ key: 'default', name: 'Model default \\u00b7 ' + EFFORT_TEXT[def][0], on: followsModel,") && HM.includes("often 2\\u20134\\u00d7 the cost of Medium per step"), 'no default row');
    check('a level above the model\'s own shows in gold, and says why', HM.includes("c.classList.toggle('dear', dear);") && HM.includes('#chipReason.dear #chipReasonVal{color:var(--gold)}'), 'silent');
  }

  // ------------------------------------------------------------------ [P3]
  console.log('\n[P3] model profiles and the price-tier guard');
  {
    const P = require(path.join(ROOT, 'src/backend/profiles.js'));
    const OR = require(path.join(ROOT, 'src/backend/providers/openrouter.js'));
    const fam = (id) => P.profileOf(id).family;
    check('each family is told apart, aliases and all', fam('anthropic/claude-opus-5.5') === 'claude' && fam('openai/gpt-6.1-sol') === 'openai' && fam('~openai/gpt-latest') === 'openai'
      && fam('google/gemini-4-argon') === 'gemini' && fam('x-ai/grok-4.7') === 'grok' && fam('deepseek/deepseek-v4.1-flash') === 'deepseek' && fam('qwen/qwen3.8-flash') === 'qwen' && fam('meta/muse') === 'other' && fam('local/a.gguf') === 'local',
    ['claude', 'openai', 'gemini', 'grok'].map((x) => x));
    check('caching is as before: Claude and Qwen marked, the rest automatic', OR.cacheMode('anthropic/claude-fable-5.1') === 'explicit' && OR.cacheMode('qwen/qwen3.8-flash') === 'explicit' && OR.cacheMode('google/gemini-4-argon') === 'auto' && OR.cacheMode('openai/gpt-6-astra') === 'auto', 'changed');
    check('a context set past a price tier is capped for that model only', P.capContext(400000, 'openai/gpt-6.1-sol') === 258400 && P.capContext(400000, 'x-ai/grok-4.7') === 190000 && P.capContext(400000, 'anthropic/claude-fable-5.1') === 400000 && P.capContext(200000, 'openai/gpt-6.1-sol') === 200000 && P.capContext(0, 'openai/gpt-6.1-sol') === 0, [P.capContext(400000, 'openai/gpt-6.1-sol'), P.capContext(400000, 'x-ai/grok-4.7')]);
    // A real run: the limit the run works to (the context event) is the capped one.
    fakeOpenRouter(() => say('ok'));
    const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost3-'));
    const limitFor = async (model) => {
      const ev = await drain(runAgent({ session: { id: 'p3-' + model, workdir: WD, messages: [] }, userText: 'hi', apiKey: 'k', model, contextLimit: 400000, access: 'full', askPermission: async () => true, maxTurns: 2 }));
      const c = ev.find((e) => e.type === 'context'); return c && c.limit;
    };
    const lo = await limitFor('openai/gpt-6.1-sol'), lc = await limitFor('anthropic/claude-opus-5.5');
    check('a run on GPT-6.1 Sol with a 400k context works to 258k; on Claude, to 400k', lo === 258400 && lc === 400000, { openai: lo, claude: lc });
    fs.rmSync(WD, { recursive: true, force: true });
    const MM = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8'), HM = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    check('the catalogue carries each model\'s tier, and the Context page says it', MM.includes("priceTier: require('../backend/profiles').profileOf(m.id).priceTier || 0,") && HM.includes("' bills a whole request at a higher rate past ' + kTok(Number(m.priceTier))"), 'not shown');
  }

  // ------------------------------------------------------------------ [P4]
  console.log('\n[P4] short in-between messages');
  {
    const { _systemPrompt } = require(path.join(ROOT, 'src/backend/agent.js'));
    const sp = _systemPrompt('C:/w', 'full', false, '', true);
    const quiet = sp.indexOf('keep the text between tool calls to one short sentence, or none');
    const close = sp.indexOf('When you finish, close with one short message');
    check('the prompt asks for one short sentence between steps, code only in files', quiet > 0 && sp.includes('Put code only in files, through write, edit or patch -- never in a message.') && sp.includes('paste tool output back'), quiet);
    check('and it comes before the closing-message rules, which still stand', quiet > 0 && close > quiet, { quiet, close });
  }

  // ------------------------------------------------------------------ [P5]
  console.log('\n[P5] the stuck detector');
  {
    const { createStuckWatch } = require(path.join(ROOT, 'src/backend/stuck.js'));
    let w = createStuckWatch();
    const fails = [1, 2, 3, 4, 5].map(() => w.after('edit', { path: 'a.js' }, { ok: false, error: 'before text not found in a.js' }));
    check('a file that keeps failing to change: told at 3, told to ask the user at 5', !fails[0] && !fails[1] && /^\[stuck check\] Changing a\.js has now failed 3 times \(last: before text not found/.test(fails[2]) && !fails[3] && /tell the user what you were trying/.test(fails[4]), fails.map((f) => f.slice(0, 30)));
    w = createStuckWatch();
    w.after('edit', { path: 'a.js' }, { ok: false, error: 'x' }); w.after('edit', { path: 'a.js' }, { ok: false, error: 'x' });
    w.after('edit', { path: 'a.js' }, { ok: true });
    check('a success on the file starts the count again', w.after('edit', { path: 'a.js' }, { ok: false, error: 'x' }) === '', 'kept counting');
    w = createStuckWatch();
    const run = (cmd, exit, err) => w.after('shell', { command: cmd }, { ok: true, result: { exit, stdout: '', stderr: err } });
    const c = [run('npm test -- --grep 12', 1, 'Error: Cannot find module x at line 4'), run('npm test -- --grep 13', 1, 'Error: Cannot find module x at line 9'), run('npm test -- --grep 14', 1, 'Error: Cannot find module x at line 2')];
    check('the same command failing the same way 3 times, numbers aside', !c[0] && !c[1] && /^\[stuck check\] This command has failed the same way 3 times/.test(c[2]), c.map((x) => x.slice(0, 40)));
    w = createStuckWatch();
    run('npm test', 1, 'Error A'); run('npm test', 1, 'Error B');
    check('different failures are not the same failure', run('npm test', 1, 'Error C') === '', 'flagged');
    w = createStuckWatch();
    const looks = Array.from({ length: 16 }, () => w.after('read', { path: 'x' }, { ok: true }));
    check('15 looks without a change: one nudge, once', looks.filter(Boolean).length === 1 && /^\[progress check\] 15 steps/.test(looks[14]), looks.filter(Boolean).length);
    // In a real run: three failing edits to one file. The third result carries the note.
    const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost5-'));
    fs.writeFileSync(path.join(WD, 'app.js'), 'const a = 1;\n');
    fakeOpenRouter((n) => (n <= 3 ? call('e' + n, 'edit', { path: 'app.js', before: 'const b = ' + n + ';', after: 'x' }) : say('done')));
    const sess = { id: 'p5', workdir: WD, messages: [] };
    const ev = await drain(runAgent({ session: sess, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 6 }));
    const results = sess.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    check('in a run, the third failed edit to the same file says stop and rethink', results.length === 3 && !/stuck check/.test(results[1]) && /\[stuck check\] Changing app\.js has now failed 3 times/.test(results[2]), results.map((r) => r.slice(0, 60)));
    check('and the window is told', ev.some((e) => e.type === 'warning' && e.code === 'stuck-check'), ev.map((e) => e.type));
    fs.rmSync(WD, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ [P6]
  console.log('\n[P6] edits refuse text that matches more than once');
  {
    const tools = require(path.join(ROOT, 'src/backend/tools'));
    const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost6-'));
    const ctx = { workdir: WD, session: { messages: [] }, emit: () => {}, checkPermission: async () => {}, resolveIn: (w, p) => path.resolve(w, p), getSettings: () => ({}), getAccess: () => 'full' };
    const { ALL } = tools.buildTools(ctx);
    const T = (n) => ALL.find((t) => t.def.function.name === n);
    const F = path.join(WD, 'a.js');
    const body = 'function a() {\n  return null;\n}\nfunction b() {\n  return null;\n}\nfunction c() {\n  return 1;\n}\n';
    const tryRun = async (name, args) => { try { return { ok: true, r: await T(name).run(args, ctx) }; } catch (e) { return { ok: false, e: e.message }; } };
    fs.writeFileSync(F, body);
    await T('read').run({ path: 'a.js' }, ctx);
    let r = await tryRun('edit', { path: 'a.js', before: '  return null;', after: '  return 0;' });
    check('edit: text in two places is refused, with the lines, and the file is untouched', !r.ok && /appears 2 times in a\.js \(lines 2, 5\), so nothing was changed/.test(r.e) && fs.readFileSync(F, 'utf8') === body, r.e);
    r = await tryRun('edit', { path: 'a.js', before: 'function b() {\n  return null;', after: 'function b() {\n  return 0;' });
    check('edit: with one more line it matches once and changes just that one', r.ok && fs.readFileSync(F, 'utf8') === body.replace('function b() {\n  return null;', 'function b() {\n  return 0;'), r.e);
    fs.writeFileSync(F, body); await T('read').run({ path: 'a.js' }, ctx);
    r = await tryRun('edit', { path: 'a.js', before: '  return null;', after: '  return 0;', replace_all: true });
    check('edit: replace_all changes every one', r.ok && !fs.readFileSync(F, 'utf8').includes('return null') && r.r.places === 2, r.e || r.r);
    fs.writeFileSync(F, body); await T('read').run({ path: 'a.js' }, ctx);
    r = await tryRun('edit', { path: 'a.js', before: 'return null;', after: 'return 0;' });
    check('edit: the whitespace-tolerant match counts every place too', !r.ok && /appears 2 times/.test(r.e), r.e);
    r = await tryRun('edit', { path: 'a.js', before: '  return 1;', after: '  return 2;' });
    check('edit: text in one place still just works', r.ok && fs.readFileSync(F, 'utf8').includes('return 2;'), r.e);
    fs.writeFileSync(F, body); await T('read').run({ path: 'a.js' }, ctx);
    r = await tryRun('patch', { path: 'a.js', edits: [{ old: '  return 1;', new: '  return 3;' }, { old: '  return null;', new: '  return 0;' }] });
    check('patch: an edit matching twice refuses the whole patch, the file untouched', !r.ok && /edit #1: 'old' appears 2 times \(lines 2, 5\)/.test(r.e) && fs.readFileSync(F, 'utf8') === body, r.e);
    r = await tryRun('patch', { path: 'a.js', edits: [{ old: '  return null;', new: '  return 0;', all: true }] });
    check('patch: all: true changes every one', r.ok && !fs.readFileSync(F, 'utf8').includes('return null'), r.e);
    check('both tools tell the model up front', /must match exactly one place/.test(T('edit').def.function.description) && JSON.stringify(T('patch').def).includes('must appear exactly once'), 'silent');
    fs.rmSync(WD, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ [P7]
  console.log('\n[P7] stale reads, old screenshots and long old outputs left out, in batches');
  {
    const PR = require(path.join(ROOT, 'src/backend/prune.js'));
    const tcall = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const tres = (id, content) => ({ role: 'tool', tool_call_id: id, content });
    const shots = (n) => ({ role: 'user', content: [{ type: 'text', text: '[VOX TOOL SCREENSHOTS] ' + n + ' screenshots from computer above.' }, ...Array.from({ length: n }, () => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }))] });
    const big = (c, n) => c.repeat(n);
    const build = () => [
      { role: 'user', content: 'turn 1' }, tcall('r1', 'read', { path: 'a.js' }), tres('r1', big('A', 9000)), tcall('r2', 'read', { path: 'b.js' }), tres('r2', big('B', 9000)),
      { role: 'user', content: 'turn 2' }, tcall('e1', 'edit', { path: 'a.js', before: 'x', after: 'y' }), tres('e1', '{"ok":true}'), tcall('s1', 'shell', { command: 'npm run build' }), tres('s1', big('L', 12000)), tcall('c1', 'computer', { action: 'screenshot' }), tres('c1', '{}'), shots(2),
      { role: 'user', content: 'turn 3' }, tcall('c2', 'computer', { action: 'screenshot' }), tres('c2', '{}'), shots(1),
      { role: 'user', content: 'turn 4' }, tcall('r3', 'read', { path: 'b.js' }), tres('r3', big('b', 9000)),
      { role: 'user', content: 'turn 5' }, tcall('c3', 'computer', { action: 'screenshot' }), tres('c3', '{}'), shots(1),
      { role: 'user', content: 'turn 6' },
    ];
    const ms = build();
    const acts = PR.plan(ms);
    const kinds = acts.map((a) => a.key).sort();
    check('it picks reads of files edited or read again since, the long old log, and screenshots past the newest two', JSON.stringify(kinds) === JSON.stringify(['r1', 'r2', 's1', 'shots:c1']), kinds);
    check('the newer read of b.js, inside the last three turns, stays', !acts.some((a) => a.key === 'r3'), kinds);
    const original = JSON.parse(JSON.stringify(ms));
    const store = {};
    PR.apply(ms, acts, store);
    check('the model\'s copy says what was left out', ms[2].content.startsWith('[VOX PRUNED] An earlier read of a.js') && /characters of this older output were left out/.test(ms[9].content) && ms[12].content.filter((p) => p.type === 'image_url').length === 0, [ms[2].content.slice(0, 40)]);
    check('the last three turns are never touched', JSON.stringify(ms.slice(13)) === JSON.stringify(original.slice(13)), 'touched');
    check('the chat gets every original back', JSON.stringify(PR.restore(ms, store)) === JSON.stringify(original), 'lost');
    check('nothing is planned twice', PR.plan(ms, { store }).length === 0, PR.plan(ms, { store }).map((a) => a.key));
    check('a batch only when it pays: getting full and 24k saved, or 8k on a local model', PR.worthIt(30000, { tokens: 50000, limit: 100000 }) && !PR.worthIt(30000, { tokens: 30000, limit: 100000 }) && !PR.worthIt(20000, { tokens: 90000, limit: 100000 }) && PR.worthIt(9000, { tokens: 1, limit: 16000, local: true }), 'thresholds');
    check('after a summary, originals of folded messages are dropped', JSON.stringify(Object.keys(PR.tidy(ms.slice(13), store))) === '[]' && Object.keys(PR.tidy(ms, store)).length === 4, Object.keys(PR.tidy(ms, store)));

    // A real run: getting full, with stale reads -> one batch, sent shortened; the next message changes nothing.
    const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost7-'));
    const sess = { id: 'p7', workdir: WD, messages: build() };
    fakeOpenRouter(() => say('ok'));
    SENT.length = 0;
    const ev1 = await drain(runAgent({ session: sess, userText: 'turn 7', apiKey: 'k', model: 'm', contextLimit: 40000, access: 'full', askPermission: async () => true, maxTurns: 2 }));
    const req1 = SENT[0].messages;
    check('a run getting full leaves the stale parts out of what it sends', ev1.some((e) => e.type === 'pruned') && req1.some((m) => m.role === 'tool' && String(m.content).startsWith('[VOX PRUNED] An earlier read of a.js')) && !req1.some((m) => m.role === 'tool' && m.content === big('A', 9000)), ev1.map((e) => e.type).filter((t) => t !== 'token'));
    check('the session keeps the originals for the chat', sess.prunedStore && sess.prunedStore.r1 === big('A', 9000), Object.keys(sess.prunedStore || {}));
    SENT.length = 0;
    const ev2 = await drain(runAgent({ session: sess, userText: 'turn 8', apiKey: 'k', model: 'm', contextLimit: 40000, access: 'full', askPermission: async () => true, maxTurns: 2 }));
    const req2 = SENT[0].messages;
    check('the next message leaves history as it was, so the cache holds', !ev2.some((e) => e.type === 'pruned') && JSON.stringify(req2.slice(0, req1.length)) === JSON.stringify(req1), ev2.some((e) => e.type === 'pruned'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost7-ud-'));
    Object.assign(sess, { title: 't', model: 'm', createdAt: new Date().toISOString(), usage: [], todos: [] });
    await require(path.join(ROOT, 'src/backend/sessions.js')).saveSession(UD, sess);
    const back = await require(path.join(ROOT, 'src/backend/sessions.js')).loadSession(UD, 'p7');
    check('the originals are saved with the session', back.prunedStore && back.prunedStore.r1 === big('A', 9000), Object.keys(back.prunedStore || {}));
    check('the window gets them back when it opens a session', fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8').includes("messages: require('../backend/prune').restore(sess.messages, sess.prunedStore),"), 'stubs shown');
    fs.rmSync(WD, { recursive: true, force: true }); fs.rmSync(UD, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ [P8]
  console.log('\n[P8] only the memory that matters, the project\'s commands, a lean local prompt');
  {
    const PF = require(path.join(ROOT, 'src/backend/projectfacts.js'));
    const facts = Array.from({ length: 20 }, (_, i) => ({ text: `fact ${i} about the widget renderer`, at: '2026-10-01T00:00:0' + (i % 10) + 'Z' }));
    facts[3] = { text: 'payments go through Stripe checkout sessions, never raw card data', at: '2026-10-01T00:00:00Z' };
    facts[11] = { text: 'the Stripe webhook secret lives in STRIPE_WEBHOOK_SECRET', at: '2026-10-01T00:00:00Z' };
    const p1 = PF.pickFacts(facts, { query: 'add a Stripe refund button to checkout', keep: 4 });
    check('the facts related to the opening request are picked, in their stored order', p1.shown.length === 4 && p1.shown[0] === facts[3] && p1.shown[1] === facts[11] && p1.more === 16, p1.shown.map((f) => f.text.slice(0, 24)));
    check('the same request picks the same facts every time', JSON.stringify(PF.pickFacts(facts, { query: 'add a Stripe refund button to checkout', keep: 4 })) === JSON.stringify(p1), 'unstable');
    check('a small memory is shown whole', PF.pickFacts(facts.slice(0, 5), { query: 'x', keep: 12 }).shown.length === 5, 'cut');
    const withNew = facts.concat([{ text: 'refunds need a reason code', at: '2026-10-18T09:00:00Z' }]);
    const p2 = PF.pickFacts(withNew, { query: 'add a Stripe refund button to checkout', keep: 4, since: '2026-10-18T00:00:00Z' });
    check('a fact saved during the session is always shown, and none of the others is pushed out', p2.shown.length === 5 && p2.shown.includes(withNew[20]) && p1.shown.every((f) => p2.shown.includes(f)), p2.shown.map((f) => f.text.slice(0, 20)));

    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost8-'));
    const proj = (name, files) => { const d = path.join(D, name); fs.mkdirSync(d); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d; };
    const cmds = (d) => PF.detectCommands(d).map((x) => x.what + '=' + x.command).join(', ');
    check('npm: tests, type check, build and lint from package.json', cmds(proj('a', { 'package.json': JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc -b', build: 'vite build', lint: 'eslint .' } }) })) === 'Tests=npm test, Type check=npm run typecheck, Build=npm run build, Lint=npm run lint', cmds(path.join(D, 'a')));
    check('npm init\'s placeholder test is not a test command', cmds(proj('b', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', start: 'node .' } }) })) === 'Start=npm run start', cmds(path.join(D, 'b')));
    check('pnpm is used where the lock file says so', cmds(proj('c', { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' })) === 'Tests=pnpm test', cmds(path.join(D, 'c')));
    check('Rust, Go, Python and make are found too', cmds(proj('d', { 'Cargo.toml': '' })).startsWith('Tests=cargo test') && cmds(proj('e', { 'go.mod': '' })).startsWith('Tests=go test ./...')
      && cmds(proj('f', { 'pyproject.toml': '[tool.pytest.ini_options]' })) === 'Tests=python -m pytest' && cmds(proj('g', { Makefile: 'test:\n\tgo test\n' })) === 'Tests=make test', [cmds(path.join(D, 'f'))]);

    // The instructions: commands in, memory cut to what matters, no skills list on a local model.
    fs.mkdirSync(path.join(D, 'a', '.voxai'));
    fs.writeFileSync(path.join(D, 'a', '.voxai', 'memory.json'), JSON.stringify({ facts }));
    const { _loadDurableContext } = require(path.join(ROOT, 'src/backend/agent.js'));
    const cloud = await _loadDurableContext(path.join(D, 'a'), '', { query: 'Stripe refund' });
    const local = await _loadDurableContext(path.join(D, 'a'), '', { query: 'Stripe refund', local: true });
    check('the instructions name the project\'s commands', cloud.includes('[PROJECT COMMANDS]') && cloud.includes('- Tests: npm test'), cloud.slice(0, 200));
    check('memory: 12 facts that matter and a pointer to the rest', /\[PROJECT MEMORY\] \(20 stored facts; the 12 that matter most to this session are below, and 8 more are one memory search away/.test(cloud) && (cloud.match(/^- /gm) || []).length >= 12, 'all facts');
    check('a local model gets 6 facts and no skills list', /the 6 that matter most/.test(local) && !local.includes('[SKILLS]') && cloud.includes('[SKILLS]'), 'full');

    // A real session: the opening request picks; a fact saved later comes as "new", nothing "removed".
    fakeOpenRouter(() => say('ok'));
    const sess = { id: 'p8', workdir: path.join(D, 'a'), messages: [] };
    SENT.length = 0; await drain(runAgent({ session: sess, userText: 'add a Stripe refund button', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2 }));
    const sys1 = SENT[0].messages[0].content;
    check('the session\'s prompt carries the Stripe facts', sys1.includes('payments go through Stripe') && sys1.includes('STRIPE_WEBHOOK_SECRET'), 'missing');
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(D, 'a', '.voxai', 'memory.json'), JSON.stringify({ facts: facts.concat([{ text: 'refunds need a reason code', at: new Date().toISOString() }]) }));
    SENT.length = 0; await drain(runAgent({ session: sess, userText: 'now the tests', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2 }));
    const note = SENT[0].messages.map(textOf).find((t) => /^\[VOX CONTEXT\]/.test(t)) || '';
    check('a fact saved later: same prompt, a note saying it is new, nothing said to be removed', SENT[0].messages[0].content === sys1 && note.includes('- refunds need a reason code') && !note.includes('Removed'), note.slice(0, 160));
    fs.rmSync(D, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ [P9]
  console.log('\n[P9] your cost per message, a project overview, a check before "done"');
  {
    const CS = require(path.join(ROOT, 'src/backend/coststats.js'));
    const SD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost9-'));
    const sessFile = (id, model, runs) => fs.writeFileSync(path.join(SD, id + '.jsonl'), [JSON.stringify({ kind: 'meta', id, model })].concat(runs.map((r) => JSON.stringify({ kind: 'run', run: r }))).join('\n'));
    sessFile('s1', 'google/gemini-4-argon', [{ cost: 0.30 }, { cost: 0.10 }, { cost: 0.20, model: 'google/gemini-4-argon' }, { cost: 0 }]);
    sessFile('s2', 'deepseek/deepseek-v4.1-flash', [{ cost: 0.01 }, { cost: 0.03, model: 'google/gemini-4-argon' }]);
    const st = await CS.modelCosts(SD);
    check('cost per message per model, from the sessions, a run\'s own model first', st['google/gemini-4-argon'].runs === 4 && Math.abs(st['google/gemini-4-argon'].median - 0.15) < 1e-9 && st['deepseek/deepseek-v4.1-flash'].runs === 1, st);
    fs.rmSync(SD, { recursive: true, force: true });
    const HM = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8'), MM = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
    check('runs now record their model, and the picker footer says what a message costs you, after 3', MM.includes("model: sess.model || getSettings(false).openrouterModel || '',") && HM.includes("const per = cs && cs.runs >= 3 ? ") && HM.includes("' a message for you'"), 'missing');

    const PF = require(path.join(ROOT, 'src/backend/projectfacts.js'));
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost9p-'));
    for (const d of ['src', 'test', 'node_modules', '.git', 'dist']) fs.mkdirSync(path.join(D, d));
    fs.writeFileSync(path.join(D, 'package.json'), JSON.stringify({ description: 'A shop', scripts: { test: 'vitest' }, dependencies: { react: '1', stripe: '1' }, devDependencies: { vite: '1', vitest: '1' } }));
    fs.writeFileSync(path.join(D, 'README.md'), '![badge](x)\n# Shop\n\nSells hats.\n');
    fs.writeFileSync(path.join(D, 'notes.tmp'), 'x');
    const ov = PF.overviewSection(D);
    check('the overview: folders (no node_modules, .git or dist), key files, stack, README', ov.includes('Folders: src/, test/') && !/node_modules|dist\//.test(ov) && ov.includes('Key files: README.md, package.json') && ov.includes('Uses: react, vite, vitest') && ov.includes('About: A shop') && ov.includes('README begins: # Shop Sells hats.') && !ov.includes('badge'), ov);
    check('a local model gets it without the README', !PF.overviewSection(D, { local: true }).includes('README begins'), 'readme');

    // The check before "done", in real runs.
    const runWith = async (steps) => {
      const sess = { id: 'p9-' + Math.random(), workdir: D, messages: [] };
      fakeOpenRouter((n) => steps[n - 1] || say('done'));
      const ev = await drain(runAgent({ session: sess, userText: 'add a hat', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 8 }));
      return { sess, ev, nudges: sess.messages.filter((m) => m.role === 'user' && /^\[VOX CHECK\]/.test(textOf(m))) };
    };
    let r = await runWith([call('w1', 'write', { path: 'src/hat.js', content: 'export const hat = 1;\n' }), say('Added the hat.'), say('The tests pass. Added the hat.')]);
    check('changed code, ran nothing, said done: one reminder naming the project\'s test command', r.nudges.length === 1 && textOf(r.nudges[0]).includes('with npm test') && r.ev.some((e) => e.type === 'warning' && e.code === 'check-nudge'), r.nudges.map(textOf));
    check('and the run then finishes', r.ev.some((e) => e.type === 'done'), r.ev.map((e) => e.type).slice(-3));
    r = await runWith([call('w1', 'write', { path: 'src/hat.js', content: 'export const hat = 2;\n' }), call('s1', 'shell', { command: 'echo checked' }), say('Added the hat; checked it.')]);
    check('ran something after the change: no reminder', r.nudges.length === 0, r.nudges.length);
    r = await runWith([call('w1', 'write', { path: 'NOTES.md', content: '# notes\n' }), say('Wrote the notes.')]);
    check('only docs changed: no reminder', r.nudges.length === 0, r.nudges.length);
    check('the chat does not draw the reminder as your message', HM.includes('if (/^\\[VOX CHECK\\]/.test(first)) { finalizeRunCard(); continue; }'), 'drawn');
    fs.rmSync(D, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ [P10]
  console.log('\n[P10] duplicate tools leave what the model is offered, and still work by name');
  {
    const tools = require(path.join(ROOT, 'src/backend/tools'));
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cost10-'));
    fs.writeFileSync(path.join(D, 'prices.csv'), 'item,price\nhat,12\nscarf,30\n');
    fs.writeFileSync(path.join(D, 'shop.js'), 'export const hat = 12;\n');
    const ctx = { workdir: D, session: { messages: [] }, emit: () => {}, checkPermission: async () => {}, resolveIn: (w, p) => path.resolve(w, p), getSettings: () => ({}), getAccess: () => 'full' };
    const { ALL } = tools.buildTools(ctx);
    const offered = ALL.filter((t) => !t.hidden).map((t) => t.def.function.name);
    check('search and doc_rag are not offered; grep, glob, edit, patch and rag are', !offered.includes('search') && !offered.includes('doc_rag') && ['grep', 'glob', 'edit', 'patch', 'rag'].every((n) => offered.includes(n)), offered);
    check('the tool definitions everyone else reads leave them out too', !tools.definitions({ workdir: D }).some((d) => ['search', 'doc_rag'].includes(d.function.name)), 'listed');
    const rag = ALL.find((t) => t.def.function.name === 'rag');
    const r = await rag.run({ path: 'prices.csv', query: 'scarf price' }, ctx);
    check('rag reads a document through the document reader', JSON.stringify(r).includes('scarf') && /documents/.test(rag.def.function.description), JSON.stringify(r).slice(0, 120));
    // A model that still calls search by name: it runs, it is not "no such tool".
    fakeOpenRouter((n) => (n === 1 ? call('s1', 'search', { query: 'hat' }) : say('found it')));
    const sess = { id: 'p10', workdir: D, messages: [] };
    SENT.length = 0;
    await drain(runAgent({ session: sess, userText: 'where is hat', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3 }));
    const res = sess.messages.find((m) => m.role === 'tool');
    check('a call to search by name still runs', res && !/There is no tool called/.test(res.content) && /shop\.js/.test(res.content), res && res.content.slice(0, 120));
    check('and the request offered neither', SENT[0] && !SENT[0].tools.some((t) => ['search', 'doc_rag'].includes(t.function.name)), SENT[0] && SENT[0].tools.length);
    fs.rmSync(D, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
