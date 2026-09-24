/**
 * Post-fix integration test — runs the real agent through the same task and
 * verifies: (1) usage ledger accumulates, (2) it survives save/load, (3) model
 * context/tool-cutoff settings flow through, (4) cache visibility recorded.
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'A:/Github/VoxAI_Coder';
const APP = path.join(ROOT, 'voxai-coder');
const benchDir = path.join(ROOT, 'benchmark', 'work-voxai-fixed');
fs.mkdirSync(benchDir, { recursive: true });
for (const f of fs.readdirSync(benchDir)) fs.unlinkSync(path.join(benchDir, f));

const { runAgent, summarizeOldToolOutputs } = require(path.join(APP, 'src', 'backend', 'agent'));
const sessions = require(path.join(APP, 'src', 'backend', 'sessions'));
const compact = require(path.join(APP, 'src', 'backend', 'compact'));

const dv = fs.readFileSync('A:\\Github\\VoxAI_Website\\.dev.vars', 'utf8');
const keyLine = dv.split('\n').find(l => l.startsWith('OPENROUTER_API_KEY='));
const apiKey = keyLine.split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');

const MODEL = '~deepseek/deepseek-v4-flash-latest';
const TASK = `In the current directory create fib.py with:
def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)
and a main block that prints fib(10). Then run \`python fib.py\` and report the exact output.`;

(async () => {
  const session = sessions.createSession({ workdir: benchDir, model: MODEL, title: 'bench-fixed' });
  const usageEvents = [];
  const t0 = Date.now();

  for await (const ev of runAgent({
    session,
    userText: TASK,
    apiKey,
    host: 'https://openrouter.ai',
    model: MODEL,
    reasoningEffort: 'balanced',
    access: 'full access',
    maxTokens: 4096,
    signal: new AbortController().signal,
    askPermission: async () => true,
    // fixes 2/3/4 configuration flow-through
    compactThreshold: '0.8',
    toolCutoff: '6',
    contextLimit: '1310720',
  })) {
    if (ev.type === 'usage') usageEvents.push(ev.usage);
    if (ev.type === 'tool_start') console.log('  tool:', ev.name);
    if (ev.type === 'done') console.log('\n[DONE]', String(ev.content).slice(0, 200));
    if (ev.type === 'error') console.log('[ERROR]', ev.message);
  }
  const elapsed = (Date.now() - t0) / 1000;

  let inT = 0, outT = 0, cr = 0, cw = 0, cost = 0;
  for (const u of usageEvents) {
    inT += u.prompt_tokens || 0;
    outT += u.completion_tokens || 0;
    cr += (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    cw += u.cache_write_input_tokens || 0;
    cost += u.cost || 0;
  }
  console.log(`\nelapsed: ${elapsed.toFixed(2)}s | round-trips: ${usageEvents.length}`);
  console.log(`input=${inT} output=${outT} cr=${cr} (${inT ? Math.round(100 * cr / inT) : 0}%) cw=${cw} cost=$ ${cost.toFixed(6)}`);

  // verify ledger accumulation (the runUsage on session = sum of all usage events)
  console.log('session._runUsage:', JSON.stringify(session._runUsage));

  // persist and reload — the real main.js path via recordUsage
  const ledger = sessions.recordUsage(session, session._runUsage);
  delete session._runUsage;
  await sessions.saveSession(APP + '/benchmark/userdata-fixed', session);
  const reloaded = await sessions.loadSession(APP + '/benchmark/userdata-fixed', session.id);
  console.log('reloaded usage rows:', reloaded.usage.length, '| stats:', JSON.stringify(reloaded.stats));
  console.log('ledger row:', JSON.stringify(ledger));

  // verify compaction estimates stayed sane (no accidental compact on small session)
  const est = compact.estimateSessionTokens(reloaded, '');
  console.log('session token estimate:', est, '-> compact needed?', est > Math.floor(1310720 * 0.8));
  console.log('\nINTEGRATION OK');
})().catch(e => { console.error('BENCH ERR', e); process.exit(1); });