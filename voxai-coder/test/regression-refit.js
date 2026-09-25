/**
 * The conversation refit (design approved 2026-09-25).
 *
 *   [CA] approvals: Allow runs the tool, asked once, Edit and test runs tests, Always sticks
 *   [CB] reasoning: what is sent comes from the model's catalogue entry
 *   [CC] the renderer: steps, model names, reasoning rows, the context heads-up, markup
 *
 * Offline. Run: node test/regression-refit.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

const NATIVE_FETCH = global.fetch;   // the fakes below replace it

/** A fake OpenRouter that replies with `script(n)` for the n-th request. */
function fakeOpenRouter(script) {
  let n = 0;
  global.fetch = async (_url, opts) => {
    n++;
    const chunks = script(n, JSON.parse(opts.body));
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

(async () => {
  const { runAgent } = require(path.join(ROOT, 'src/backend/agent.js'));
  const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-refit-'));

  // ------------------------------------------------------------------ [CA]
  console.log('\n[CA] approvals do what they say');
  {
    // One shell call, then a plain answer.
    const runShell = async (access, command, answer) => {
      fakeOpenRouter((n) => (n === 1 ? call('c1', 'shell', { command }) : say('done')));
      const asked = [];
      const askPermission = async (q) => { asked.push(q); return answer; };
      const ev = await drain(runAgent({ session: { id: 'ca-' + access, workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access, askPermission, maxTurns: 3 }));
      return { asked, end: ev.find((e) => e.type === 'tool_end' && e.name === 'shell') };
    };

    const ok = await runShell('edit', 'node -e console.log(424242)', true);
    check('Allow runs the command', ok.end && ok.end.ok === true && /424242/.test(JSON.stringify(ok.end.result)), ok.end);
    check('asked exactly once, not again by the tool', ok.asked.length === 1, ok.asked);
    check('the prompt shows the command, not JSON', ok.asked[0] && ok.asked[0].kind === 'shell' && ok.asked[0].target === 'node -e console.log(424242)', ok.asked[0]);

    const no = await runShell('edit', 'node -e console.log(737373)', false);
    check('Deny stops it', no.end && no.end.ok === false && /permission denied/.test(String(no.end.result)), no.end);
    check('and it is not run', !/"stdout"/.test(String(no.end && no.end.result)), no.end);

    // Read-only commands run at every level without a prompt; anything that changes
    // something still asks.
    const ro = await runShell('ask', 'dir', true);
    check('a read-only command runs without asking, even at Ask first', ro.asked.length === 0 && ro.end && ro.end.ok === true, ro.asked);
    const { isReadOnlyCommand } = require(path.join(ROOT, 'src/backend/tools/sandbox.js'));
    const readOnly = ['dir /b', 'git status', 'git log --oneline -5', 'type README.md | findstr todo', 'node --version', 'dir /a /b && git status --short 2>NUL & echo --- & git rev-parse --is-inside-work-tree 2>NUL', 'git status 2>&1 | findstr /i fatal & echo done'];
    const changes = ['ls > out.txt', 'del a.txt', 'git push', 'git branch -D x', 'cat a && rm b', 'dir /b && node todo.js list', 'npm install', 'dir /b & del x.txt', 'git status > log.txt', 'rm -rf x 2>NUL'];
    check('read-only commands are recognised', readOnly.every(isReadOnlyCommand), readOnly.filter((c) => !isReadOnlyCommand(c)));
    check('anything that changes something is not', !changes.some(isReadOnlyCommand), changes.filter(isReadOnlyCommand));

    const t = await runShell('test', 'ruff --version', true);
    check('Edit and test runs a check without asking', t.asked.length === 0, t.asked);
    const t2 = await runShell('test', 'node -e 1', true);
    check('Edit and test still asks about other commands', t2.asked.length === 1, t2.asked);

    // Writing at "ask first": one prompt, then the file exists.
    fakeOpenRouter((n) => (n === 1 ? call('w1', 'write', { path: 'a.txt', content: 'hi' }) : say('done')));
    const wAsk = [];
    await drain(runAgent({ session: { id: 'ca-w', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'ask', askPermission: async (q) => { wAsk.push(q); return true; }, maxTurns: 3 }));
    check('Ask first: an approved write happens', fs.existsSync(path.join(WD, 'a.txt')), fs.readdirSync(WD));
    check('Ask first: one prompt naming the file', wAsk.length === 1 && wAsk[0].kind === 'write-file' && wAsk[0].target === 'a.txt', wAsk);

    const PRE = read('src/preload/preload.js');
    check('"Always" reaches the main process', /agentPermission: \(permId, allowed, always\)[^\n]*always: !!always/.test(PRE), 'flag dropped');
  }

  // ------------------------------------------------------------------ [CB]
  console.log('\n[CB] reasoning follows the catalogue');
  {
    const { reasoningParam, normalizeReasoning } = require(path.join(ROOT, 'src/backend/providers/openrouter.js'));
    const dsv4 = { supported_efforts: ['max', 'high', 'low'], default_effort: 'high', default_enabled: true, mandatory: false };
    const grok = { supported_efforts: ['high', 'medium', 'low', 'none'], default_effort: 'low', default_enabled: true, mandatory: false };
    const r1 = { supported_efforts: [], mandatory: true };
    const onoff = { supported_efforts: [], default_enabled: true, mandatory: false };
    const j = (x) => JSON.stringify(x);
    check('model default sends nothing', j(reasoningParam('default', dsv4, 'x')) === '{}', reasoningParam('default', dsv4));
    check('a level the model has is sent as is', j(reasoningParam('high', dsv4)) === j({ reasoning: { effort: 'high' } }), reasoningParam('high', dsv4));
    check('a level it lacks moves to the nearest', j(reasoningParam('medium', dsv4)) === j({ reasoning: { effort: 'high' } }), reasoningParam('medium', dsv4));
    check('Off without a "none" level turns thinking off', j(reasoningParam('none', dsv4)) === j({ reasoning: { enabled: false } }), reasoningParam('none', dsv4));
    check('Off with a "none" level sends none', j(reasoningParam('none', grok)) === j({ reasoning: { effort: 'none' } }), reasoningParam('none', grok));
    check('a model that always thinks is left alone', j(reasoningParam('none', r1)) === '{}' && j(reasoningParam('high', r1)) === '{}', reasoningParam('none', r1));
    check('an on/off model gets enabled', j(reasoningParam('high', onoff)) === j({ reasoning: { enabled: true } }), reasoningParam('high', onoff));
    check('a model that cannot reason gets nothing', j(reasoningParam('high', null)) === '{}', reasoningParam('high', null));
    check('old saved words are read', normalizeReasoning('balanced') === 'default' && normalizeReasoning('instant') === 'none' && normalizeReasoning('deep') === 'high', 'unmapped');
  }

  // ------------------------------------------------------------------ [CC]
  console.log('\n[CC] the renderer pieces, run for real');
  {
    const vm = require('vm');
    const HTML = read('src/renderer/index.html');
    const grab = (sig) => { const m = new RegExp('function ' + sig + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}').exec(HTML); return m ? m[0] : ''; };
    const consts = ['MODEL_DATE_TAIL', 'EFFORT_ORDER'].map((k) => (new RegExp('const ' + k + ' = [^;]*;').exec(HTML) || [''])[0]).join('\n');
    const src = [consts, ...['stepSummary', 'describeModel', 'browseModelIds', 'reasoningKeys', 'nearestKey', 'reasoningDefault', 'resolveReasoning', 'contextWarning', 'per1M'].map(grab)].join('\n');
    const ctx = { module: {} };
    vm.createContext(ctx);
    let loaded = true;
    try { new vm.Script(src + '\nmodule.exports = { stepSummary, describeModel, browseModelIds, reasoningKeys, resolveReasoning, contextWarning, per1M };').runInContext(ctx); }
    catch (e) { loaded = false; check('renderer helpers load', false, e.message); }
    if (loaded) {
      const R = ctx.module.exports;
      let sm = R.stepSummary({ READ: 6, CMD: 3 }, {});
      check('reading and commands: "Ran 3 commands · 6 files read"', sm.head === 'Ran 3 commands' && sm.meta.join(' · ') === '6 files read', sm);
      sm = R.stepSummary({ WRITE: 3, EDIT: 1, CMD: 1 }, { verdict: '9 passed' });
      check('changes lead the step', sm.head === 'Changed 4 files' && sm.meta.join(' · ') === '1 command · 9 passed', sm);
      sm = R.stepSummary({ READ: 2, GREP: 1 }, {});
      check('only reading is exploring', sm.head === 'Explored the project', sm);
      check('a denied request is not a command that ran', R.stepSummary({}, { denied: 1 }).head === 'You denied a request', R.stepSummary({}, { denied: 1 }));
      check('shell counts as commands (it was never counted)', R.stepSummary({ SHELL: 2 }, {}).head === 'Ran 2 commands', R.stepSummary({ SHELL: 2 }, {}));

      const d = R.describeModel({ id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek: DeepSeek V4 Flash Latest' });
      check('plain name, provider apart', d.name === 'DeepSeek V4 Flash' && d.provider === 'DeepSeek', d);
      check('free is read from the name', R.describeModel({ id: 'x/y:free', name: 'X: Y (free)' }).free === true, 'missed');
      const ids = R.browseModelIds([
        { id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek: DeepSeek V4 Flash Latest' },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash' },
        { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' },
        { id: 'deepseek/deepseek-v4-flash:nitro', name: 'DeepSeek: DeepSeek V4 Flash (nitro)' },
        { id: 'x/y', name: 'X: Y' }, { id: 'x/y:free', name: 'X: Y (free)' },
      ]);
      check('one row per model: the one that follows updates', [...ids].sort().join(',') === ['~deepseek/deepseek-v4-flash-latest', 'x/y', 'x/y:free'].sort().join(','), [...ids]);

      const dsv4 = { supported_efforts: ['max', 'high', 'low'], default_effort: 'high', default_enabled: true, mandatory: false };
      check('menu rows come from the catalogue', R.reasoningKeys(dsv4).join(',') === 'none,low,high,max', R.reasoningKeys(dsv4));
      check('the tick starts on the model default', R.resolveReasoning('default', dsv4) === 'high', R.resolveReasoning('default', dsv4));
      check('a choice carries to the nearest level', R.resolveReasoning('medium', dsv4) === 'high' && R.resolveReasoning('xhigh', dsv4) === 'max', [R.resolveReasoning('medium', dsv4), R.resolveReasoning('xhigh', dsv4)]);
      check('on/off models offer Off and On', R.reasoningKeys({ supported_efforts: [], mandatory: false }).join(',') === 'none,on', 'wrong rows');
      check('a model that always thinks offers nothing to pick', R.reasoningKeys({ supported_efforts: [], mandatory: true }).length === 0, 'rows');

      check('no heads-up while there is room', R.contextWarning({ tokens: 100000, limit: 200000, threshold: 0.8 }) === '', 'warned early');
      check('a heads-up within ten points', /72% full .* summarised at 80%/.test(R.contextWarning({ tokens: 144000, limit: 200000, threshold: 0.8 })), R.contextWarning({ tokens: 144000, limit: 200000, threshold: 0.8 }));
      check('past the line it says next message', /with your next message/.test(R.contextWarning({ tokens: 170000, limit: 200000, threshold: 0.8 })), 'wrong');
      check('prices per 1M read like the concept', R.per1M(0.00000003 * 100) === '$0.03' && R.per1M(0.00000032 * 100) === '$0.32' && R.per1M(0.000004 * 100) === '$4' && R.per1M(0.0000025 * 100) === '$2.50' && R.per1M(0.000003 * 100) === '$3', [R.per1M(0.000003), R.per1M(0.000032), R.per1M(0.0004), R.per1M(0.00025), R.per1M(0.0003)]);
    }

    check('the approval lives in the box', /<div class="box" id="cmpBox">[\s\S]*id="askBox"[\s\S]*id="cmpEdit"/.test(HTML) && !HTML.includes('id="permBar"'), 'strip above the box');
    check('the approval belongs to the session that asked', /onAgentPermission\(\(\{ permId, sessionId,/.test(HTML), 'shown on any session');
    check('the queue is in the box, one set of rows', HTML.includes('id="qrows"') && !HTML.includes("insertBefore(qb, box)"), 'per-view trays');
    check('the meter reads the context event', HTML.includes("event.type === 'context'") && HTML.includes('function paintMeter()'), 'no meter');
    check('Plan is a switch', /id="chipPlan"[^>]*role="switch"/.test(HTML), 'dropdown');
    check('no promise of slash commands that do not exist', !HTML.includes('/ commands') && !HTML.includes('type / for'), 'still promised');
    check('reopened sessions draw steps', /m\.role === 'assistant'\) \{[\s\S]{0,1400}addToolRow\(fn\.name \|\| 'tool', args, true\)/.test(HTML), 'text only');
  }

  // ------------------------------------------------------------------ [CD]
  console.log('\n[CD] sub-agents do not show up as sessions of their own');
  {
    const store = require(path.join(ROOT, 'src/backend/sessions.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-subs-'));
    const parent = store.createSession({ workdir: WD, model: 'm', title: 'Build the thing' });
    await store.saveSession(UD, parent);
    const worker = store.createSession({ workdir: WD, model: 'm', title: 'subagent:explore', parentId: parent.id });
    await store.saveSession(UD, worker);
    // Saved before parentId existed: only the title says what it is.
    const legacy = store.createSession({ workdir: WD, model: 'm', title: 'subagent:review' });
    await store.saveSession(UD, legacy);
    const listed = await store.listSessions(UD);
    check('the conversation is listed, its workers are not', listed.length === 1 && listed[0].id === parent.id, listed.map((s) => s.title));
    const subs = await store.listSessions(UD, 50, { subs: true });
    check('workers are still there to resume', subs.length === 2, subs.map((s) => s.title));
    const back = await store.loadSession(UD, worker.id);
    check('a worker remembers its conversation', back.parentId === parent.id, back.parentId);
    const SPAWN = read('src/backend/tools/spawn.js');
    check('spawned workers are given their parent', /title: `subagent:\$\{roleName\}`,\s*parentId: agentOpts\.sessionId/.test(SPAWN) && read('src/backend/agent.js').includes('sessionId: session.id,'), 'no parent');
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}

    const HTML = read('src/renderer/index.html');
    check('project groups open in place, eased', /\.proj\.open \.proj-b\{grid-template-rows:1fr\}/.test(HTML) && /g\.classList\.toggle\('open', now\)/.test(HTML), 'rebuilds on toggle');
    check('the session search is wired', HTML.includes("$('q').addEventListener('input', renderSessionList)"), 'search does nothing');
    check('menus fit the room above their chip', HTML.includes("m.style.maxHeight = Math.max(160, r.top - 16) + 'px'"), 'can run off the top');
  }

  // ------------------------------------------------------------------ [CE]
  console.log('\n[CE] the app carries its own icon');
  {
    const PKG = JSON.parse(read('package.json'));
    check('the build uses the VoxAI icon', PKG.build && PKG.build.win && PKG.build.win.icon === 'resources/icon.ico', PKG.build && PKG.build.win);
    const ico = fs.readFileSync(path.join(ROOT, 'resources/icon.ico'));
    const n = ico.readUInt16LE(4);
    const sizes = [...Array(n)].map((_, i) => ico.readUInt8(6 + i * 16) || 256);
    check('the .ico holds 16 to 256 px', ico.readUInt16LE(2) === 1 && sizes.includes(16) && sizes.includes(256), sizes);
    check('the window shows it too (taskbar from npm start)', /icon: path\.join\(__dirname, '\.\.', '\.\.', 'resources'/.test(read('src/main/main.js')), 'no window icon');
  }

  // ------------------------------------------------------------------ [CF]
  console.log('\n[CF] found by driving the app: approvals, Stop and the queue');
  {
    const HTML = read('src/renderer/index.html');
    // Typing a follow-up as an approval appeared: the text vanished and Enter approved.
    check('focus goes to the request, not the Allow button', HTML.includes('if (!ask.hidden) ask.focus();') && !HTML.includes("$('askAllow'); if (b && !ask.hidden) b.focus()"), 'Allow focused');
    check('Enter waits until the request has settled and typing has stopped', /now - \(p\.shownAt \|\| 0\) < ASK_SETTLE_MS \|\| \(p\.typedAt && now - p\.typedAt < ASK_AFTER_TYPING_MS\)/.test(HTML), 'Enter approves at once');
    check('typing during a request is kept as the draft', /if \(e\.key\.length === 1\) \{ e\.preventDefault\(\); pr\.value \+= e\.key;/.test(HTML), 'typing lost');
    // The rows moved under the pointer as the note changed height.
    check('the menu note holds one height', HTML.includes("note.style.minHeight = tallest ? tallest + 'px' : '';"), 'rows jump');
    // A run with a queue could not be stopped; Stop then sent the queue.
    check('the button stops a run that has a queue', /if \(busy && !hasText\) \{\s*btn\.classList\.add\('stop'\)/.test(HTML), 'Send while queued');
    check('after Stop the queue waits', HTML.includes('if (v && v.stopRequested && !byHand)') && HTML.includes('v.stopRequested = true;'), 'Stop sends the queue');
    check('an empty box sends the next queued message', HTML.includes('if (!text && !v.busy && v.queue && v.queue.length) { drainQueue(v.id, true); return; }'), 'dead Send');
    check('Stop reads as stopped, not an error', HTML.includes("el('div', 'fold', 'stopped')"), 'shown as Error');

    // The agent: a Stop mid-request is "cancelled", not "error: This operation was aborted".
    fakeOpenRouter(() => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; });
    const ctl = new AbortController(); ctl.abort();
    const ev = await drain(runAgent({ session: { id: 'cf', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2, signal: ctl.signal }));
    const last = ev[ev.length - 1] || {};
    check('an aborted request ends as cancelled', last.type === 'cancelled', last);
  }

  // ------------------------------------------------------------------ [CG]
  console.log('\n[CG] a resumed sub-agent keeps its role');
  {
    const store = require(path.join(ROOT, 'src/backend/sessions.js'));
    const { makeSpawnTool } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-resume-'));
    const reviewer = store.createSession({ workdir: WD, model: 'm', title: 'subagent:review', parentId: 'p1' });
    await store.saveSession(UD, reviewer);
    let got = null;
    const runner = (opts) => { got = opts; return (async function* () { yield { type: 'done', content: 'ok' }; })(); };
    const tool = makeSpawnTool({ runner, agentOpts: { workdir: WD, sessionId: 'p1', model: 'm', access: 'full' }, userData: UD, emit: () => {} });
    await tool.run('spawn_agent', { resume: reviewer.id, task: 'wrap up now' }, { workdir: WD, session: { id: 'p1' } });
    check('resumed without a role, a reviewer stays a reviewer', got && got.access === 'ask', got && got.access);
    check('and still cannot write or run commands', got && Array.isArray(got.allowTools) && !got.allowTools.includes('write') && !got.allowTools.includes('shell'), got && got.allowTools);
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}

    // The sub-agent approval is readable: its role and task, not cut-off JSON.
    fakeOpenRouter((n) => (n === 1 ? call('s1', 'spawn_agent', { role: 'review', task: 'Look at todo.js for bugs in the done command.' }) : say('done')));
    const asked = [];
    await drain(runAgent({ session: { id: 'cg', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'test', askPermission: async (q) => { asked.push(q); return false; }, maxTurns: 3 }));
    check('the sub-agent request reads as role: task', asked[0] && asked[0].target === 'review: Look at todo.js for bugs in the done command.', asked[0]);
  }

  // ------------------------------------------------------------------ [CH]
  console.log('\n[CH] the thread: following new output, the plan, running steps');
  {
    const HTML = read('src/renderer/index.html');
    check('no forced scroll-into-view left in the thread', (HTML.match(/scrollIntoView\(\{\s*block:\s*'end'/g) || []).length === 0, 'still forcing');
    check('scrolling up lets go; the bottom re-attaches', HTML.includes('THREAD_STICK = threadAtBottom(sc);') && /deltaY < 0\) \{ THREAD_JUMPING = false; if \(THREAD_STICK\)/.test(HTML), 'always follows');
    check('growth is watched on each session\'s content, not the fixed #thread frame', HTML.includes('THREAD_RO.observe(v.root)') && !/new ResizeObserver\([^)]*\)\.observe\(th\)/.test(HTML), 'watches a frame that never resizes');
    check('Jump to latest lights up when output grows below', HTML.includes('else if (grew) { THREAD_UNSEEN = true; paintJump(); }'), 'no signal');
    // The plan: pinned to the message box (always in view), Codex-style, not in the thread.
    check('the plan is a tab on the box edge with a drawer (design B)', /<div class="plan-tab" id="planTab" hidden>\s*<div class="pt-drawer" id="planList"/.test(HTML) && HTML.includes('function paintPlanTray()') && !HTML.includes("'todos:\\n'"), 'not the pull tab');
    check('the plan is not drawn into the thread', !/v\.todosEl = el\('div', 'plan'\)/.test(HTML), 'still in the thread');
    const TOOLS = read('src/backend/tools/index.js');
    check('the plan tool tells the model to keep it moving', /call it again with the whole list each time a step/.test(TOOLS) && /active: \{ type: 'number'/.test(TOOLS), 'written once, never ticked');
    // An image and a model that cannot see it: said on the shelf, with a fix; Send keeps it.
    check('a text-only model with an image is flagged before Send', HTML.includes('function imageProblem()') && HTML.includes("can\\u2019t see images.") && HTML.includes('if (parts.length && imageProblem())'), 'refused after Send');
    check('a refused send is not drawn as sent', HTML.includes('try { if (bubble) bubble.remove(); } catch {}'), 'bubble left behind');
    check('the plan tool row reads as a plan', HTML.includes("return items ? 'plan \\u00b7 ' + items.length"), 'raw JSON');
    check('a running step keeps its clock going', HTML.includes('const end = card.running ? Date.now() : (card.t1 || 0);'), 'frozen');
    check('after an approval the shelf says what is running again', HTML.includes("setActivity(v, allowed ? (p.kind === 'spawn_agent'"), 'stuck on Waiting for you');
    check('Stop is a soft red button', HTML.includes('.send.stop{background:rgba(207,122,102,.12)'), 'gold with a red square');
  }

  // ------------------------------------------------------------------ [CI]
  console.log('\n[CI] an earlier image does not lock a session to vision models');
  {
    let body = null;
    global.fetch = async (_u, opts) => {
      body = JSON.parse(opts.body);
      const enc = new TextEncoder();
      return { ok: true, text: async () => '', body: new ReadableStream({ start(c) { for (const ch of say('ok')) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }) };
    };
    const session = { id: 'ci', workdir: WD, messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
      { role: 'assistant', content: 'A gold chevron.' },
    ] };
    await drain(runAgent({ session, userText: 'now add a clear command', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2, modelVision: false }));
    const sent = JSON.stringify(body && body.messages);
    check('a text-only model is sent no image', body && !sent.includes('image_url'), 'image sent');
    check('it is told one was there', /an image was attached here/.test(sent), 'silently dropped');
    check('the saved history keeps the image', JSON.stringify(session.messages[0]).includes('image_url'), 'history rewritten');
  }

  // ------------------------------------------------------------------ [CJ]
  console.log('\n[CJ] Auto mode: a safety check instead of a prompt');
  {
    // Streamed requests are the agent's turns; the one plain request per action is the check.
    const autoRun = async (verdicts, calls) => {
      let turn = 0, checks = 0;
      global.fetch = async (_u, opts) => {
        const body = JSON.parse(opts.body);
        const enc = new TextEncoder();
        if (!body.stream) {
          const v = verdicts[Math.min(checks, verdicts.length - 1)]; checks++;
          return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.00001 } }) };
        }
        turn++;
        const chunks = turn <= calls ? call('a' + turn, 'shell', { command: 'node -e console.log(' + (500 + turn) + ')' }) : say('done');
        return { ok: true, text: async () => '', body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }) };
      };
      const asked = [];
      const ev = await drain(runAgent({ session: { id: 'cj', workdir: WD, messages: [] }, userText: 'run it', apiKey: 'k', model: 'm', access: 'auto', askPermission: async (q) => { asked.push(q); return true; }, maxTurns: calls + 2 }));
      return { asked, checks, ends: ev.filter((e) => e.type === 'tool_end'), usage: ev.filter((e) => e.type === 'usage' && e.usage.source === 'auto-check') };
    };
    let r = await autoRun([{ decision: 'allow', reason: 'runs a script the user asked for' }], 1);
    check('allowed by the check: it runs, nobody is asked', r.asked.length === 0 && r.ends[0] && r.ends[0].ok === true, r);
    check('the check is paid for and counted', r.usage.length === 1 && r.usage[0].usage.cost > 0, r.usage);
    // Auto never blocks by itself: whatever the check is unsure of comes to you.
    r = await autoRun([{ decision: 'ask', reason: 'this deletes data you did not ask to delete' }], 1);
    check('unsure: you are asked, with the reason', r.asked.length === 1 && /Auto mode wants your say: this deletes data/.test(r.asked[0].note), r.asked);
    check('and when you allow it, it runs', r.ends[0] && r.ends[0].ok === true, r.ends[0]);
    r = await autoRun([{ decision: 'block', reason: 'too risky' }], 3);
    check('nothing is ever blocked without asking you', r.asked.length === 3 && r.ends.every((e) => e.ok === true) && !r.ends.some((e) => /blocked/.test(String(e.result))), r.asked.length);
    r = await autoRun([{ nonsense: true }], 1);
    check('no clear answer from the check: the user decides', r.asked.length === 1 && /could not check/.test(r.asked[0].note), r.asked);

    const HTML = read('src/renderer/index.html');
    check('Auto is in the Permissions menu', /const ACCESS = \['ask','edit','test','auto','full'\]/.test(HTML) && /auto:'Auto'/.test(HTML), 'missing');
    const SB = require(path.join(ROOT, 'src/backend/tools/sandbox.js'));
    check('Auto is its own level, allowing what Edit and test allows', SB.normalizeAccess('auto') === 'auto' && SB.checkToolAllowed('write', 'auto').allowed === true && SB.checkToolAllowed('shell', 'auto').needsPermission === true, 'wrong level');
  }

  // ------------------------------------------------------------------ [CK]
  console.log('\n[CK] the picker offers only models that can code');
  {
    const MAIN = read('src/main/main.js');
    check('text out and tool calls, or not in the picker', /coding: params\.has\('tools'\) && [\s\S]{0,200}output_modalities\[0\] === 'text'/.test(MAIN) && MAIN.includes('models: models.filter((m) => m.coding)'), 'every model offered');
  }

  // ------------------------------------------------------------------ [CL]
  console.log('\n[CL] the plan keeps moving; the agent\'s questions reach the screen');
  {
    // A plan, then several actions with no update: the model is reminded, once.
    const seq = [call('p0', 'todo', { items: ['one', 'two', 'three'], active: 0 })];
    for (let i = 1; i <= 5; i++) seq.push(call('r' + i, 'glob', { pattern: '*' + i }));
    let bodies = [];
    fakeOpenRouter((n, body) => { bodies.push(body); return seq[n - 1] || say('done'); });
    const sess = { id: 'cl', workdir: WD, messages: [] };
    await drain(runAgent({ session: sess, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 10 }));
    const toolMsgs = sess.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    const nudged = toolMsgs.filter((t) => t.includes('[plan check]'));
    check('an untouched plan earns one reminder', nudged.length === 1, nudged.length);
    check('the reminder comes after four actions', toolMsgs[4] && toolMsgs[4].includes('[plan check]'), toolMsgs.map((t) => t.includes('[plan check]')));

    const MAIN = read('src/main/main.js');
    check('questions go out on the channel the thread listens to', /c1\.send\('agent:event', \{ sessionId, runKey, event: \{ type: 'user_input'/.test(MAIN) && !MAIN.includes("c1.send('agent:user_input'"), 'unheard channel');
    const HTML = read('src/renderer/index.html');
    check('an answered question stays as one line with the answer', HTML.includes("line.lastChild.textContent = label ? 'You chose: ' + label : 'No answer';"), 'vanishes');
  }

  // ------------------------------------------------------------------ [CM]
  console.log('\n[CM] screenshots count as images, not as their base64');
  {
    const { estimateSessionTokens } = require(path.join(ROOT, 'src/backend/compact.js'));
    const shot = 'data:image/png;base64,' + 'A'.repeat(400000);   // ~400 KB, a real screenshot's size
    const sess = { messages: [
      { role: 'user', content: 'make a game' },
      { role: 'user', content: [{ type: 'text', text: '[VOX TOOL SCREENSHOTS] computer' }, { type: 'image_url', image_url: { url: shot } }] },
    ] };
    const t = estimateSessionTokens(sess, '');
    check('one screenshot is about a thousand tokens, not a hundred thousand', t > 1000 && t < 2000, t);
  }

  // ------------------------------------------------------------------ [CN]
  console.log('\n[CN] commands reach the shell as written');
  {
    const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
    const ctx = { workdir: WD, session: { id: 'cn', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (wd, p) => path.resolve(wd, p), checkPermission: async () => {} };
    const sh = buildTools(ctx).ALL.find((t) => t.def.function.name === 'shell');
    const exit3 = await sh.run({ command: 'node -e "process.exit(3)"' }, ctx);
    check('a quoted command keeps its exit code', exit3.exit === 3, exit3);
    const hi = await sh.run({ command: 'node -e "console.log(\'hi there\')"' }, ctx);
    check('quotes inside a command survive', hi.exit === 0 && hi.stdout.trim() === 'hi there', hi);
  }

  // ------------------------------------------------------------------ [CO]
  console.log('\n[CO] a step\'s actions: quiet rows, opened only by the reader');
  {
    const HTML = read('src/renderer/index.html');
    const src = /function lineDiff\(before, after\)\{[\s\S]*?\n\}/.exec(HTML);
    const lineDiff = src && new vm.Script('(' + src[0] + ')').runInNewContext({});
    const d = lineDiff ? lineDiff('a\nb\nc', 'a\nB\nc\nd') : [];
    const ops = d.map((x) => x[0]).join('');
    check('an edit becomes a line diff', ops === ' -+ +', ops);
    check('rows are drawn closed', /const out = el\('div', 'tr-card'\); out\.hidden = true;/.test(HTML), 'open');
    check('a result never opens its row', !/setToolResult[\s\S]{0,1600}classList\.toggle\('open', !ok\)/.test(HTML) && !/out\.hidden = false/.test(HTML), 'opens itself');
    check('a finished step closes, failures too', HTML.includes('if (card.running === false && card.setOpen) card.setOpen(false);'), 'failed step stays open');
    check('the row answers the real record, not a copy', HTML.includes('v.latestTool = rec || null;'), 'copy');
    const sumSrc = /function stepSummary\(counts, stats\)\{[\s\S]*?\n\}/.exec(HTML);
    const stepSummary = sumSrc && new vm.Script('(' + sumSrc[0] + ')').runInNewContext({});
    const sm = stepSummary({ EDIT: 5, READ: 2, SHELL: 1 }, { files: new Set(['notes.js', 'test.js']), errors: 2, verdict: '19 passed', failed: 0 });
    check('a step counts the files it changed, not its edit calls', sm.head === 'Changed 2 files', sm.head);
    check('an edit that errored is not a failing test', sm.failed === 0 && sm.errors === 2, sm);
    const tvSrc = /function testVerdict\(text\)\{[\s\S]*?\n\}/.exec(HTML);
    const testVerdict = tvSrc && new vm.Script('(' + tvSrc[0] + ')').runInNewContext({});
    const v = (s) => JSON.stringify(testVerdict(s));
    check('test counts from every common runner', v('24 tests passed.') === '{"passed":24,"failed":0}'
      && v('==== 9 passed, 1 failed in 0.5s ====') === '{"passed":9,"failed":1}'
      && v('  9 passing (12ms)\n  1 failing') === '{"passed":9,"failed":1}'
      && v('# tests 5\n# pass 5\n# fail 0') === '{"passed":5,"failed":0}'
      && v('Build finished') === 'null', [v('24 tests passed.'), v('  9 passing (12ms)\n  1 failing'), v('# pass 5\n# fail 0')]);
    check('an unfinished plan after the run reads as the last plan', HTML.includes('const stale = !complete && !(v.busy && v.planLive);') && HTML.includes("'<b>Last plan</b>'") && HTML.includes('if (v && v._planBusy !== busy) { v._planBusy = busy; paintPlanTray(); }'), 'looks live');
    check('every tool has a verb', ['search', 'agents', 'sandbox_status', 'artifact_publish'].every((t) => HTML.includes("case '" + t + "'")), 'missing');
  }

  // ------------------------------------------------------------------ [CQ]
  console.log('\n[CQ] questions come with buttons, and their row takes the answer');
  {
    const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
    let asked = null;
    const ctx = { workdir: WD, session: { id: 'cq', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (wd, p) => path.resolve(wd, p), checkPermission: async () => {}, userInput: async (q) => { asked = q; return { answer: 'kg <-> lb' }; } };
    const ask = buildTools(ctx).ALL.find((t) => t.def.function.name === 'ask_user');
    const schema = ask.def.function.parameters.properties.options;
    check('options are plain strings to the model', schema.items.type === 'string', schema.items);
    await ask.run({ question: 'Which next?', options: ['inches <-> cm', 'kg <-> lb'] }, ctx);
    check('each string becomes a button', JSON.stringify(asked.options) === JSON.stringify([{ label: 'inches <-> cm', value: 'inches <-> cm' }, { label: 'kg <-> lb', value: 'kg <-> lb' }]), asked.options);
    await ask.run({ question: 'Which next?', options: [{ label: 'A', value: 'a' }] }, ctx);
    check('the older {label, value} form still works', JSON.stringify(asked.options) === JSON.stringify([{ label: 'A', value: 'a' }]), asked.options);
    const HTML = read('src/renderer/index.html');
    check('a question closing the step keeps its row', HTML.includes('if (!(v.latestTool && v.latestTool.ok === null)) v.latestTool = null;'), 'row stuck on Asking');
    check('the row shows the answer', /if \(rec\.name === 'ask_user' \|\| rec\.name === 'ask_confirm'\) \{/.test(HTML), 'no answer');
  }

  // ------------------------------------------------------------------ [CR]
  console.log('\n[CR] plan mode holds changes back before anyone is asked');
  {
    const asked = [];
    fakeOpenRouter((n) => (n === 1 ? call('p1', 'write', { path: 'plan.txt', content: 'x' }) : n === 2 ? call('p2', 'shell', { command: 'dir /b' }) : say('done')));
    const ev = await drain(runAgent({ session: { id: 'cr', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'ask', planMode: true, askPermission: async (q) => { asked.push(q); return true; }, maxTurns: 4 }));
    const w = ev.find((e) => e.type === 'tool_end' && e.name === 'write');
    const d = ev.find((e) => e.type === 'tool_end' && e.name === 'shell');
    check('a write before the plan is approved is held, not put to the user', w && /^PLAN MODE:/.test(String(w.result)) && !asked.some((q) => q.kind === 'write-file') && !fs.existsSync(path.join(WD, 'plan.txt')), { asked, w });
    check('its row starts like any other', ev.some((e) => e.type === 'tool_start' && e.name === 'write'), 'no row');
    check('looking around is allowed while planning', d && d.ok === true && !/PLAN MODE/.test(String(d.result)), d);
    const HTML = read('src/renderer/index.html');
    check('a held change reads as waiting, not failed', HTML.includes("if (rec.planHeld) return { html: 'waits for plan approval' };"), 'red failure');
    check('what did not happen gets the plain verb', HTML.includes("'Deleted': 'Delete'") && HTML.includes('verbFor(look, first)'), 'Deleted … denied');
    check('Always says it covers this file or command', HTML.includes("'write-file': 'Always for this file', shell: 'Always for this command'") && !HTML.includes('Always in this session'), 'reads as everything');
    check('no arguments, no "{}" chip', HTML.includes("return t && t !== '{}' ?"), '{}');
    const sumSrc2 = /function stepSummary\(counts, stats\)\{[\s\S]*?\n\}/.exec(HTML);
    const stepSummary2 = new vm.Script('(' + sumSrc2[0] + ')').runInNewContext({});
    check('checking a file is not changing one', stepSummary2({ FS: 1, ASK: 1 }, {}).head !== 'Changed 1 file', stepSummary2({ FS: 1, ASK: 1 }, {}).head);
  }

  // ------------------------------------------------------------------ [CS]
  console.log('\n[CS] a page to preview is a row, and project paths read as project paths');
  {
    const HTML = read('src/renderer/index.html');
    check('the offer is a quiet row with Open and Always', HTML.includes("const row = el('div', 'toolrow pv-row can-open');") && HTML.includes("el('button', 'pv-btn', 'Open')") && !HTML.includes("el('div', 'md preview-offer')"), 'old box');
    check('an offer still waiting stays in sight when its step folds', HTML.includes("card.body.querySelectorAll(':scope > .pv-row:not(.opened)').forEach((r) => { after.after(r); after = r; });"), 'hidden in a closed step');
    check('the preview always gets the session\'s folder', HTML.includes('function viewDir(v){ return (v && (v.workdir || v._workdir)) || \'\'; }') && HTML.includes('window.voxai.preview.openFile(event.url, viewDir(v), !!always)') && HTML.includes('const wd = viewDir(actView());') && !HTML.includes("preview.openFile(event.url, v.workdir || ''"), 'global folder after a reload');
    check('the row says Opened only once it has', HTML.includes("if (!r || !r.ok) { row._opened(false); meta.textContent = 'could not open';"), 'claims success');
    check('a page already in the preview is not offered again', HTML.includes("if (st && st.open && samePreviewUrl(st.url, event.url)) row._opened(true);") && HTML.includes('window.voxai.preview.onState(markPreviewRows);'), 'offers an open page');
    const src = /function tidyPaths\(t\)\{[\s\S]*?\n\}/.exec(HTML)[0];
    const WD = 'C:\\Users\\me\\proj';
    const tidy = new Function('RT', 'viewDir', 'let TIDY = { wd: null, re: null };\n' + src + '\nreturn tidyPaths;')(() => ({ workdir: WD }), (v) => (v && (v.workdir || v._workdir)) || '');
    check('a file:/// address in the project reads as its name', tidy('opened file:///C:/Users/me/proj/web/hello.html') === 'opened web/hello.html', tidy('opened file:///C:/Users/me/proj/web/hello.html'));
    check('so does a Windows path, in any case', tidy('edited c:\\users\\me\\proj\\units.js') === 'edited units.js', tidy('edited c:\\users\\me\\proj\\units.js'));
    check('paths outside the project stay whole', tidy('see C:\\Windows\\notepad.exe') === 'see C:\\Windows\\notepad.exe', 'changed');
    check('paths are tidied for the session being drawn, not the one on screen', HTML.includes('const v = RT(); const wd = viewDir(v);'), 'wrong session on reopen');
    check('the preview title names a project page by its project path', HTML.includes('label = relPath(p, viewDir(actView()));'), 'C:/Users/...');
    check('the agent is told to name files by project path', read('src/backend/agent.js').includes('use its path relative to the project folder'), 'not told');
  }

  // ------------------------------------------------------------------ [CT]
  console.log('\n[CT] the menu works; the last old boxes are rows');
  {
    const MAIN = read('src/main/main.js');
    const relayDef = MAIN.indexOf('function relay(ch)'), createWin = MAIN.indexOf('function createWindow()');
    check('the File menu can reach relay (Ctrl+N, Ctrl+O)', relayDef > 0 && relayDef < createWin && !MAIN.includes('const relay = (ch)'), 'relay out of scope');
    check('About shows the real version', MAIN.includes("message: 'VoxAI Coder ' + app.getVersion()") && !MAIN.includes("'VoxAI Coder v0.1.0'"), 'v0.1.0');
    const HTML = read('src/renderer/index.html');
    check('a fetched page opens from its row', HTML.includes("if (rec) { rec.display = d;") && HTML.includes("if (rec.name === 'web_fetch' && rec.display) {"), 'separate box');
    check('a published artifact opens from its row', HTML.includes("if (rec) { rec.artifact = a;") && HTML.includes("if (rec.name === 'artifact_publish' && rec.artifact) {"), 'separate box');
    check('a background agent finishing is a quiet row', HTML.includes("icon: 'people', verb: 'Background agent finished'") && !HTML.includes("'background agent finished ('"), 'old line');
    check('no old gold-edged boxes are left in the thread', !/border-left:3px solid var\(--gold\);border-radius:0 6px 6px 0;padding:9px 12px/.test(HTML), 'still there');
    const ss3 = new vm.Script('(' + /function stepSummary\(counts, stats\)\{[\s\S]*?\n\}/.exec(HTML)[0] + ')').runInNewContext({});
    check('fetching a page is not "Searched the web"', ss3({ WEB: 1, MEMORY: 1 }, {}).head === 'Read a web page' && ss3({ FIND: 1 }, {}).head === 'Searched the web', [ss3({ WEB: 1 }, {}).head, ss3({ FIND: 1 }, {}).head]);
    check('the changes strip is re-read when a run finishes', HTML.includes("refreshSessionList(); refreshUsage(); if (sid === activeId) refreshCtx();"), 'stale after a run');
    check('and soon after each file change', HTML.includes('v.ctxTimer = setTimeout(refreshCtx, 700);'), 'stale during a run');
    check('the strip asks about the session\'s own folder', HTML.includes('const r = await window.voxai.workspaceContext(wd);'), 'empty after a reload');
    check('the spend limit is a notice with Continue and Change the limit', HTML.includes("title: 'Stopped at the spend limit'") && HTML.includes("{ label: 'Change the limit', ghost: true, onClick: () => openModal('spend') }"), 'old box');
    check('the turn limit is a notice with Continue', HTML.includes("title: ev.turns ? 'Paused after ' + ev.turns + ' turns' : 'Paused'"), 'old box');
    check('an error is a notice, not "Error: …" as text', HTML.includes(": 'Something went wrong', text: tidyPaths(msg)") && !HTML.includes("addMsg('Error: ' + event.message)"), 'bare text');
    check('a message that could not be sent is a notice, and says it is back in the box', HTML.includes("title: 'Couldn’t send that', text: tidyPaths(reason) + ' Your message is back in the box.'") && !HTML.includes("addMsg('Error: ' + reason, true)"), 'bare Error: text');
    check('a tiny spend limit is not shown as $0.00', HTML.includes('money(ev.budget, Number(ev.budget) < 0.01 ? 5 : 2)'), '$0.00');
    check('Settings shows the real version', HTML.includes('<span id="setVersion">') && !HTML.includes('VoxAI Coder 0.1</div>'), '0.1');
    const MAIN3 = read('src/main/main.js');
    check('usage history finds its rows in any of the shapes the endpoint returns', MAIN3.includes('const list = [d, d && d.rows, d && d.data, d && d.results, body && body.rows, body && body.results].find(Array.isArray);') && !MAIN3.includes('(body && body.data && body.data) || []'), '.map is not a function');
    check('usage lists the biggest spend first', MAIN3.includes('rows.sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));'), 'arrival order');
    check('the usage window opens above Settings', HTML.includes('#usageModalBg{z-index:60}'), 'hidden under Settings');
    check('a queued message goes out with its steering', HTML.includes("const text = next.steer ? next.text + '\\n\\n' + next.steer : next.text;\n  doSend(v, text, next.parts || []);"), 'steering dropped');
    check('memory rows read as words', HTML.includes("if (act === 'add') return pick('list', 'Remembered', 'Remembering');"), 'Memory · add (2)');
  }

  // ------------------------------------------------------------------ [CU]
  console.log('\n[CU] a snapshot puts files back');
  {
    const snapMod = require(path.join(ROOT, 'src/backend/tools/snapshot.js'));
    const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-snap-'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-snapud-'));
    fs.writeFileSync(path.join(PROJ, 'notes.md'), 'First line.\n');
    fs.mkdirSync(path.join(PROJ, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(PROJ, 'node_modules', 'x', 'big.js'), 'skip me');
    const asked = [];
    const tool = snapMod.makeSnapshotTool({ userData: UD });
    const ctx = { session: { id: 'cu', workdir: PROJ }, checkPermission: async (kind, target) => { asked.push(kind + ' ' + target); return true; } };
    const made = await tool.run({ action: 'create' }, ctx);
    check('create saves the project\'s files by itself, not node_modules', made.files === 1, made);
    fs.writeFileSync(path.join(PROJ, 'notes.md'), 'First line.\nTemporary line.\n');
    fs.writeFileSync(path.join(PROJ, 'new.txt'), 'made later');
    const back = await tool.run({ action: 'restore', id: made.id }, ctx);
    check('restore puts the file back', fs.readFileSync(path.join(PROJ, 'notes.md'), 'utf8') === 'First line.\n' && back.restored.join() === 'notes.md', back);
    check('files made since are left in place', fs.existsSync(path.join(PROJ, 'new.txt')), 'deleted');
    check('restoring asks like any change', asked.length === 1 && asked[0].startsWith('write-file'), asked);
    const outside = await snapMod.createSnapshot({ userData: UD, session: { id: 'cu', workdir: PROJ }, files: ['../escape.txt'] });
    check('paths outside the project are not saved', outside.files === 0 && outside.skipped === 1, outside);
    check('plan mode treats a restore as a change', read('src/backend/agent.js').includes("snapshot: ['restore']"), 'restores while planning');
    const HTML = read('src/renderer/index.html');
    check('snapshot and worktree rows read as words', HTML.includes("return pick('file', 'Restored a snapshot', 'Restoring a snapshot');") && HTML.includes("create: ['Created worktree', 'Creating worktree']"), 'Snapshot · create');
    try { fs.rmSync(PROJ, { recursive: true, force: true }); fs.rmSync(UD, { recursive: true, force: true }); } catch {}
  }

  // ------------------------------------------------------------------ [CV]
  console.log('\n[CV] a run that stopped says so when the session is reopened');
  {
    const store = require(path.join(ROOT, 'src/backend/sessions.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-stops-'));
    const sess = store.createSession({ workdir: WD, model: 'm', title: 'stops' });
    sess.messages.push({ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'x' });
    sess.stops = [{ at: 3, type: 'limit_reached', turns: 2 }];
    await store.saveSession(UD, sess);
    const back = await store.loadSession(UD, sess.id);
    check('stops are saved and loaded with the session', Array.isArray(back.stops) && back.stops.length === 1 && back.stops[0].type === 'limit_reached' && back.stops[0].at === 3, back.stops);
    check('and exported with it', store.exportSession(back).includes('"kind":"stop"'), 'missing');
    const MAIN = read('src/main/main.js');
    check('a limit or error is recorded where it happened', MAIN.includes("if (ev.type === 'budget_reached' || ev.type === 'limit_reached' || ev.type === 'error') {") && MAIN.includes('stops.push({ at: sess.messages.length, type: ev.type'), 'not recorded');
    check('reopening hands the stops to the window', MAIN.includes('stats: sess.stats, stops: sess.stops || [], context'), 'not sent');
    const HTML = read('src/renderer/index.html');
    check('replay draws the notice where the run stopped; only the last can continue', HTML.includes('v.root.appendChild(stopNotice(st, i === full.messages.length));') && HTML.includes('endOfRun(full.messages.length, lastMsg);'), 'generic line');
    check('summarising clears stops rather than misplacing them', read('src/backend/compact.js').split('session.stops = [];').length === 3, 'misplaced');
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}
  }

  // ------------------------------------------------------------------ [CW]
  console.log('\n[CW] call ids stay unique; the checker runs the right program');
  {
    // A model that numbers its calls call_0 every turn, as DeepSeek did.
    fakeOpenRouter((n) => (n <= 2 ? call('call_0', 'read', { path: 'a.txt' }) : say('done')));
    fs.writeFileSync(path.join(WD, 'a.txt'), 'hi');
    const sess = { id: 'cw', workdir: WD, messages: [] };
    await drain(runAgent({ session: sess, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 5 }));
    const ids = sess.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
    check('repeated call ids from the model are made unique', ids.length === 2 && new Set(ids).size === 2, ids);
    const paired = sess.messages.every((m, i) => m.role !== 'tool' || (sess.messages[i - 1] && sess.messages[i - 1].tool_calls && sess.messages[i - 1].tool_calls.some((c) => c.id === m.tool_call_id)));
    check('each result keeps its own call\'s id', paired, sess.messages.map((m) => m.role + ':' + (m.tool_call_id || (m.tool_calls || []).map((c) => c.id).join(','))));
    const { uniqueToolIds } = require(path.join(ROOT, 'src/backend/agent.js'));
    const old = [{ role: 'assistant', tool_calls: [{ id: 'call_0' }] }, { role: 'tool', tool_call_id: 'call_0', content: 'A' }, { role: 'assistant', tool_calls: [{ id: 'call_0' }] }, { role: 'tool', tool_call_id: 'call_0', content: 'B' }];
    const renamed = uniqueToolIds(old);
    check('an old session\'s repeats are renamed with their results', renamed === 1 && old[3].tool_call_id === old[2].tool_calls[0].id && old[1].tool_call_id === 'call_0' && uniqueToolIds(old) === 0, old);
    const HTML = read('src/renderer/index.html');
    check('a reopened session pairs results by position, not by id', HTML.includes('const results = resultsAfter(mi);'), 'wrong results on repeats');
    const LSP = read('src/backend/tools/lsp.js');
    check('node --check runs as Node, not as another copy of the app', LSP.includes("run(process.execPath, ['--check', f], ctx.workdir, 60000, { node: true })") && LSP.includes("opts.env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };"), 'launches the app');
    const ss4 = new vm.Script('(' + /function stepSummary\(counts, stats\)\{[\s\S]*?\n\}/.exec(HTML)[0] + ')').runInNewContext({});
    check('a type check says what it found', HTML.includes("return { html: o.checked ? 'no errors' : 'nothing to check' };") && ss4({ CHECK: 1 }, {}).head === 'Checked the code', ss4({ CHECK: 1 }, {}).head);
    check('a .cmd checker goes through cmd.exe (Node refuses it otherwise)', LSP.includes("if (process.platform === 'win32' && /\\.(cmd|bat)$/i.test(cmd)) {"), 'EINVAL');
  }

  // ------------------------------------------------------------------ [CX]
  console.log('\n[CX] Stop works while an action is stuck; the browser has time limits');
  {
    // ask_user with nobody answering stands in for a tool that never returns.
    fakeOpenRouter((n) => (n === 1 ? call('stuck1', 'ask_user', { question: 'still there?' }) : say('done')));
    const ctl = new AbortController();
    const sess = { id: 'cx', workdir: WD, messages: [] };
    setTimeout(() => ctl.abort(), 500);
    const t0 = Date.now();
    const ev = await drain(runAgent({ session: sess, userText: 'go', apiKey: 'k', model: 'm', access: 'full', signal: ctl.signal, askPermission: async () => true, userInput: () => new Promise(() => {}), maxTurns: 3 }));
    const took = Date.now() - t0;
    check('Stop ends a run whose action is stuck', ev.some((e) => e.type === 'cancelled') && took < 3000, { took, types: ev.map((e) => e.type) });
    const last = sess.messages[sess.messages.length - 1];
    check('the stuck call still gets a result, so the history stays valid', last && last.role === 'tool' && last.tool_call_id === 'stuck1' && /stopped by the user/.test(last.content), last);
    const cdp = require(path.join(ROOT, 'src/backend/cu/cdp.js'));
    const t1 = Date.now();
    let err = null;
    try { await cdp.withTimeout(new Promise(() => {}), 'Runtime.evaluate', 200); } catch (e) { err = e; }
    check('a browser command that never answers fails after its limit', err && /did not answer \(Runtime\.evaluate\)/.test(err.message) && Date.now() - t1 < 1500, err && err.message);
    // Stop ends the command itself, not only the run: a stopped `ping -n 40` kept going.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const ac = new AbortController();
      const sctx = { workdir: WD, session: { id: 'cx2', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {}, signal: ac.signal };
      const sh = buildTools(sctx).ALL.find((t) => t.def.function.name === 'shell');
      const long = process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 20';
      const t2 = Date.now();
      setTimeout(() => ac.abort(), 700);
      const r = await sh.run({ command: long }, sctx);
      await new Promise((res) => setTimeout(res, 800));
      let left = 0;
      if (process.platform === 'win32') {
        try { left = require('child_process').execFileSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/NH'], { encoding: 'utf8' }).split('\n').filter((l) => /PING\.EXE/i.test(l)).length; } catch {}
      }
      check('Stop ends a running command and its children', r.stopped === true && Date.now() - t2 < 6000 && left === 0, { stopped: r.stopped, ms: Date.now() - t2, left });
    }
    const ss5 = new vm.Script('(' + /function stepSummary\(counts, stats\)\{[\s\S]*?\n\}/.exec(read('src/renderer/index.html'))[0] + ')').runInNewContext({});
    check('a step you stopped is titled "Stopped"', ss5({}, { stopped: 1 }).head === 'Stopped', ss5({}, { stopped: 1 }).head);
    check('a stopped action reads "stopped", not failed', read('src/renderer/index.html').includes("if (rec.stopped) return { html: 'stopped' };"), 'failed');
    const CDPSRC = read('src/backend/cu/cdp.js');
    check('minimised, a page read skips the screenshot instead of stalling', CDPSRC.includes('if (includeScreenshot && windowMinimised()) {') && CDPSRC.includes("return BrowserWindow.getAllWindows().some((w) => w.isMinimized());"), 'waits for a frame');
    check('and a screenshot says so at once', CDPSRC.includes("if (windowMinimised()) throw new Error('No screenshot: the VoxAI Coder window is minimised"), 'stalls');
    check('the agent is told why there is no picture', read('src/backend/cu/index.js').includes('...(st.note ? { note: st.note } : {})'), 'silent');
    check('every browser command goes through the limit', read('src/backend/cu/cdp.js').includes('return withTimeout(C.attachedWC.debugger.sendCommand(method, params)'), 'no limit');
    // A page the user put in the preview, read without an `open` first: it read a
    // hidden about:blank instead and said the page was empty.
    {
      const { makeComputerUseTool } = require(path.join(ROOT, 'src/backend/cu/index.js'));
      let attached = false; const sent = [];
      const wc = { debugger: {
        attach: () => { attached = true; }, detach: () => { attached = false; }, isAttached: () => attached,
        removeAllListeners: () => {}, removeListener: () => {}, on: () => {},
        sendCommand: async (m) => { sent.push(m); if (m === 'Runtime.evaluate') return { result: { value: { title: 'Tip Calculator', url: 'file:///tip/index.html', text: 'Bill', elements: [] } } }; if (m === 'Page.captureScreenshot') return { data: 'AAAA' }; return {}; },
      } };
      const cu = makeComputerUseTool({ attachAtlas: () => wc });
      const st = await cu.run('cu_state', {}, { emit: () => {} });
      check('reading the page reads the preview the user sees, with no open first', st.title === 'Tip Calculator' && st.url === 'file:///tip/index.html' && attached, st);
      const before = sent.length;
      await cu.run('cu_state', {}, { emit: () => {} });
      check('and stays on it without re-attaching', sent.slice(before).filter((m) => m === 'Page.enable').length === 0, sent.slice(before));
      cdp.cleanup();
    }
    // A link in an answer loaded the site IN PLACE of the app, and the site got the
    // full bridge (agentSend, saveSettings, agentPermission).
    {
      const PRE = read('src/preload/preload.js');
      const exposedOn = (href) => {
        let exposed = false;
        const u = new URL(href);
        new vm.Script(PRE).runInNewContext({
          require: () => ({ contextBridge: { exposeInMainWorld: () => { exposed = true; } }, ipcRenderer: { invoke() {}, on() {}, send() {}, removeListener() {} } }),
          location: { protocol: u.protocol, pathname: u.pathname }, URL, decodeURIComponent,
        });
        return exposed;
      };
      check('the app page gets the bridge', exposedOn('file:///C:/Users/me/AppData/Local/Programs/voxai-coder/resources/app.asar/src/renderer/index.html'), 'not exposed');
      check('a web page never does', !exposedOn('https://example.com/') && !exposedOn('file:///C:/Users/me/evil.html') && !exposedOn('https://x.test/renderer/index.html'), 'exposed');
      const M = read('src/main/main.js');
      check('the app page cannot navigate away; web links open in the browser', M.includes('guardTrustedView(chatV.webContents);') && M.includes("wc.on('will-navigate', (e, url) => { if (!isAppPage(url)) { e.preventDefault(); outside(url); } });") && M.includes("return { action: 'deny' };"), 'navigates');
      const H = read('src/renderer/index.html');
      check('a clicked link never navigates the page', H.includes("const a = e.target && e.target.closest && e.target.closest('a[href]');") && H.includes("if (/^https?:\\/\\//i.test(href) && window.voxai && window.voxai.openExternal)"), 'navigates');
    }
    // The session menu: Export wrote out the OPEN session, not the one right-clicked,
    // and said so nowhere visible; Delete erased the file for good.
    {
      const H = read('src/renderer/index.html'), M = read('src/main/main.js');
      check('Export exports the session that was right-clicked', H.includes("if (act === 'export') { await exportSession(s.id); return; }") && !H.includes('exportActiveSession'), 'the open one');
      check('and says so, with a way to find the file', H.includes("toast('Exported “'") && H.includes("label: 'Show in folder', onClick: () => window.voxai.sessionsShowExport(id)") && M.includes("require('electron').shell.showItemInFolder(out);"), 'silent');
      check('the message can hide', H.includes('.toast[hidden]{display:none}'), 'always shown');
      check('Delete goes to the Recycle Bin', M.includes("await require('electron').shell.trashItem(file);") && !/sessions:delete[\s\S]{0,200}store\.deleteSession/.test(M), 'erased');
      check('and a failed move deletes nothing and says why', H.includes("if (r && r.ok === false) { alert(r.error || 'Could not delete the session.'); return; }") && H.includes('to the Recycle Bin?'), 'silent');
    }
    // A one-line file read as "2 lines": the newline that ends a line does not start one.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const rctx = { workdir: WD, session: { id: 'rl', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const rd = buildTools(rctx).ALL.find((t) => t.def.function.name === 'read');
      const cnt = async (name, body) => { fs.writeFileSync(path.join(WD, name), body); const r = await rd.run({ path: name }, rctx); return [r.lines, r.content]; };
      const got = [await cnt('l1.txt', 'hello\n'), await cnt('l1b.txt', 'hello'), await cnt('l3.txt', 'a\nb\nc\n'), await cnt('l0.txt', ''), await cnt('lb.txt', 'a\n\n')];
      check('a file is as many lines as an editor shows', JSON.stringify(got) === JSON.stringify([[1, 'hello'], [1, 'hello'], [3, 'a\nb\nc'], [0, ''], [2, 'a\n']]), got);
    }
    // A model's "\n\n" before a tool call left an empty text block in the thread,
    // which doubled the gap between the step and the answer.
    {
      const src = /function finalizeStream\(\)\{[^\n]*\}/.exec(read('src/renderer/index.html'))[0];
      const mk = (shown) => {
        const node = { removed: false, html: null, cls: ['md', 'live'], remove() { this.removed = true; }, classList: { remove: (c) => { node.cls = node.cls.filter((x) => x !== c); } }, set innerHTML(h) { node.html = h; } };
        const v = { curStream: node, shown, pending: '', pi: 0 };
        new vm.Script(src + '; finalizeStream();').runInNewContext({ RT: () => v, flushTyping: () => {}, renderVTE: (t) => '<p>' + t + '</p>' });
        return { node, v };
      };
      const a = mk('\n\n  ');
      check('a text block that only got whitespace is removed', a.node.removed && a.v.curStream === null, a.node);
      const b = mk('Checking the file.');
      check('a real one stays, rendered', !b.node.removed && b.node.html === '<p>Checking the file.</p>' && !b.node.cls.includes('live'), b.node);
    }
    // OpenRouter out of reach: the run ended on "Something went wrong — fetch failed".
    {
      const OR = require(path.join(ROOT, 'src/backend/providers/openrouter.js'));
      const faked = global.fetch;
      global.fetch = NATIVE_FETCH;
      let e1 = null;
      try { await OR.chatOnce({ apiKey: 'x', host: 'http://127.0.0.1:59999', model: 'm', messages: [] }); } catch (e) { e1 = e; }
      let e3 = null;
      try { await OR.chatOnce({ apiKey: 'x', host: 'http://127.0.0.1:9', model: 'm', messages: [] }); } catch (e) { e3 = e; }
      check('a blocked port says so', e3 && /(that port is blocked for web requests)/.test(e3.message), e3 && e3.message);
      check('an unreachable OpenRouter says so, and what to do', e1 && e1.code === 'unreachable' && /^Could not reach OpenRouter at http:\/\/127\.0\.0\.1:59999 \(the connection was refused\)\. .*address in Settings, then send again\.$/.test(e1.message), e1 && e1.message);
      const ac = new AbortController(); ac.abort();
      let e2 = null;
      try { await OR.chatOnce({ apiKey: 'x', host: 'http://127.0.0.1:9', model: 'm', messages: [], signal: ac.signal }); } catch (e) { e2 = e; }
      global.fetch = faked;
      check('a Stop still reads as a stop, not as unreachable', e2 && e2.name === 'AbortError' && e2.code !== 'unreachable', e2 && (e2.name + ' ' + e2.message));
      check('the notice is titled for it', read('src/renderer/index.html').includes("/^Could not reach OpenRouter/.test(msg) ? 'Could not reach OpenRouter' : 'Something went wrong'"), 'generic title');
    }
  }

  // ------------------------------------------------------------------ [CP]
  console.log('\n[CP] updates come from CodeRook, and only signed ones install');
  {
    const crypto = require('crypto');
    const U = require(path.join(ROOT, 'src/main/updater.js'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const m = { app: 'voxai-coder', version: '0.2.1', file: 'VoxAI-Coder-Setup-0.2.1.exe', size: 1234, sha512: 'abc==', notes: 'Fixes' };
    m.sig = U.signManifest(m, priv);
    check('a signed manifest verifies', U.verifyManifest(m, pub), 'refused');
    check('a changed installer hash is refused', !U.verifyManifest({ ...m, sha512: 'evil==' }, pub), 'accepted');
    check('changed notes are refused', !U.verifyManifest({ ...m, notes: 'Install this other thing' }, pub), 'accepted');
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    check('another key\'s signature is refused', !U.verifyManifest(m, other), 'accepted');
    check('no signature, no update', !U.verifyManifest({ ...m, sig: undefined }, pub), 'accepted');
    const info = { version: '0.2.1', files: [{ url: 'VoxAI-Coder-Setup-0.2.1.exe', sha512: 'abc==', size: 1234 }, { url: 'update.json', sha512: 'x', size: 9 }] };
    check('manifest and feed agree', U.matchesFeed(m, info), 'disagree');
    check('a feed listing another installer is refused', !U.matchesFeed(m, { ...info, files: [...info.files, { url: 'Other.exe', sha512: 'q', size: 1 }] }), 'accepted');
    check('a feed with another version is refused', !U.matchesFeed(m, { ...info, version: '0.2.2' }), 'accepted');

    const PKG = JSON.parse(read('package.json'));
    check('the app reads the public releases feed', PKG.build.publish && PKG.build.publish[0].url === U.FEED && /\/voxai-coder-releases\/updates$/.test(U.FEED), PKG.build.publish);
    check('installers are named without spaces, as the feed lists them', PKG.build.nsis.artifactName === 'VoxAI-Coder-Setup-${version}.${ext}', PKG.build.nsis);
    check('electron-updater ships with the app', PKG.dependencies && PKG.dependencies['electron-updater'], PKG.dependencies);
    check('dist never publishes by itself', /--publish never/.test(PKG.scripts.dist), PKG.scripts.dist);
    const KEY = read('resources/update-key.pem');
    check('only the public key is in the project', KEY.includes('BEGIN PUBLIC KEY') && !KEY.includes('PRIVATE'), 'private key in the project');
    check('updates download only after the signature checks out', /autoDownload = false/.test(read('src/main/updater.js')) && read('src/main/updater.js').includes('if (!verifyManifest(m, publicKey())) {'), 'downloads unchecked');
    // ---- the updater's decisions, against a stand-in for electron-updater
    const { EventEmitter } = require('events');
    const KEYFILE = path.join(WD, 'test-update-key.pem');
    fs.writeFileSync(KEYFILE, pub);
    Object.assign(process.env, { VOX_UPDATE_TEST: '0.2.0', VOX_UPDATE_PUBKEY: KEYFILE, VOX_UPDATE_RETRY_MS: '60', VOX_UPDATE_FOCUS_MS: '80', VOX_UPDATE_EVERY_MS: '600000', VOX_UPDATE_FEED: 'https://feed.test/updates' });
    const EU = require.resolve('electron-updater', { paths: [ROOT] });
    const realFetch = global.fetch;
    const wait = (n) => new Promise((r) => setTimeout(r, n));
    const signed = (over) => { const x = { ...m, version: '0.2.1', ...over }; x.sig = U.signManifest(x, priv); return x; };
    const feedInfo = { version: '0.2.1', files: [{ url: 'VoxAI-Coder-Setup-0.2.1.exe', sha512: 'abc==', size: 1234 }] };
    // One scenario: `manifests` are what update.json returns, in turn; `offline` fails the check.
    async function scenario({ manifests = [], offline = 0, run }) {
      const fake = new EventEmitter();
      let checks = 0, downloads = 0;
      fake.setFeedURL = () => {};
      fake.checkForUpdates = async () => {
        checks++;
        fake.emit('checking-for-update');
        if (checks <= offline) throw new Error('getaddrinfo ENOTFOUND feed.test');
        fake.emit('update-available', feedInfo);
      };
      fake.downloadUpdate = async () => { downloads++; fake.emit('update-downloaded', feedInfo); };
      fake.quitAndInstall = () => {};
      require.cache[EU] = { id: EU, filename: EU, loaded: true, exports: { autoUpdater: fake } };
      let n = 0;
      global.fetch = async () => ({ ok: true, json: async () => manifests[Math.min(n++, manifests.length - 1)] });
      const states = [];
      const up = U.initUpdater({ app: { getVersion: () => '0.2.0', isPackaged: true }, send: (s) => states.push(s.state + (s.error ? ':' + s.error : '')) });
      await run(up);
      return { up, states, checks: () => checks, downloads: () => downloads };
    }
    try {
      const good = await scenario({ manifests: [signed()], run: async (up) => { await up.check(); await wait(20); } });
      check('a signed release downloads and waits for a restart', good.up.state().state === 'ready' && good.downloads() === 1, good.states);

      const forged = await scenario({ manifests: [{ ...signed(), sha512: 'evil==' }], run: async (up) => { await up.check(); await wait(20); } });
      check('a forged manifest is refused and nothing downloads', forged.up.state().state === 'refused' && forged.downloads() === 0, forged.states);

      // update.json still describes the last release: wait, look again, then take it.
      const lag = await scenario({ manifests: [signed({ version: '0.2.0' }), signed()], run: async (up) => { await up.check(); await wait(200); } });
      check('caught mid-release it retries, not refuses', lag.states.some((x) => /still being published/.test(x)) && !lag.states.some((x) => x.startsWith('refused')) && lag.up.state().state === 'ready', lag.states);

      const off = await scenario({ manifests: [signed()], offline: 1, run: async (up) => { await up.check(); await wait(200); } });
      check('offline says so plainly and tries again by itself', off.states.includes('error:CodeRook could not be reached') && off.checks() >= 2 && off.up.state().state === 'ready', off.states);

      const foc = await scenario({ manifests: [signed({ version: '0.2.0' })], run: async (up) => {
        await up.check(); up.onFocus(); await wait(5);
      } });
      const early = foc.checks();
      await wait(120); foc.up.onFocus(); await wait(5);
      check('coming back to the window checks, but not every time', early === 1 && foc.checks() >= 2, [early, foc.checks()]);
      // The window appearing at launch is a focus too; the startup check covers it.
      const launch = await scenario({ manifests: [signed({ version: '0.2.0' })], run: async (up) => { up.onFocus(); await wait(5); } });
      check('a launch does not check twice', launch.checks() === 0, launch.checks());
    } finally {
      global.fetch = realFetch;
      delete require.cache[EU];
      for (const k of ['VOX_UPDATE_TEST', 'VOX_UPDATE_PUBKEY', 'VOX_UPDATE_RETRY_MS', 'VOX_UPDATE_FOCUS_MS', 'VOX_UPDATE_EVERY_MS', 'VOX_UPDATE_FEED']) delete process.env[k];
    }
    const UP = read('src/main/updater.js');
    check('an open app checks every 30 minutes', /CHECK_EVERY_MS = 30 \* 60 \* 1000/.test(UP), 'every 4 hours');
    check('update.json is never a cached copy', /update\.json\?t=\$\{Date\.now\(\)\}`, \{ redirect: 'follow', cache: 'no-store' \}/.test(UP), 'cached');
    const MAIN2 = read('src/main/main.js');
    check('one copy of the app at a time', /if \(!app\.requestSingleInstanceLock\(\)\) \{\s*app\.quit\(\);\s*return;/.test(MAIN2) && MAIN2.includes("app.on('second-instance'"), 'copies pile up');
    check('focus reaches the updater', MAIN2.includes("app.on('browser-window-focus', () => { try { updater && updater.onFocus(); } catch {} });"), 'never on focus');
    const REL = read('scripts/release.js');
    check('a release is named only after its files are attached', REL.indexOf("['attach', manifestPath]") < REL.indexOf("['release', `v${version}`"), 'named first');
    check('the release script checks the feed like an installed copy', REL.includes("if (bad.length) die(`the feed does not check out"), 'version string only');
    // After installing, the download stayed in pending/ -- a second 110 MB copy.
    {
      const LA = path.join(WD, 'localappdata');
      const pend = path.join(LA, 'voxai-coder-updater', 'pending');
      const put = (v) => { fs.mkdirSync(pend, { recursive: true }); fs.writeFileSync(path.join(pend, `VoxAI-Coder-Setup-${v}.exe`), 'x'); fs.writeFileSync(path.join(pend, 'update-info.json'), JSON.stringify({ fileName: `VoxAI-Coder-Setup-${v}.exe` })); };
      put('0.2.3');
      check('an installed download is cleared on the next start', U.clearInstalledDownload('0.2.3', () => {}, LA) === true && !fs.existsSync(pend), fs.existsSync(pend));
      // As found on a real install: two installers and no update-info.json (329 MB).
      fs.mkdirSync(pend, { recursive: true });
      for (const v of ['0.2.6', '0.2.12']) fs.writeFileSync(path.join(pend, `VoxAI-Coder-Setup-${v}.exe`), 'x');
      check('old installers go even without the info file', U.clearInstalledDownload('0.2.12', () => {}, LA) === true && !fs.existsSync(pend), fs.existsSync(pend) && fs.readdirSync(pend));
      fs.mkdirSync(pend, { recursive: true });
      for (const v of ['0.2.11', '0.2.13']) fs.writeFileSync(path.join(pend, `VoxAI-Coder-Setup-${v}.exe`), 'x');
      U.clearInstalledDownload('0.2.12', () => {}, LA);
      check('a second pass clears what the running installer still held', read('src/main/updater.js').includes('setTimeout(() => clearInstalledDownload(app.getVersion(), log), 90 * 1000);'), 'waits for the next launch');
      check('a newer one waiting to install is kept, older ones go', JSON.stringify(fs.readdirSync(pend)) === JSON.stringify(['VoxAI-Coder-Setup-0.2.13.exe']), fs.readdirSync(pend));
      fs.rmSync(pend, { recursive: true, force: true });
      put('0.2.4');
      check('one still waiting to be installed is kept', U.clearInstalledDownload('0.2.3', () => {}, LA) === false && fs.existsSync(path.join(pend, 'VoxAI-Coder-Setup-0.2.4.exe')), fs.existsSync(pend));
      fs.rmSync(path.join(LA, 'voxai-coder-updater'), { recursive: true, force: true });
      check('nothing downloaded is not an error', U.clearInstalledDownload('0.2.3', () => {}, LA) === false, 'threw');
    }
    // Every build used to leave its ~110 MB installers behind in release/.
    check('each build clears the last one first', PKG.scripts.predist === 'node scripts/clean-release.js', PKG.scripts);
    {
      const OUTD = path.join(WD, 'release-out');
      fs.mkdirSync(path.join(OUTD, 'win-unpacked'), { recursive: true });
      for (const f of ['VoxAI-Coder-Setup-0.2.1.exe', 'VoxAI-Coder-Setup-0.2.1.exe.blockmap', 'VoxAI-Coder-0.2.1-portable.exe', 'latest.yml', 'update.json', 'my-notes.txt']) fs.writeFileSync(path.join(OUTD, f), 'x');
      require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts/clean-release.js')], { env: { ...process.env, VOX_RELEASE_OUT: OUTD } });
      const left = fs.readdirSync(OUTD);
      check('only the build\'s own files go', left.length === 1 && left[0] === 'my-notes.txt', left);
    }
    check('the window can see and act on updates', /updates: \{[\s\S]{0,200}update:install/.test(read('src/preload/preload.js')) && read('src/renderer/index.html').includes("id=\"updPill\""), 'no UI');
  }

  try { fs.rmSync(WD, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
