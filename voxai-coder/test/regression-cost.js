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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
