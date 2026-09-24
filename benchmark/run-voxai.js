/**
 * VoxAI Coder benchmark harness — runs the real backend (runAgent) headlessly
 * against OpenRouter with the SAME model and API key as the desktop app,
 * capturing every usage event (input/output/cache tokens + real cost).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'voxai-coder');
const benchDir = path.join(ROOT, 'benchmark', 'work-voxai');
fs.mkdirSync(benchDir, { recursive: true });
for (const f of fs.readdirSync(benchDir)) fs.unlinkSync(path.join(benchDir, f));

const { runAgent } = require(path.join(APP, 'src', 'backend', 'agent'));
const sessions = require(path.join(APP, 'src', 'backend', 'sessions'));

// API key from the website's .dev.vars (same OpenRouter account the app uses)
const dv = fs.readFileSync('A:\\Github\\VoxAI_Website\\.dev.vars', 'utf8');
const keyLine = dv.split('\n').find(l => l.startsWith('OPENROUTER_API_KEY='));
const apiKey = keyLine.split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');

const MODEL = '~deepseek/deepseek-v4-flash-latest';
const TASK = `In the current directory create fib.py with:
def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)
and a main block that prints fib(10). Then run \`python fib.py\` and report the exact output.`;

async function main() {
  const session = sessions.createSession({ workdir: benchDir, model: MODEL, title: 'bench' });
  const usageEvents = [];
  const toolCalls = [];
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
  })) {
    if (ev.type === 'usage') {
      usageEvents.push(ev.usage);
      const c = ev.usage.prompt_tokens_details?.cached_tokens || 0;
      console.log(`  [req ${usageEvents.length}] in=${ev.usage.prompt_tokens} out=${ev.usage.completion_tokens} cached=${c} cost=$ ${ev.usage.cost}`);
    }
    if (ev.type === 'tool_start') toolCalls.push({ name: ev.name, args: ev.args });
    if (ev.type === 'done') console.log('\n[DONE]', String(ev.content).slice(0, 300));
    if (ev.type === 'error') console.log('[ERROR]', ev.message);
  }

  const ms = Date.now() - t0;

  let inTok = 0, outTok = 0, cacheRead = 0, cacheMiss = 0, cost = 0;
  for (const u of usageEvents) {
    inTok += u.prompt_tokens || 0;
    outTok += u.completion_tokens || 0;
    cacheRead += u.prompt_tokens_details?.cached_tokens || 0;
    cacheMiss += Math.max(0, (u.prompt_tokens || 0) - (u.prompt_tokens_details?.cached_tokens || 0));
    cost += u.cost || 0;
  }

  console.log('\n=== VOXAI CODER BENCH ===');
  console.log('model:', MODEL);
  console.log('tool calls:', toolCalls.length, '->', toolCalls.map(t => t.name).join(', '));
  console.log(`elapsed: ${(ms / 1000).toFixed(2)}s`);
  console.log(`API round-trips: ${usageEvents.length}`);
  console.log(`input tokens (sent): ${inTok}`);
  console.log(`  cache-read:        ${cacheRead} (${inTok ? Math.round(100 * cacheRead / inTok) : 0}%)`);
  console.log(`  cache-miss (new):  ${cacheMiss}`);
  console.log(`output tokens: ${outTok}`);
  console.log(`OpenRouter-reported cost: $${cost.toFixed(6)}`);
  console.log(`session messages after run: ${session.messages.length}`);
}

main().catch(e => { console.error('BENCH ERR', e); process.exit(1); });