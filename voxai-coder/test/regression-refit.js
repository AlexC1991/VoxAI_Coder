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

  try { fs.rmSync(WD, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
