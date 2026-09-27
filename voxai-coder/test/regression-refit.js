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
const PKG0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SK_FM = (t) => require(path.join(ROOT, 'src/backend/tools/skills.js')).frontMatter(t);

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

const NATIVE_FETCH = global.fetch;   // the fakes below replace it

/**
 * A fake OpenRouter that replies with `script(n)` for turn n of the conversation a request
 * carries (its assistant messages + 1). It used to count requests: a call still in flight
 * from an earlier test then took turn 1's reply (the tool call), and the test under way
 * got "done" and failed now and then. Counted from the request itself, a stray call only
 * gets an answer for its own conversation. One-shot calls (stream: false -- the Auto
 * check, screenshot descriptions, goal checks) get an empty reply and move nothing.
 */
function fakeOpenRouter(script) {
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.stream === false) return { ok: true, text: async () => '' };
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
    check('the approval belongs to the session that asked', /function onAgentPerm\(\{ permId, sessionId,/.test(HTML), 'shown on any session');
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
    check('the session search is wired', HTML.includes("$('q').addEventListener('input', () => {") && HTML.includes('window.voxai.sessionsSearch('), 'search does nothing');
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
    check('questions go out on the channel the thread listens to', MAIN.includes("const event = { type: 'user_input', inputId,") && MAIN.includes("c1 && c1.send('agent:event', { sessionId, runKey, event });") && !MAIN.includes("c1.send('agent:user_input'"), 'unheard channel');
    const HTML = read('src/renderer/index.html');
    check('an answered question stays as one line with the answer', HTML.includes('settleAsk(v, box, record(lines));') && HTML.includes("lines = [[steps[0].question, 'You chose: ' + clean(shown)]];"), 'vanishes');
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
    // The user: no drop-down over the work -- each action its own line ("Ran ...", "Created ...").
    check('steps have no header and never fold: every action is its own line', HTML.includes('.run > .runhead{display:none}')
      && !HTML.includes('if (card.running === false && card.setOpen) card.setOpen(false);'), 'folds');
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
    // Windows files: an edit on a CRLF file left it with mixed line endings, a
    // multi-line patch never matched, old_string/new_string crashed edit, and cmd's
    // own output ("café") came back garbled. Found in a live run.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const ectx = { workdir: WD, session: { id: 'eol', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const T = Object.fromEntries(buildTools(ectx).ALL.map((t) => [t.def.function.name, t]));
      const F = (n) => path.join(WD, n);
      fs.writeFileSync(F('crlf.js'), 'function a() {\r\n  return 1;\r\n}\r\n\r\nfunction b() {\r\n  return 2;\r\n}\r\n');
      await T.read.run({ path: 'crlf.js' }, ectx);
      const e1 = await T.edit.run({ path: 'crlf.js', before: 'function b() {\n  return 2;\n}', after: 'function b() {\n  return 3;\n}' }, ectx);
      const t1 = fs.readFileSync(F('crlf.js'), 'utf8');
      check('an edit on a Windows file matches exactly and keeps its line endings', e1.match === 'exact' && t1 === 'function a() {\r\n  return 1;\r\n}\r\n\r\nfunction b() {\r\n  return 3;\r\n}\r\n', JSON.stringify(t1));
      fs.writeFileSync(F('crlf2.js'), 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n');
      await T.read.run({ path: 'crlf2.js' }, ectx);
      await T.patch.run({ path: 'crlf2.js', edits: [{ old: 'const a = 1;\nconst b = 2;', new: 'const a = 10;\nconst b = 20;' }] }, ectx);
      check('a multi-line patch on a Windows file applies', fs.readFileSync(F('crlf2.js'), 'utf8') === 'const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n', fs.readFileSync(F('crlf2.js'), 'utf8'));
      await T.read.run({ path: 'crlf2.js' }, ectx);
      await T.write.run({ path: 'crlf2.js', content: 'x\ny\n' }, ectx);
      check('rewriting a Windows file keeps its endings', fs.readFileSync(F('crlf2.js'), 'utf8') === 'x\r\ny\r\n', fs.readFileSync(F('crlf2.js'), 'utf8'));
      await T.write.run({ path: 'fresh.txt', content: 'x\ny\n' }, ectx);
      check('a new file is written as given', fs.readFileSync(F('fresh.txt'), 'utf8') === 'x\ny\n', 'changed');
      fs.writeFileSync(F('lf.txt'), 'alpha\nbeta\n');
      await T.read.run({ path: 'lf.txt' }, ectx);
      const e2 = await T.edit.run({ path: 'lf.txt', old_string: 'beta', new_string: 'gamma' }, ectx);
      check('old_string/new_string are understood', e2.match === 'exact' && fs.readFileSync(F('lf.txt'), 'utf8') === 'alpha\ngamma\n', e2);
      let e3 = null; try { await T.edit.run({ path: 'lf.txt' }, ectx); } catch (e) { e3 = e.message; }
      check('and missing text is explained, not a crash', /edit needs `before`/.test(e3 || ''), e3);
      const { decodeOutput, CP437, CP850 } = require(path.join(ROOT, 'src/backend/tools/decode.js'));
      check('the OEM tables are complete', [...CP437].length === 128 && [...CP850].length === 128, [[...CP437].length, [...CP850].length]);
      const mixed = Buffer.concat([Buffer.from('caf'), Buffer.from([0x82, 0x0d, 0x0a]), Buffer.from('héllo ✓\n', 'utf8')]);
      check("cmd's own output and UTF-8 lines both read right", decodeOutput(mixed, 437) === 'café\r\nhéllo ✓\n' && decodeOutput(Buffer.from([0x82]), 850) === 'é', JSON.stringify(decodeOutput(mixed, 437)));
      if (process.platform === 'win32') {
        fs.mkdirSync(F('café'), { recursive: true });
        const d = await T.shell.run({ command: 'dir /b' }, ectx);
        check('a folder listing shows accented names', d.stdout.includes('café'), d.stdout);
      }
    }
    // OpenRouter errors reached the user as raw JSON, and a busy provider or rate limit
    // (which passes in seconds) ended the run.
    {
      const OR = require(path.join(ROOT, 'src/backend/providers/openrouter.js'));
      const e402 = OR.responseError(402, JSON.stringify({ error: { message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', code: 402 } }));
      check('no credits says so, and where to add them', /^Your OpenRouter account is out of credits\. Add credits at openrouter\.ai/.test(e402.message) && !/\{/.test(e402.message) && !e402.retryable, e402.message);
      const e502 = OR.responseError(502, JSON.stringify({ error: { message: 'Provider returned error', code: 502, metadata: { raw: '{"type":"overloaded_error"}', provider_name: 'Anthropic' } } }));
      check('a provider failure names the provider and is retried', /^The model's provider \(Anthropic\) had a problem: overloaded_error/.test(e502.message) && e502.retryable, e502.message);
      check('a bad key is not retried', OR.responseError(401, '{}').retryable === false && /did not accept the API key/.test(OR.responseError(401, '{}').message), 'retried');
      const prevWaits = process.env.VOX_RETRY_WAITS_MS;
      process.env.VOX_RETRY_WAITS_MS = '20,40';
      try {
        const busy = { ok: false, status: 502, body: null, text: async () => JSON.stringify({ error: { message: 'Provider returned error', metadata: { provider_name: 'X', raw: '{"type":"overloaded_error"}' } } }) };
        fakeOpenRouter(() => say('recovered'));
        const good = global.fetch;
        let n = 0;
        global.fetch = async (...a) => (++n === 1 ? busy : good(...a));
        const live = [];
        const ev = await drain(runAgent({ session: { id: 'retry1', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2, onLiveEvent: (e) => live.push(e) }));
        const done = ev.find((e) => e.type === 'done');
        check('a busy provider is retried and the run carries on', done && /recovered/.test(done.content || '') && n === 2, ev.map((e) => e.type));
        check('and the user is told it is trying again', live.some((e) => e.type === 'warning' && e.code === 'retrying' && /Trying again in 0s \(1 of 2\)/.test(e.message)), live.map((e) => e.type + ':' + (e.code || '')));
        let m = 0;
        global.fetch = async () => { m++; return { ok: false, status: 401, body: null, text: async () => '{}' }; };
        const ev2 = await drain(runAgent({ session: { id: 'retry2', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2 }));
        check('a refused key ends the run at once, with the reason', m === 1 && ev2.some((e) => e.type === 'error' && /did not accept the API key/.test(e.message)), [m, ev2.map((e) => e.type)]);
        process.env.VOX_RETRY_WAITS_MS = '5000';
        global.fetch = async () => busy;
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 150);
        const t0 = Date.now();
        const ev3 = await drain(runAgent({ session: { id: 'retry3', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2, signal: ctl.signal }));
        check('Stop during the wait ends it at once', Date.now() - t0 < 2000 && ev3.some((e) => e.type === 'cancelled'), [Date.now() - t0, ev3.map((e) => e.type)]);
      } finally {
        if (prevWaits === undefined) delete process.env.VOX_RETRY_WAITS_MS; else process.env.VOX_RETRY_WAITS_MS = prevWaits;
      }
      const H = read('src/renderer/index.html');
      check('out of credits is titled so', H.includes("[/^Your OpenRouter account is out of credits/, 'Out of OpenRouter credits'],"), 'generic');
    }
    // Odd answers: a connection dropped mid-answer said "terminated" and lost what had
    // arrived; an empty answer ended the run showing nothing; "unknown tool: Bash".
    {
      const enc = new TextEncoder();
      const body = (chunks, fail) => new ReadableStream({ start(c) {
        for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n'));
        if (fail) { setTimeout(() => c.error(new TypeError('terminated')), 30); return; }
        c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
      } });
      const serve = (steps) => { global.fetch = async () => { const s = steps.shift() || { chunks: [{ choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] }] }; return { ok: true, status: 200, body: body(s.chunks, s.fail) }; }; };
      const prevW = process.env.VOX_RETRY_WAITS_MS; process.env.VOX_RETRY_WAITS_MS = '10,20';
      try {
        const agentRun = async (id) => { const session = { id, workdir: WD, messages: [] }; const ev = await drain(runAgent({ session, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3 })); return { ev, session }; };
        serve([{ chunks: [{ choices: [{ delta: { content: 'Here is the first half' } }] }], fail: true }]);
        const a = await agentRun('odd1');
        const errA = a.ev.find((e) => e.type === 'error');
        check('a drop mid-answer keeps what arrived and says to continue', errA && /dropped part-way through the answer.*send "continue"/.test(errA.message) && a.session.messages.some((m) => m.role === 'assistant' && m.content === 'Here is the first half'), [errA, a.session.messages]);
        serve([{ chunks: [], fail: true }]);
        const b = await agentRun('odd2');
        check('a drop before anything arrived is retried', (b.ev.find((e) => e.type === 'done') || {}).content === 'fine', b.ev.map((e) => e.type));
        serve([{ chunks: [{ choices: [{ delta: {}, finish_reason: 'stop' }] }] }]);
        const c = await agentRun('odd3');
        check('an empty answer is asked again', (c.ev.find((e) => e.type === 'done') || {}).content === 'fine', c.ev.map((e) => e.type));
        serve([{ chunks: [{ choices: [{ delta: {}, finish_reason: 'stop' }] }] }, { chunks: [{ choices: [{ delta: {}, finish_reason: 'stop' }] }] }]);
        const d = await agentRun('odd4');
        check('two empty answers are said, not silent', d.ev.some((e) => e.type === 'warning' && e.code === 'empty-answer'), d.ev.map((e) => e.type));
        serve([{ chunks: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'u1', function: { name: 'Bash', arguments: '{"command":"dir"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }] }]);
        const e = await agentRun('odd5');
        const te = e.ev.find((x) => x.type === 'tool_end');
        check('an unknown tool points to the right one', te && /There is no tool called Bash\. Use shell for that\. The tools here are: .*\bread\b/.test(te.result), te && te.result);
      } finally {
        if (prevW === undefined) delete process.env.VOX_RETRY_WAITS_MS; else process.env.VOX_RETRY_WAITS_MS = prevW;
      }
    }
    // snapshot restore writes files back, yet ran without asking under "Ask first";
    // the agent named levels the menu does not show ("Auto-edit files").
    {
      const SB = require(path.join(ROOT, 'src/backend/tools/sandbox.js'));
      const rs = SB.checkToolAllowed('snapshot', 'ask', { action: 'restore' });
      check('restoring a snapshot asks under "Ask first"', !rs.allowed && rs.needsPermission, rs);
      check('saving one does not', SB.checkToolAllowed('snapshot', 'ask', { action: 'create' }).allowed, 'asks');
      check('and it runs by itself once edits do', SB.checkToolAllowed('snapshot', 'edit', { action: 'restore' }).allowed, 'asks');
      const H = read('src/renderer/index.html');
      const ui = new vm.Script('(' + /\{ ask:'Ask first'[^}]*\}/.exec(H)[0] + ')').runInNewContext({});
      const same = Object.keys(ui).every((k) => SB.ACCESS_LABELS && SB.ACCESS_LABELS[k] === ui[k]);
      check('the agent names the levels as the menu does', same, [ui, SB.ACCESS_LABELS]);
    }
    // node_repl dropped the value of any snippet with a statement, and ran a failing
    // expression twice; rag given a folder said only "cannot read .".
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const nctx = { workdir: WD, session: { id: 'n', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const T = Object.fromEntries(buildTools(nctx).ALL.map((t) => [t.def.function.name, t]));
      const r1 = await T.node_repl.run({ code: 'const x = 5; x * 2' }, nctx);
      check('a snippet with statements returns its last value', r1.ok && r1.value === 10, r1);
      const r2 = await T.node_repl.run({ code: '(console.log("once"), missingName)' }, nctx);
      check('a failing expression runs once', !r2.ok && r2.logs.length === 1 && /missingName/.test(r2.error), r2);
      check('an expression still returns its value', (await T.node_repl.run({ code: '[1,2,3].map((n) => n * 2)' }, nctx)).value.join(',') === '2,4,6', 'no value');
      let rg = null; try { await T.rag.run({ path: '.', query: 'x' }, nctx); } catch (e) { rg = e.message; }
      check('rag on a folder says to use grep', /is a folder.*use grep/.test(rg || ''), rg);
    }
    // Reopened, a session showed "↳ 1 screenshot from computer above" and no picture:
    // the screenshots it had shown live were gone from the record.
    {
      const H = read('src/renderer/index.html');
      const cs = new vm.Script('(' + /function cuShot\(title, dataUrl\)\{[\s\S]*?\n\}/.exec(H)[0] + ')').runInNewContext({
        el: (t, c, h) => ({ tag: t, className: c, html: h, kids: [], appendChild(x) { this.kids.push(x); } }),
        esc: (s) => s, document: { createElement: (t) => ({ tag: t, style: {} }) },
      });
      check('a screenshot is drawn from its inline image', cs('screen', 'data:image/png;base64,AAAA') && cs('screen', 'data:image/png;base64,AAAA').kids[1].src === 'data:image/png;base64,AAAA', 'none');
      check('and nothing else is loaded as one', cs('x', 'https://evil.test/p.png') === null && cs('x', 'javascript:alert(1)') === null, 'loaded');
      check('reopening draws the screenshots, above their line', /cuShot\('screen', p\.image_url && p\.image_url\.url\)[\s\S]{0,120}\}\s*r\.appendChild\(note\);/.test(H), 'line only');
    }
    // The queue: steering followed a position, not the message -- remove an earlier one,
    // or let the front one go out, and the instruction landed on the next message. Edit
    // replaced a draft in the box and dropped the message's steer note and images.
    {
      const H = read('src/renderer/index.html');
      const sync = new vm.Script('(' + /function syncSteer\(v\)\{[\s\S]*?\n\}/.exec(H)[0] + ')').runInNewContext({ actView: () => null, $: () => null, paintShelf: () => {}, updateSteerHint: () => {} });
      const A = { text: 'A' }, B = { text: 'B' }, C = { text: 'C' };
      const v = { queue: [A, B, C], steerIdx: 1, steerItem: B };
      v.queue.splice(0, 1); sync(v);
      const afterRemove = v.steerIdx;
      v.queue.shift(); sync(v);
      check('steering stays on its message when the queue changes', afterRemove === 0 && v.steerIdx === null && v.steerItem === null, [afterRemove, v.steerIdx]);
      const v2 = { queue: [A, B, C], steerIdx: 2, steerItem: C };
      v2.queue.shift(); sync(v2);
      check('and follows it as it moves up', v2.steerIdx === 1 && v2.queue[v2.steerIdx] === C, v2.steerIdx);
      check('a message going out re-finds the one being steered', H.includes('const next = v.queue.shift();\n  syncSteer(v);'), 'index kept');
      check('Send on the start screen starts a session instead of doing nothing', /async function send\(\)\{\s*let v = actView\(\);[\s\S]{0,900}if \(!v\) \{\s*if \(!\$\('prompt'\)\.value\.trim\(\)\) return;[\s\S]{0,120}try \{ await newSession\(\); \}/.test(H), 'nothing');
      check('Edit does not replace a draft', H.includes("if (ta.value.trim()) { toast('Send or clear what you are typing first, then edit this message.'); return; }"), 'replaced');
      check('Edit brings back the steer note and images', H.includes("ta.value = item.steer ? raw + '\\n\\n' + item.steer : raw;") && H.includes("if (url) PENDING_ATTACH.push({ dataUrl: url, name: 'image' });"), 'dropped');
    }
    // One box for every session: a draft followed you into another session (one Enter
    // from the wrong project) and the first was lost. With no key, a session was made
    // and the reminder was written as if the model said it. At 1100px with the preview
    // open, Send (Stop, mid-run) was pushed out of the box.
    {
      const H = read('src/renderer/index.html');
      check('each session keeps its own draft and attachments', H.includes('if (prevView && prevView !== v) stashDraft(prevView);') && H.includes('if (prevView && prevView !== v) restoreDraft(v);') && /function stashDraft\(v\)\{[\s\S]{0,120}v\.draftAttach = PENDING_ATTACH\.slice\(\);/.test(H), 'shared');
      check('a new session starts with an empty box, the old draft kept', H.includes("if (prevView) { stashDraft(prevView); const ta = $('prompt'); ta.value = '';"), 'carried');
      check('no key: said first, no session made, not as the model', /let v = actView\(\);\s*\/\/[^\n]*\n[^\n]*\n\s*if \(\$\('prompt'\)\.value\.trim\(\) && !S\.hasOpenRouterKey\) \{\s*openModal\('account'\);\s*toast\(/.test(H) && !H.includes("addMsg('Set your OpenRouter API key"), 'as a reply');
      check('narrow, the Plan label really hides so Send stays in the box', H.includes('.composer-row .plan-sw{font-size:0;gap:0}') && H.includes('.composer-row .chip .cv{display:none}'), 'overridden');
    }
    // Confirmation round: worktree merges that conflicted were left half-done; MCP had
    // never worked (wrong framing, servers never passed, npx unstartable, a new server
    // every turn); --user-data-dir was ignored; the model did not know the date.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const { execFileSync } = require('child_process');
      const R = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-wtt-'));
      const g = (...a) => { try { return execFileSync('git', a, { cwd: R, stdio: 'pipe' }).toString().trim(); } catch (e) { return 'ERR'; } };
      fs.writeFileSync(path.join(R, 'app.txt'), 'one\n');
      g('init', '-q'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'init');
      const wctx = { workdir: R, session: { id: 'wtt', workdir: R, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const wt = buildTools(wctx).ALL.find((t) => t.def.function.name === 'worktree');
      const c1 = await wt.run({ action: 'create', name: 'wt-b' }, wctx);
      check('an open worktree stays out of git status', g('status', '--porcelain') === '', g('status', '--porcelain'));
      fs.writeFileSync(path.join(c1.path, 'app.txt'), 'WORKTREE\n');
      fs.writeFileSync(path.join(R, 'app.txt'), 'MAIN\n');
      g('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qam', 'main');
      let me = null;
      try { await wt.run({ action: 'merge', name: 'wt-b', message: 'b' }, { ...wctx }); } catch (e) { me = e.message; }
      check('a conflicting merge is undone and explained', /conflict with .* in app\.txt, so nothing was merged/.test(me || '') && !fs.existsSync(path.join(R, '.git', 'MERGE_HEAD')) && fs.readFileSync(path.join(R, 'app.txt'), 'utf8').replace(/\r/g, '') === 'MAIN\n', me);
      fs.rmSync(R, { recursive: true, force: true });
      // MCP against a server that follows the spec (one JSON message per line).
      const SRV = path.join(WD, 'mcp-srv.js');
      fs.writeFileSync(SRV, "const rl=require('readline').createInterface({input:process.stdin});const s=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',(l)=>{let m;try{m=JSON.parse(l)}catch{return}if(m.method==='initialize')s({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'t',version:'1'}}});else if(m.method==='tools/list')s({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'add',description:'add',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}}}},{name:'env',description:'env',inputSchema:{type:'object',properties:{}}}]}});else if(m.method==='tools/call'){const a=m.params.arguments||{};s({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:m.params.name==='add'?String(a.a+a.b):String(process.env.T_NAME)}]}})}});");
      const mctx = { ...wctx, workdir: WD, getSettings: () => ({ mcpServers: { t: { command: process.execPath, args: [SRV], env: { T_NAME: 'from-env' } } } }) };
      const mcp = buildTools(mctx).ALL.find((t) => t.def.function.name === 'mcp');
      const lt = await mcp.run({ action: 'list_tools' }, mctx);
      check('MCP lists a spec server\'s tools, with their inputs', lt.tools && lt.tools.length === 2 && lt.tools[0].inputSchema && lt.tools[0].inputSchema.properties.a, lt);
      const add = await mcp.run({ action: 'call', server: 't', name: 'add', arguments: { a: 19, b: 23 } }, mctx);
      const env = await mcp.run({ action: 'call', server: 't', name: 'env', arguments: {} }, mctx);
      check('and calls them, with the configured env', add.ok && add.text === '42' && env.text === 'from-env', [add, env]);
      const mcp2 = buildTools(mctx).ALL.find((t) => t.def.function.name === 'mcp');
      await mcp2.run({ action: 'call', server: 't', name: 'add', arguments: { a: 1, b: 1 } }, mctx);
      check('one server process across turns, not one per turn', require(path.join(ROOT, 'src/backend/tools/mcp.js'))._clients.size === 1, require(path.join(ROOT, 'src/backend/tools/mcp.js'))._clients.size);
      require(path.join(ROOT, 'src/backend/tools/procs.js')).stopAll();
      check('the app passes the configured servers to the agent', read('src/backend/agent.js').includes('getSettings: () => ({ access, mcpServers: mcpServers || {} }),') && (read('src/main/main.js').match(/mcpServers: readSettingsFile\(\)\.mcpServers \|\| \{\}/g) || []).length === 2, 'never passed');
      const MM = read('src/main/main.js'), HH = read('src/renderer/index.html'), AG = read('src/backend/agent.js');
      check('--user-data-dir is respected, for a separate profile', MM.includes("if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData'"), 'ignored');
      check("errors from the main process lose Electron's wrapper", HH.includes("replace(/^Error invoking remote method '[^']*': (?:\\w*Error: )?/, '')"), 'wrapper shown');
      check('Send shows keyboard focus', HH.includes('.send:focus-visible{outline:2px solid var(--gold);outline-offset:2px}'), 'no ring');
      check('the model is told today\'s date', AG.includes("`Today's date: ${localDate()}. `"), 'no date');
    }
    // ask_user, the way Claude Code asks: up to 4 questions, described options, one or
    // several picks, always a way to type your own; skip says so; typed answers count.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      let asked = null, reply = null;
      const actx = { workdir: WD, session: { id: 'ask2', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {}, userInput: async (q) => { asked = q; return reply; } };
      const ask = buildTools(actx).ALL.find((t) => t.def.function.name === 'ask_user');
      const qsSchema = ask.def.function.parameters.properties.questions;
      check('the model can ask up to 4 questions at once', qsSchema && qsSchema.maxItems === 4 && qsSchema.items.properties.multiSelect && qsSchema.items.properties.options.items.properties.description, qsSchema);
      reply = { answer: { answers: { 'Which art style?': 'Pixel art (Recommended)', 'Which features?': ['Score', 'Sound'] } }, cancelled: false };
      const r1 = await ask.run({ questions: [
        { question: 'Which art style?', header: 'Art style', options: [{ label: 'Pixel art (Recommended)', description: 'Retro look' }, { label: 'Flat vector', description: 'Clean shapes' }] },
        { question: 'Which features?', header: 'Features', multiSelect: true, options: ['Score', 'Sound', 'Levels'] },
      ] }, actx);
      check('the card gets every question with its descriptions', asked.questions.length === 2 && asked.questions[0].options[0].description === 'Retro look' && asked.questions[1].multiSelect === true, asked.questions);
      check('answers come back per question, several where several were picked', r1.answers['Which art style?'] === 'Pixel art' && JSON.stringify(r1.answers['Which features?']) === '["Score","Sound"]' && r1.cancelled === false, r1);
      reply = { answer: null, cancelled: true };
      const r2 = await ask.run({ questions: [{ question: 'Colour?', options: ['red', 'green'] }] }, actx);
      check('skipping tells the model to decide and say so', r2.cancelled && /Decide sensibly yourself/.test(r2.note || ''), r2);
      reply = { answer: 'blue please', cancelled: false };
      const r3 = await ask.run({ questions: [{ question: 'Colour?', options: ['red', 'green'] }] }, actx);
      check('typing your own answer works', r3.answers['Colour?'] === 'blue please' && r3.answer === 'blue please', r3);
      const H = read('src/renderer/index.html');
      check('the card offers Other on every question', H.includes("ot.appendChild(el('span', 'qa-l', s.options.length ? 'Something else…' : 'Type your answer'));"), 'no Other');
      check('keys: 1-9 pick, Enter submits, Esc skips', H.includes("if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !isField(e.target)) {") && H.includes("if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(true); return; }"), 'no keys');
      check('the message box answers a waiting question', H.includes('if (v.pendingAsk) {\n    v.pendingAsk.answerTyped(text);'), 'queued instead');
      check('a run that ends first leaves no live card', H.includes('if (v.pendingAsk) v.pendingAsk.expire();'), 'clickable');
      check('Esc skips the question rather than stopping the run', H.includes('|| !!(v && v.pendingAsk) ||'), 'stops the run');
      // The confirmation card: Esc stopped the whole run, and typed text was queued
      // behind the run waiting for it.
      check('a confirmation waits like a question: Esc dismisses, typing answers', H.includes("box, kind: confirm ? 'confirm' : 'ask',") && H.includes("if (confirm) { finish(false, text); return; }"), 'stops the run');
      let cAsked = null;
      const cctx = { ...actx, userInput: async (q) => { cAsked = q; return { answer: 'no, call it store-hours.txt instead', cancelled: false }; } };
      const conf = buildTools(cctx).ALL.find((t) => t.def.function.name === 'ask_confirm');
      const cr = await conf.run({ message: 'Rename it?' }, cctx);
      check('declining in your own words reaches the agent', cr.confirmed === false && cr.note === 'no, call it store-hours.txt instead', cr);
      const cy = await conf.run({ message: 'Rename it?' }, { ...cctx, userInput: async () => ({ answer: 'yes', cancelled: false }) });
      check('"yes" confirms', cy.confirmed === true && !cy.note, cy);
      check('several questions answered in one sentence are labelled as such', H.includes("steps.length === 1 ? steps[0].question : steps.length + ' questions'") && H.includes("if (o.note) return { html: esc(trunc(String(o.note), 60)) };"), 'first question only');
      check('the model is told when to ask, and when not to', read('src/backend/agent.js').includes('ask with ask_user before building rather than guessing: put up to 4 related questions in one call'), 'not told');
    }
    // 0.2.37: the Memory page back, Esc to stop, a Content-Security-Policy, Copy on code
    // blocks, and the keyboard: shortcuts, paste from anywhere, file paths.
    {
      const H = read('src/renderer/index.html'), M = read('src/main/main.js'), P = read('src/preload/preload.js');
      check('Settings has a Memory page for the open project', H.includes('<section class="set-page" data-set="memory" hidden>') && H.includes('function memoryDir(){ return viewDir(actView())') && H.includes("if (key === 'memory') {"), 'missing');
      check('Forget removes exactly that fact', M.includes("const i = Number.isInteger(index) && facts[index] && facts[index].text === exact ? index : facts.findIndex((f) => f.text === exact);") && P.includes("memoryForget: (workdir, exact, index) => ipcRenderer.invoke('memory:delete', { workdir, exact, index })"), 'by prefix');
      check('Esc stops a running answer, unless something is open', H.includes("run: () => { const v = actView(); if (!v || !v.busy || overlayOpen()) return false; stopCurrent(); toast('Stopped.'); return true; } }"), 'nothing');
      check('the Keyboard page is drawn from the same table', H.includes('for (const s of SHORTCUTS) {') && H.includes('<section class="set-page" data-set="keys" hidden>'), 'separate list');
      check('paste works from anywhere in the window', H.includes("document.addEventListener('paste', (e) => {\n  if (e.defaultPrevented || isField(e.target) || overlayOpen()) return;"), 'box only');
      check('a dropped or pasted file goes in as its path', P.includes('pathForFile: (file) =>') && P.includes('webUtils.getPathForFile(file)'), 'dropped');
      check('code blocks get a Copy button', H.includes("if (typeof addCodeCopy === 'function') addCodeCopy(m);") && H.includes("if (typeof addCodeCopy === 'function') addCodeCopy(v.curStream);"), 'none');
      // The policy: only the page's own scripts run.
      const CSP = require(path.join(ROOT, 'scripts/csp.js'));
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(H);
      check('the page has a Content-Security-Policy, and it is current', meta && meta[1] === CSP.policyFor(H), meta && meta[1].slice(0, 60));
      check('it allows no inline script but the page\'s own', meta && /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'(;|$)/.test(meta[1]) && !/script-src[^;]*unsafe-inline/.test(meta[1]) && /default-src 'none'/.test(meta[1]), meta && meta[1]);
      const PKG = JSON.parse(read('package.json'));
      check('the policy is rewritten before start, test and a build', [PKG.scripts.prestart, PKG.scripts.pretest, PKG.scripts.predist].every((s) => /node scripts\/csp\.js/.test(s || '')), PKG.scripts);
    }
    // Closing the preview and opening it again showed a blank page and "The model
    // hasn't shown anything yet", after two pages had been shown.
    {
      const H = read('src/renderer/index.html');
      check('the preview remembers its page for each session', H.includes("if (url && url !== 'about:blank') { const av = actView(); if (av) av.ppLastUrl = url; }"), 'forgotten');
      check('and reopens it', H.includes('const last = actView() && actView().ppLastUrl;') && H.includes('open ? ppClose() : ppOpen(last || undefined);'), 'blank');
    }
    // The page's own scripts compile: a broken regex in index.html shows up as a blank
    // app, not a failing test, unless something checks.
    {
      const H = read('src/renderer/index.html');
      const blocks = [...H.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      const bad = [];
      blocks.forEach((b, i) => { try { new vm.Script(b); } catch (e) { bad.push(i + ': ' + e.message); } });
      check('every script in the page compiles', blocks.length > 0 && bad.length === 0, bad);
      // Python's unittest ("Ran 11 tests ... OK") matched no pattern: a passing run
      // said nothing and a failing one said "exit 1".
      const tv = new vm.Script('(' + /function testVerdict\(text\)\{[\s\S]*?\n\}/.exec(H)[0] + ')').runInNewContext({});
      const ok = tv('test_a ... ok\n\n----------------------------------------------------------------------\nRan 11 tests in 0.004s\n\nOK\n');
      const bad2 = tv('FAIL: test_x\n----------------------------------------------------------------------\nRan 11 tests in 0.005s\n\nFAILED (failures=2, errors=1)\n');
      check('a unittest run is counted', ok && ok.passed === 11 && ok.failed === 0 && bad2 && bad2.passed === 8 && bad2.failed === 3, [ok, bad2]);
      check('pytest still is', JSON.stringify(tv('==== 5 passed, 2 failed in 0.12s ====')) === '{"passed":5,"failed":2}', tv('==== 5 passed, 2 failed in 0.12s ===='));
      check("keeping a copy is not called publishing", H.includes("case 'artifact_publish': return pick('file', 'Kept a copy of', 'Keeping a copy of');"), 'Published');
    }
    // Argument names from other tools: grep with `pattern` searched for "undefined"
    // (93 meaningless hits); read with `file_path` died on 'paths[1]'.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const gctx = { workdir: WD, session: { id: 'g', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const T = Object.fromEntries(buildTools(gctx).ALL.map((t) => [t.def.function.name, t]));
      fs.mkdirSync(path.join(WD, 'gsrc'), { recursive: true });
      fs.writeFileSync(path.join(WD, 'gsrc', 'one.js'), 'function finalizeStream() {}\nconst x = undefined;\n');
      fs.writeFileSync(path.join(WD, 'gsrc', 'blob.bin'), Buffer.from([0, 1, 2, 102, 105, 110, 97, 108, 105, 122, 101, 83, 116, 114, 101, 97, 109]));
      const g1 = await T.grep.run({ pattern: 'function finalizeStream', include: '*.js' }, gctx);
      check('grep understands `pattern`', g1.hits.length === 1 && g1.hits[0].line === 1, g1.hits);
      const g2 = await T.grep.run({ pattern: 'final\\w+Stream\\(' }, gctx);
      check('and treats it as a regular expression', g2.hits.some((h) => /one\.js$/.test(h.file)), g2.hits);
      check('binary files are not searched', !g2.hits.some((h) => /blob\.bin$/.test(h.file)), g2.hits);
      let g3 = null; try { await T.grep.run({}, gctx); } catch (e) { g3 = e.message; }
      check('nothing to find is explained, not a search for "undefined"', /grep needs `query`/.test(g3 || ''), g3);
      const r1 = await T.read.run({ file_path: 'gsrc/one.js' }, gctx);
      check('file_path works as path', r1.lines === 2, r1);
    }
    // The agent's remove erased files for good (unlink / rm -r).
    {
      const FS = read('src/backend/tools/fsops.js');
      check("the agent's remove goes to the Recycle Bin", FS.includes('await trash.trashItem(full);') && FS.includes("recycled: true") && FS.indexOf('await trash.trashItem(full);') < FS.indexOf('await fsp.unlink(full);'), 'erased');
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const rctx = { workdir: WD, session: { id: 'rm', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const fsT = buildTools(rctx).ALL.find((t) => t.def.function.name === 'fs');
      fs.writeFileSync(path.join(WD, 'gone.txt'), 'x');
      const r = await fsT.run({ action: 'remove', path: 'gone.txt' }, rctx);
      check('outside Electron it still removes', r.ok && !fs.existsSync(path.join(WD, 'gone.txt')), r);
    }
    // A 7 MB test log hit the 4 MB buffer: killed part-way, "exit 1", verdict lost. A
    // PNG read came back as mangled text. A write replaced a file never read.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const xctx = { workdir: WD, session: { id: 'edge', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const T = Object.fromEntries(buildTools(xctx).ALL.map((t) => [t.def.function.name, t]));
      fs.writeFileSync(path.join(WD, 'loud.js'), "for (let i = 0; i < 200000; i++) console.log('line ' + i + ' xxxxxxxxxxxxxxxxxxxxxxxxxxxx'); console.log('ALL 42 TESTS PASSED');");
      const loud = await T.shell.run({ command: 'node loud.js' }, xctx);
      check('a command with a lot of output runs to the end, with its real exit code', loud.exit === 0 && /ALL 42 TESTS PASSED\s*$/.test(loud.stdout), { exit: loud.exit, tail: loud.stdout.slice(-40) });
      check('and says the start of it is not shown', /earlier bytes of output are not shown/.test(loud.stdoutOmitted || ''), loud.stdoutOmitted);
      fs.writeFileSync(path.join(WD, 'pic.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex'));
      let rb = null; try { await T.read.run({ path: 'pic.png' }, xctx); } catch (e) { rb = e.message; }
      check('a binary file is named as one, not read as text', /pic\.png is a binary file .*png.*open it with the computer tool/.test(rb || ''), rb);
      fs.writeFileSync(path.join(WD, 'notes-user.txt'), 'important user notes\n');
      let wb = null; try { await T.write.run({ path: 'notes-user.txt', content: 'replaced\n' }, xctx); } catch (e) { wb = e.message; }
      check('a file never read is not overwritten', /already exists and you have not read it/.test(wb || '') && fs.readFileSync(path.join(WD, 'notes-user.txt'), 'utf8') === 'important user notes\n', wb);
      await T.read.run({ path: 'notes-user.txt' }, xctx);
      await T.write.run({ path: 'notes-user.txt', content: 'replaced\n' }, xctx);
      check('once read, it can be', fs.readFileSync(path.join(WD, 'notes-user.txt'), 'utf8') === 'replaced\n', 'refused');
      await T.write.run({ path: 'brand-new.txt', content: 'hi\n' }, xctx);
      await T.write.run({ path: 'brand-new.txt', content: 'hi again\n' }, xctx);
      check('a file it wrote itself can be written again', fs.readFileSync(path.join(WD, 'brand-new.txt'), 'utf8') === 'hi again\n', 'refused');
    }
    // A server started with `start /b` held the command's output open: the call never
    // returned, the time limit and Stop killed a shell that had already gone, and the
    // server outlived everything. Found in a live run.
    {
      const { buildTools } = require(path.join(ROOT, 'src/backend/tools/index.js'));
      const procs = require(path.join(ROOT, 'src/backend/tools/procs.js'));
      const pctx = { workdir: WD, session: { id: 'bg1', workdir: WD, messages: [], todos: [] }, emit: () => {}, resolveIn: (w, p) => path.resolve(w, p), checkPermission: async () => {} };
      const sh = buildTools(pctx).ALL.find((t) => t.def.function.name === 'shell');
      const nodeExe = JSON.stringify(process.execPath);
      const idle = `${nodeExe} -e "setInterval(()=>{},1000)"`;
      const t0 = Date.now();
      const held = await sh.run({ command: process.platform === 'win32' ? `start "" /b ${idle} && echo started` : `${idle} & echo started` }, pctx);
      check('a command that leaves something running still returns', Date.now() - t0 < 15000 && /started/.test(held.stdout), { ms: Date.now() - t0, held });
      check('and says what it left running', Array.isArray(held.stillRunning) && held.stillRunning.length >= 1 && /still running/.test(held.note || ''), held.stillRunning);
      check('which is tracked', procs.list('bg1').length >= 1, procs.list('bg1'));
      const srv = await sh.run({ background: true, command: `${nodeExe} -e "require('http').createServer((q,s)=>s.end('hi')).listen(0,()=>console.log('listening'))"` }, pctx);
      check('background: true starts it and returns with its first output', srv.background && srv.running && srv.pid > 0 && /listening/.test(srv.output), srv);
      const quick = await sh.run({ background: true, command: `${nodeExe} -e "console.log('bad config'); process.exit(4)"` }, pctx);
      check('one that exits at once says it is not running, and why', quick.running === false && quick.exit === 4 && /bad config/.test(quick.output), quick);
      const pids = procs.list().map((p) => p.pid);
      procs.stopAll();
      await new Promise((r) => setTimeout(r, 1500));
      const stillAlive = pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
      check('closing the app ends them all', stillAlive.length === 0 && procs.list().length === 0, stillAlive);
      check('the app does that when it quits', read('src/main/main.js').includes("app.on('will-quit', () => { try { require('../backend/tools/procs').stopAll(); } catch {} });"), 'left running');
      check('the row says it is running in the background', read('src/renderer/index.html').includes("if (o.background && o.running) return { html: 'running in background' };"), 'silent');
    }
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
    // New session: a typo made a session in a folder that does not exist, without a
    // word; the error went into a dialog that had already closed; Esc did nothing.
    {
      const H = read('src/renderer/index.html'), M = read('src/main/main.js');
      check('a session needs a folder that exists', M.includes("try { isDir = path.isAbsolute(dir) && fs.statSync(dir).isDirectory(); } catch { isDir = false; }") && M.includes("if (!isDir) return { ok: false, error: `There is no folder at ${dir"), 'made anyway');
      check('and the app says so where you are looking', H.includes("if (!created || created.ok === false) throw new Error((created && created.error) || 'Could not start a session.');") && H.includes('try { await newSession(dir); closeNewSess(); }'), 'closed first');
      check('the + on a project says so too', H.includes("newSession(k).catch((err) => toast(String(err && err.message || err)))"), 'unhandled');
      check('Esc closes the New session dialog', H.includes("if ($('newSessModalBg').classList.contains('show')) { e.preventDefault(); closeNewSess(); }"), 'stays open');
      check('and the Usage window, before Settings under it', H.includes("if ($('usageModalBg').classList.contains('show')) { e.preventDefault(); e.stopImmediatePropagation(); closeUsage(); return; }"), 'stays open');
      // The mic lit for a second and went out: no speech service in Electron, and the
      // error only reached the console.
      check('a mic that cannot work says so, and what to use', H.includes("if (e.error === 'network') micUnavailable = true;") && H.includes("if (msg) toast(msg);") && H.includes('Press Win+H in the message box to dictate'), 'silent');
      check('and does not try again', H.includes('if (!SR || micUnavailable) { toast(MIC_ERRORS.network);'), 'retries');
      check('a long message wraps instead of being cut off', H.includes('.toast-t{line-height:1.45;overflow-wrap:anywhere}'), 'cut');
    }
    // Images dropped on the window or pasted into the box are attached; other files are
    // explained (a dropped file once loaded in place of the app, then did nothing).
    {
      const H = read('src/renderer/index.html');
      check('a dropped image is attached', H.includes("document.addEventListener('drop', (e) => {") && H.includes('addImageFiles(e.dataTransfer.files);'), 'nothing');
      check('a pasted image is attached, text pastes as usual', H.includes("$('prompt').addEventListener('paste', (e) => {") && H.includes("if (!files.some((f) => /^image\\//i.test(f.type || ''))) return;"), 'nothing');
      check('a file that is not an image goes in as its path', H.includes('window.voxai.pathForFile(f)') && H.includes("ta.value = (ta.value && !/\\s$/.test(ta.value) ? ta.value + ' ' : ta.value) + paths.map(q).join(' ');"), 'dropped');
      check('"Keys saved" only when a key was typed', H.includes("flashSettingsSaved(('openrouterKey' in patch || 'managementKey' in patch) ? 'Keys saved' : 'Saved');"), 'always');
    }
    // Text that is not ours is text, not HTML: a queued message with an onerror
    // handler ran in the app's page (which holds the bridge).
    {
      const H = read('src/renderer/index.html');
      check('a queued message is drawn as text', H.includes("const t = el('span', 'q-text', esc(raw.slice(0, 64)") && H.includes("el('span', 'q-steer', '\\u21b3 ' + esc(String(item.steer)"), 'as HTML');
      check('model names from outside are drawn as text', H.includes("el('span','m', esc(r.model || ''))") && H.includes("el('span', 'sr-model', esc(r.model || ''))"), 'as HTML');
      const inl = new vm.Script('(' + /function inlineMd\(t\)\{[\s\S]*?\n\}/.exec(H)[0] + ')').runInNewContext({});
      check('a markdown link is only ever a web link', inl('[x](javascript:alert(1))').indexOf('<a') < 0 && inl('[x](https://a.test/p)') === '<a href="https://a.test/p" target="_blank" rel="noopener">x</a>', inl('[x](javascript:alert(1))'));
    }
    // The session menu: Export wrote out the OPEN session, not the one right-clicked,
    // and said so nowhere visible; Delete erased the file for good.
    {
      const H = read('src/renderer/index.html'), M = read('src/main/main.js');
      check('Export exports the session that was right-clicked', H.includes("if (act === 'export') { await exportSession(s.id); return; }") && !H.includes('exportActiveSession'), 'the open one');
      check('and says so, with a way to find the file', H.includes("toast('Exported “'") && H.includes("label: 'Show in folder', onClick: () => window.voxai.sessionsShowExport(id)") && M.includes("require('electron').shell.showItemInFolder(out);"), 'silent');
      check('the message can hide', H.includes('.toast[hidden]{display:none}'), 'always shown');
      check('Delete goes to the Recycle Bin', M.includes("const trash = (p) => require('electron').shell.trashItem(p);") && M.includes("await trash(path.join(store.sessionsDir(userData()), `${id}.jsonl`));") && !/deleteSessionFully[\s\S]{0,1500}store\.deleteSession/.test(M), 'erased');
      check('and a failed move deletes nothing and says why', M.includes("return { ok: false, error: 'Could not move it to the Recycle Bin: '") && H.includes("if (failed.length || (r && r.error)) alert(") && H.includes('to the Recycle Bin?'), 'silent');
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
      check('the notice is titled for it', read('src/renderer/index.html').includes("[/^Could not reach OpenRouter/, 'Could not reach OpenRouter'],"), 'generic title');
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
    // 0.2.27 shipped a 172 KB installer; Restart did nothing and said nothing.
    check('a Restart that does not install says so and downloads again', UP.includes("set({ state: 'error', error: 'The update could not be installed. It will be downloaded again.' });") && /setTimeout\(\(\) => \{\s*log\('the update did not install/.test(UP) && UP.includes('const INSTALL_WAIT_MS = 30 * 1000;'), 'silent');
    const RELX = read('scripts/release.js');
    check('a release refuses a build that did not finish', RELX.includes("if (!fs.existsSync(yml)) die('release/latest.yml is missing, so the build did not finish") && RELX.includes('does not match what the build recorded in latest.yml') && RELX.indexOf('latest.yml is missing') < RELX.indexOf('m.sig = signManifest'), 'publishes it');
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
    check('each build clears the last one first', /(^|&& )node scripts\/clean-release\.js$/.test(PKG.scripts.predist || ''), PKG.scripts);
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

  // ------------------------------------------------------------------ [CY]
  console.log('\n[CY] questions outlive a reload or restart, sessions stay small, search reads what was said');
  {
    const A = require(path.join(ROOT, 'src/backend/agent.js'));
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const ask = { questions: [{ question: 'Which style?', header: 'Style', options: [{ label: 'Pixel (Recommended)', description: 'Retro' }, { label: 'Vector' }] }] };
    const sess = { messages: [
      { role: 'user', content: 'make a game' },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'read', { path: 'a' }), call('c2', 'ask_user', ask), call('c3', 'write', { path: 'b', content: '' })] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ] };
    const pa = A.pendingAsk(sess);
    check('a question the app closed on is found', pa && pa.callId === 'c2' && pa.request.kind === 'ask' && pa.request.questions[0].options.length === 2, pa);
    check('answering it gives every call of that turn a result', A.answerPendingAsk(sess, 'c2', { answer: { answers: { 'Which style?': 'Pixel (Recommended)' } }, cancelled: false }) === true
      && sess.messages.length === 5 && JSON.parse(sess.messages[3].content).answers['Which style?'] === 'Pixel'
      && /not run/.test(sess.messages[4].content) && sess.messages[4].tool_call_id === 'c3', sess.messages.slice(3));
    check('an answered question is not asked again', A.pendingAsk(sess) === null && A.answerPendingAsk(sess, 'c2', { answer: 'x' }) === false, 'asked twice');
    const conf = { messages: [{ role: 'assistant', content: null, tool_calls: [call('k1', 'ask_confirm', { message: 'Delete build/?' })] }] };
    const pc = A.pendingAsk(conf);
    A.answerPendingAsk(conf, 'k1', { answer: 'no, keep it', cancelled: false });
    const cr = JSON.parse(conf.messages[1].content);
    check('a confirmation survives too, with the words it was declined in', pc && pc.request.kind === 'confirm' && cr.confirmed === false && cr.note === 'no, keep it', cr);
    check('a finished turn has nothing waiting', A.pendingAsk({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }) === null, 'phantom question');
    const MAIN = read('src/main/main.js'), HTML = read('src/renderer/index.html'), AG = read('src/backend/agent.js');
    check('a resumed run adds no message of its own', AG.includes('if (!resume) session.messages.push({'), 'pushes an empty message');
    check('the window asks what is waiting when a session opens', HTML.includes('  syncLive(v, full);') && /ipcMain\.handle\('agent:live'/.test(MAIN) && MAIN.includes('pendingAsk: ask'), 'lost on reload');
    check('an answer to a closed-on question carries the run on', HTML.includes('window.voxai.agentResumeAsk(') && /ipcMain\.handle\('agent:resume-ask'[\s\S]{0,600}launchRun\(\{ sessionId, text: '', attachments: \[\], resume: true \}\)/.test(MAIN), 'answer goes nowhere');
    check('a question is not drawn twice', HTML.includes('!(v.shownInputs && v.shownInputs.has(it.event.inputId))'), 'drawn twice');

    // Sessions stay small: sub-agents go with their conversation; screenshots saved as JPEG.
    check('deleting a conversation takes its sub-agents with it', /async function deleteSessionFully[\s\S]{0,2500}filter\(\(x\) => x\.parentId === id\)[\s\S]{0,200}await trash\(/.test(MAIN), 'left behind');
    check('orphaned sub-agent sessions are swept to the Recycle Bin', /if \(!s\.parentId \|\| live\.has\(s\.parentId\) \|\| fs\.existsSync\([\s\S]{0,200}trashItem/.test(MAIN), 'kept forever');
    check('screenshots are stored compacted', AG.includes('image_url: { url: compactImage(k.url) }') && /function compactImage\(/.test(AG), 'full PNGs');

    // Search reads the conversation, not just the titles.
    const store = require(path.join(ROOT, 'src/backend/sessions.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-search-'));
    const a = store.createSession({ workdir: UD, model: 'm', title: 'Game' });
    a.messages.push({ role: 'user', content: 'use a Tilemap for the dungeon' }, { role: 'assistant', content: 'The tilemap is in place.' }, { role: 'tool', tool_call_id: 'x', content: 'zebra' });
    const b = store.createSession({ workdir: UD, model: 'm', title: 'subagent:explore', parentId: a.id });
    b.messages.push({ role: 'user', content: 'tilemap' });
    const c = store.createSession({ workdir: UD, model: 'm', title: 'Other' });
    c.messages.push({ role: 'user', content: [{ type: 'text', text: '[VOX COMPACTED CONTEXT] tilemap' }] });
    for (const s of [a, b, c]) await store.saveSession(UD, s);
    const hits = await store.searchSessions(UD, 'TILEMAP');
    check('search finds what was said, in any case, with a snippet', hits.length === 1 && hits[0].id === a.id && hits[0].hits === 2 && /Tilemap/.test(hits[0].snippet), hits);
    check('tool output is not searched', (await store.searchSessions(UD, 'zebra')).length === 0, 'matched tool output');
    fs.rmSync(UD, { recursive: true, force: true });
    check('the Copy button sits outside the scrolling code', HTML.includes("const wrap = el('div', 'code-wrap');") && HTML.includes('.code-wrap{position:relative}'), 'scrolls away');

    // 0.2.42: prompts wait for you; sessions that need you are marked and reopened.
    check('a question waits for an answer, with no time limit', !/setTimeout\(\(\) => \{ pendingInputs\.delete/.test(MAIN) && MAIN.includes('pendingInputs.set(inputId, { sessionId, runKey, event, resolve });'), 'skipped after ten minutes');
    check('an approval waits too, in the app and the window', !/setTimeout\(\(\) => \{ pendingPerms\.delete\(permId\); resolve\(false\)/.test(MAIN) && HTML.includes('canAlways: !!canAlways, timer: null,'), 'lapses to no');
    check('a run that ends takes its open prompts with it', /controllers\.delete\(runKey\);\s*\/\/[^\n]*\n[^\n]*\n\s*for \(const \[k, p\] of pendingInputs\) if \(p\.runKey === runKey\)[\s\S]{0,200}for \(const \[k, p\] of pendingPerms\) if \(p\.runKey === runKey\)/.test(MAIN), 'left waiting forever');
    const UD2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-asking-'));
    const q1 = store.createSession({ workdir: UD2, model: 'm', title: 'asked' });
    q1.messages.push({ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [call('a1', 'read', {}), call('a2', 'ask_confirm', { message: 'ok?' })] }, { role: 'tool', tool_call_id: 'a1', content: '{}' });
    const q2 = store.createSession({ workdir: UD2, model: 'm', title: 'answered' });
    q2.messages.push({ role: 'assistant', content: null, tool_calls: [call('b1', 'ask_user', ask)] }, { role: 'tool', tool_call_id: 'b1', content: '{}' }, { role: 'assistant', content: 'done' });
    const q3 = store.createSession({ workdir: UD2, model: 'm', title: 'plain' });
    q3.messages.push({ role: 'assistant', content: null, tool_calls: [call('c1', 'read', {})] });
    for (const s of [q1, q2, q3]) { s.usage = [{ input: 1 }]; await store.saveSession(UD2, s); }
    const listed = Object.fromEntries((await store.listSessions(UD2)).map((s) => [s.title, s.asking]));
    check('the list knows which conversations end on an unanswered question', listed.asked === true && listed.answered === false && listed.plain === false, listed);
    fs.rmSync(UD2, { recursive: true, force: true });
    check('the app says which sessions need you', /ipcMain\.handle\('sessions:list'[\s\S]{0,900}waiting: open\.has\(s\.id\) \|\| \(!!s\.asking && !running\.has\(s\.id\)\)/.test(MAIN), 'not reported');
    check('the sidebar marks them "needs you"', HTML.includes('function sessWaiting(s){') && HTML.includes("waiting ? 'needs you' : relTime(s.updatedAt)") && HTML.includes('.dot.wait{'), 'unmarked');
    check('the mark follows the question as it opens and closes', HTML.includes("if (waitWas !== waitNow) { clearTimeout(setActivity._t); setActivity._t = setTimeout(renderSessionList, 0); }"), 'stale mark');
    check('two monitors side by side stay readable (fit 2560 x 1600, not 1280 wide)', AG.includes('const scale = Math.min(1, 2560 / width, 1600 / height);') && !AG.includes('img.resize({ width: 1280'), 'squeezed to 1280 x 360');
    const CU = read('src/backend/cu/index.js');
    check('a closed preview is said at once, not waited on for ten seconds', MAIN.includes('onAttachAtlas: () => { try { return atlasOpen && browserV') && CU.includes("if (!wc) throw new Error('Nothing is open in the preview"), 'waits 10 s');
    // One window, drawn by itself, whatever covers it.
    const NAT = read('src/backend/cu/native.js'), TIX = read('src/backend/tools/index.js');
    check('a window is captured by itself (PrintWindow), not copied off the screen', NAT.includes('$printed = [CU32]::PrintWindow($h, $hdc, 2)') && NAT.includes('$bmp = $full.Clone('), 'covered parts show');
    check('every visible window is listed, front to back, with its handle', NAT.includes('EnumWindows((h, l) => {') && NAT.includes('hwnd = [int64]$h') && !NAT.includes('Where-Object { $_.MainWindowHandle -ne 0 }'), 'one per process');
    check('a window is found by title, app name, handle or pid', NAT.includes('function Find-Window($Prm)') && NAT.includes('$_.title.ToLower().Contains($w) -or $_.app.ToLower().Contains($w)'), 'pid only');
    check('its own window and a hung one are not asked to draw (that hung for 90 s)', NAT.includes('if (-not $own -and -not $hung) { $printed = [CU32]::PrintWindow') && NAT.includes('self: process.pid'), 'hangs');
    check('minimised, no match and a blank capture are each said', NAT.includes('is minimised, and Windows does not draw a minimised window') && NAT.includes('No open window matches that. Windows open now:') && NAT.includes('(Test-Blank $bmp)'), 'silent');
    check('captures do not pile up in Temp', NAT.includes('try { fs.unlinkSync(p); } catch {}'), 'left in Temp');
    check('the computer tool takes a window, and says where it is on screen', CU.includes("window: { type: 'string', description: 'native: capture just this window") && CU.includes('Pixel (0,0) of this image is screen point') && TIX.includes('captures one window even when covered'), 'desktop only');
    check('a desktop or window capture is not called "Used the browser"', HTML.includes("pick('eye', 'Looked at a window', 'Looking at a window')") && HTML.includes("if (name === 'computer' && a.backend === 'native') return 'Using the desktop';"), 'browser');
    // The preview is a browser you can use: an address bar, pop-ups, and your say on websites.
    const addrSrc = (HTML.match(/function ppAddress\(raw, workdir\)\{[\s\S]*?\n\}\n/) || [''])[0];
    const ppAddress = addrSrc ? new Function(addrSrc + '; return ppAddress;')() : null;
    const B = String.fromCharCode(92);
    const got = ppAddress && ['example.com', 'localhost:5173/x', 'index.html', 'set up wrangler', 'https://a.b/c', 'C:' + B + 'p' + B + 'a.html'].map((x) => ppAddress(x, 'C:' + B + 'proj'));
    check('the address bar understands what is typed', !!got && JSON.stringify(got) === JSON.stringify(['https://example.com', 'http://localhost:5173/x', 'file:///C:/proj/index.html', 'https://duckduckgo.com/?q=set%20up%20wrangler', 'https://a.b/c', 'file:///C:/p/a.html']), got);
    check('the address is a field you can type in', HTML.includes('<input class="pp-urlmono" id="ppUrl" type="text"') && HTML.includes("if (u && document.activeElement !== u) u.value ="), 'read-only');
    check('a new-tab link opens in the preview; a sign-in pop-up is a window over the app', /browserV\.webContents\.setWindowOpenHandler\(\(\{ url, disposition \}\) => \{[\s\S]{0,300}if \(disposition !== 'new-window'\) \{ try \{ browserV\.webContents\.loadURL\(url\)[\s\S]{0,200}action: 'allow'[\s\S]{0,120}parent: win\(\)/.test(MAIN) && /sandbox: true, webSecurity: true/.test(MAIN), 'bare windows');
    check('the app\'s window is never mistaken for a pop-up', MAIN.includes('const w = mainWindow = new BrowserWindow({') && MAIN.includes("function win() { return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow"), 'first window');
    check('acting on a website asks you, even in Auto', AG.includes("if (name !== 'computer' || surface === 'native' || !['click', 'type', 'press'].includes(act)) return null;") && AG.includes("if (access === 'auto' && kind !== 'browser-act' && kind !== 'desktop-act') {") && AG.includes('const gate = (await browserGate(tc.name, args)) || permissionAsk(tc.name, args);'), 'auto-approved');
    check('local pages are not asked about that way', AG.includes("!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/i.test(u.hostname)"), 'asks for localhost');
    check('"Always" covers the site, and says so', MAIN.includes("const key = kind + '\\u0000' + String(alwaysKey || target || '');") && AG.includes('alwaysLabel: `Always on ${host}`') && HTML.includes("$('askAlways').textContent = p.alwaysLabel ||"), 'one action only');
    check('a password field\'s contents are never read for the prompt', AG.includes("(el.type !== 'password' && el.type !== 'hidden' ? el.value : '')") && AG.includes('Type into a password field'), 'shows the password');
    // Skills the agent knows about, can read whole, and can open the references of.
    {
      const SK = require(path.join(ROOT, 'src/backend/tools/skills.js'));
      const T0 = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-skills-'));
      const proj = path.join(T0, 'proj'), ud = path.join(T0, 'ud');
      const mk = (dir, name, fm, body) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), fm + '\n' + body); };
      mk(path.join(proj, '.voxai', 'skills'), 'deploy', '---\nname: deploy\ndescription: "How this project deploys."\n---', '# Deploy\nnpm run ship');
      mk(path.join(ud, 'skills'), 'deploy', '---\nname: deploy\ndescription: yours, shadowed by the project\n---', 'x');
      mk(path.join(ud, 'skills'), 'long', '---\nname: long\ndescription: >\n  A long skill\n  in two lines.\n---', 'A'.repeat(SK.PART_CHARS + 500));
      fs.mkdirSync(path.join(ud, 'skills', 'long', 'references', 'a'), { recursive: true });
      fs.writeFileSync(path.join(ud, 'skills', 'long', 'references', 'a', 'x.md'), 'ref x');
      const where = { workdir: proj, userData: ud };
      const found = await SK.findSkills(where);
      const dep = found.find((s) => s.name === 'deploy'), lng = found.find((s) => s.name === 'long');
      check('skills come from the project, yours and the app, the project first', dep && dep.source === 'project' && dep.description === 'How this project deploys.' && lng && lng.source === 'yours' && found.some((s) => s.source === 'built in'), found.map((s) => s.name + ':' + s.source));
      check('a description over several lines is read', lng && lng.description === 'A long skill in two lines.', lng && lng.description);
      const p1 = await SK.loadSkill('long', where), p2 = await SK.loadSkill('long', where, { part: 2 });
      check('a long skill comes whole, in parts, and says there is more', p1.content.length === SK.PART_CHARS && /1 of 2 -- load again with part 2/.test(p1.part) && p1.content + p2.content === fs.readFileSync(path.join(ud, 'skills', 'long', 'SKILL.md'), 'utf8') && p1.files.includes('references/a/x.md'), [p1.part, p2.content.length, p1.files]);
      const ref = await SK.loadSkill('long', where, { file: 'references/a/x.md' }), dirl = await SK.loadSkill('long', where, { file: 'references' });
      const esc = await SK.loadSkill('long', where, { file: '../deploy/SKILL.md' });
      check('its reference files open, and nothing outside its folder does', ref.ok && ref.content === 'ref x' && dirl.files[0] === 'references/a/x.md' && esc.ok === false, [ref, dirl, esc]);
      const idx = await SK.skillsIndex(where);
      check('the agent gets an index of what each skill is for', /^\[SKILLS\]/.test(idx) && idx.includes('- deploy: How this project deploys.') && idx.includes('- preview-browser: ') && idx.includes('- service-setup: '), idx.slice(0, 300));
      fs.rmSync(T0, { recursive: true, force: true });
    }
    check('the index is part of every run\'s context', AG.includes("const idx = await require('./tools/skills').skillsIndex({ workdir, userData });") && AG.includes('await loadDurableContext(session.workdir, userData)'), 'not told');
    check('the agent is told to load a matching skill, even to plan or advise', AG.includes('load the matching skill with the skill tool first, and prefer what it says to your own memory') && AG.includes('(/\\[SKILLS\\]/.test(durable)'), 'answers from memory');
    check('a skill is not cut to the usual result limit', AG.includes("tc.name === 'skill' ? Math.max(Number(toolResultMaxChars) || 0, 32000) : toolResultMaxChars"), 'middle lost');
    for (const b of ['preview-browser', 'service-setup']) {
      const t = read('resources/skills/' + b + '/SKILL.md');
      check('built-in skill ' + b + ' has a name and a description', SK_FM(t).name === b && SK_FM(t).description.length > 60, SK_FM(t));
    }
    check('the built-in skills say secrets never go through the chat', /never ask the user to paste a secret into the chat/i.test(read('resources/skills/service-setup/SKILL.md')) && /Never type a password/.test(read('resources/skills/preview-browser/SKILL.md')), 'missing');
    check('Settings has a Skills page with your folder', HTML.includes('<section class="set-page" data-set="skills" hidden>') && HTML.includes("if (key === 'skills') loadSkills();") && /ipcMain\.handle\('skills:openFolder'/.test(MAIN), 'no page');
    // Desktop control ported from Byte: named windows, controls by number, real input, safety.
    {
      const WI = require(path.join(ROOT, 'src/backend/cu/win-input.js'));
      const keys = WI.parseKeys('ctrl+shift+s');
      let winErr = '', unkErr = '';
      try { WI.parseKeys('win+r'); } catch (e) { winErr = e.message; }
      try { WI.parseKeys('ctrl+banana'); } catch (e) { unkErr = e.message; }
      check('shortcuts are parsed, and Windows-key ones refused', JSON.stringify(keys.map((k) => k.vk)) === '[17,16,83]' && /not allowed/.test(winErr) && /unknown key "banana"/.test(unkErr), [keys, winErr, unkErr]);
      const INP = read('src/backend/cu/win-input.js');
      check('typing is Unicode SendInput, not SendKeys', INP.includes('dwFlags: KEYEVENTF_UNICODE') && !INP.includes('SendKeys('), 'SendKeys');
      check('a window is brought to the front before keys go to it', INP.includes('send(key(0x12, false));') && INP.includes('a.SetForegroundWindow(hwnd);'), 'keys go to VoxAI');
      const DK = require(path.join(ROOT, 'src/backend/cu/desktop.js'));
      DK._states.set('t-desc', { elements: new Map([[3, { id: 3, name: 'Message', type: 'Edit' }], [4, { id: 4, name: 'Send', type: 'Button' }]]), target: null });
      const dt = DK.describe('t-desc', 'type', { index: 3, text: 'hello' }), dc = DK.describe('t-desc', 'click', { index: 4, button: 'right' }), dp = DK.describe('t-desc', 'press', { key: 'ctrl+s' });
      check('each desktop action is described for its approval', dt.target === 'Type "hello" into "Message"' && dc.target === 'Right-click "Send"' && dp.target === 'Press ctrl+s' && DK.describe('t-desc', 'state', {}) === null, [dt, dc, dp]);
      DK._states.delete('t-desc');
      check('password managers and private windows are not looked into', /password manager/.test(DK.privacyBlock({ app: 'Bitwarden.exe', title: 'Vault' })) && /private/.test(DK.privacyBlock({ app: 'msedge.exe', title: 'New tab - [InPrivate] - Microsoft Edge' })) && DK.privacyBlock({ app: 'notepad.exe', title: 'notes.txt - Notepad' }) === null, 'looked');
      check('coordinates follow the picture the model sees', DK.fitScale(1920, 1080) === 1 && DK.fitScale(3840, 1080) === 2560 / 3840, DK.fitScale(3840, 1080));
      const DS = read('src/backend/cu/desktop.js');
      check('moving the mouse stops it, except right after answering a prompt', DS.includes("if ((ctx && ctx.userAnswered) || !s.cursorAt) { s.cursorAt = now; return; }") && DS.includes('> MOVED_PX'), 'no guard');
      // Found by really moving the mouse mid-run: "Always for <app>" switched the check off (it was
      // skipped for every allowed call), and a move made while a step ran became the new baseline.
      check('"Always" does not switch the mouse check off: only a prompt the user answered does', MAIN.includes("has(key)) { resolve('always'); return; }") && AG.includes("ctx.userAnswered = allowed !== 'always';") && AG.includes('      ctx.userAnswered = false;\n') && !DS.includes('ctx.callApproved'), 'always = off');
      check('the pointer baseline moves only when the agent moves the pointer', DS.includes('const leftAt = (s, x, y) =>') && !/settle\(/.test(DS) && (DS.match(/leftAt\(s, /g) || []).length >= 6, 'rebaselined every step');
      // Found by clicking by position: a window's picture shows buttons that something covers on screen.
      check('a real click only lands where the window is really on top', DS.includes('async function pointOn(s, w, x, y, act)') && (DS.match(/await pointOn\(s, w, /g) || []).length === 6 && !/await input\.(click|scroll)\((?![^;]*=>)/.test(DS.replace(/\(\) => input\.(click|scroll)\(/g, '')) && INP.includes('function windowAt(x, y)'), 'clicks the taskbar');
      check('what is in the way is named, with a way round it', DS.includes("'the taskbar is over it there, so a real click would land on the taskbar'") && DS.includes('Store apps like Calculator ignore that'), 'silent');
      // Re-testing the fixes found these: a stop that outlived the user's "carry on", a click sent to a
      // point off every screen (it landed wherever the pointer was), and no way to see DPI awareness.
      DK._states.set('t-pause', { stopped: true, cursorAt: { x: 1, y: 1 }, elements: new Map() });
      DK.userAnswered('t-pause');
      const pz = DK._states.get('t-pause');
      DK._states.delete('t-pause');
      check('a mouse pause lifts once the user answers', pz.stopped === false && pz.cursorAt === null
        && AG.includes("if ((tc.name === 'ask_user' || tc.name === 'ask_confirm') && result && !result.cancelled) {") && AG.includes("require('./cu/desktop').userAnswered(session.id);")
        && DS.includes('Desktop control is paused because the user moved the mouse. Ask them (ask_user) whether to carry on'), pz);
      check('the pointer is checked to be where it was sent before any click or scroll', INP.includes('function pointAt(x, y) {') && INP.includes("if (!onScreen(px, py)) throw new Error(") && INP.includes('would not go to (')
        && /async function click\([^)]*\) \{\n  pointAt\(x, y\);/.test(INP) && /async function scroll\([^)]*\) \{\n  pointAt\(x, y\);/.test(INP) && !/a\.SetCursorPos\(Math\.round\(x\)/.test(INP), 'clicks wherever the pointer is');
      check('a point off every screen is on no window', INP.includes('if (!onScreen(x, y)) return null;') && INP.includes("MonitorFromPoint: user32.func(") && DS.includes("'that part of the window is off the screen, so it cannot be clicked'"), 'covered by its own window');
      check('the helper and the screenshot script report their DPI awareness', read('native/VoxUia.cs').includes('{ "dpi", Native.Awareness() }') && read('src/backend/cu/native.js').includes("method = 'desktop'; dpi = [CU32]::GetAwarenessFromDpiAwarenessContext("), 'unknown');
      check('the input module is per-monitor DPI aware in any process (tests match the app on a 125% screen)', INP.includes("user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t v)')(-4)"), 'scaled coordinates in tests');
      // Deleting: a running session is stopped and never saved back; its snapshots go too; many at once.
      {
        const st2 = require(path.join(ROOT, 'src/backend/sessions.js'));
        const SN = require(path.join(ROOT, 'src/backend/tools/snapshot.js'));
        const UDd = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-del-'));
        const sd = st2.createSession({ workdir: UDd, model: 'm', title: 'doomed' });
        sd.messages.push({ role: 'user', content: 'hi' });
        await st2.saveSession(UDd, sd);
        const file = path.join(st2.sessionsDir(UDd), sd.id + '.jsonl');
        fs.unlinkSync(file); st2.markDeleted(sd.id);
        sd.messages.push({ role: 'assistant', content: 'still running' });
        await st2.saveSession(UDd, sd);   // what a run still finishing does
        const sub = st2.createSession({ workdir: UDd, model: 'm', title: 'subagent', parentId: sd.id });
        await st2.saveSession(UDd, sub);
        check('a deleted session is not saved back by its run, nor are its sub-agents', !fs.existsSync(file) && !fs.existsSync(path.join(st2.sessionsDir(UDd), sub.id + '.jsonl')), fs.readdirSync(st2.sessionsDir(UDd)));
        fs.writeFileSync(file, fs.readFileSync(path.join(ROOT, 'package.json')).length ? JSON.stringify({ kind: 'meta', id: sd.id, title: 'doomed' }) : '');
        await st2.loadSession(UDd, sd.id); await st2.saveSession(UDd, sd);
        check('restored from the Recycle Bin and opened, it saves again', /still running/.test(fs.readFileSync(file, 'utf8')), 'stuck deleted');
        const proj = path.join(UDd, 'proj'); fs.mkdirSync(proj); fs.writeFileSync(path.join(proj, 'a.txt'), 'A');
        const other = st2.createSession({ workdir: proj, model: 'm', title: 'other' });
        const mine = await SN.createSnapshot({ userData: UDd, session: { id: sd.id, workdir: proj }, files: ['a.txt'] });
        const theirs = await SN.createSnapshot({ userData: UDd, session: { id: other.id, workdir: proj }, files: ['a.txt'] });
        const g = await SN.gatherSessionSnapshots(UDd, sd.id);
        const left = fs.readdirSync(SN.snapDir(UDd)).filter((f) => !f.startsWith('deleted-'));
        check('a deleted session\'s snapshots are gathered into one folder, and no one else\'s', g && g.snapshots === 1 && fs.readdirSync(g.folder).some((f) => f === mine.id + '.json') && fs.readdirSync(g.folder).length === 2
          && left.some((f) => f === theirs.id + '.json') && !left.some((f) => f.startsWith(mine.id)) && (await SN.gatherSessionSnapshots(UDd, 'nobody')) === null, [g, left]);
        fs.rmSync(UDd, { recursive: true, force: true });
      }
      check('deleting stops the session\'s runs and questions, and sends its sub-agents and snapshots to the Recycle Bin', /async function deleteSessionFully\(id\)[\s\S]{0,700}store\.markDeleted\(id\);[\s\S]{0,700}for \(const \[k, c\] of controllers\) if \(k\.startsWith\(id \+ ':'\)\) \{ try \{ c\.abort\(\);[\s\S]{0,600}pendingInputs[\s\S]{0,300}pendingPerms[\s\S]{0,1500}gatherSessionSnapshots\(userData\(\), id\)[\s\S]{0,120}await trash\(g\.folder\)/.test(MAIN)
        && MAIN.includes("ipcMain.handle('sessions:deleteMany'") && read('src/preload/preload.js').includes("sessionsDeleteMany: (ids) => ipcRenderer.invoke('sessions:deleteMany', ids),"), 'keeps running');
      check('sessions can be selected (Ctrl, Shift, a project\'s checkbox) and deleted together', HTML.includes('if (e.ctrlKey || e.metaKey) { toggleSel(s.id); return; }') && HTML.includes('if (e.shiftKey && SEL_ANCHOR) { selectRange(SEL_ANCHOR, s.id); return; }')
        && HTML.includes("box.onclick = (e) => { e.stopPropagation(); setSel(projIds, picked !== projIds.length); };") && HTML.includes('<div class="sel-bar" id="selBar" hidden>') && HTML.includes('.sel-bar[hidden]{display:none}')
        && HTML.includes("else if (e.key === 'Delete' && SEL.size) { e.preventDefault(); deleteSessions([...SEL]); }"), 'one at a time');
      check('a whole project\'s sessions can be deleted, saying its folder is untouched', HTML.includes('<button data-pact="delete">Delete all sessions here…</button>') && HTML.includes("' and its files stay exactly as they are.'"), 'no workspace delete');
      check('the confirmation says how many are running and that files are not touched', HTML.includes("still running and will be stopped first.") && HTML.includes("'No project files are touched.'"), 'vague');
      check('a deleted session leaves nothing on screen, and its last events are ignored', HTML.includes('try { updateSessStats(null); paintShelf(); paintPlanTray(); paintCtxBar(); updateSendState(); } catch {}') && HTML.includes("if (typeof DELETED_SIDS !== 'undefined' && DELETED_SIDS.has(sid)) return;"), 'Working… left up');
      check('a step of desktop work is headed "Used the desktop"', HTML.includes("return 'DESK';") && HTML.includes("else if (desk) { head = 'Used the desktop'; used.e = 1; }") && HTML.includes('const kind = kindName(name, args);'), 'browser');
      check('a password box is never typed into', DS.includes("if (e.password) throw new Error('that is a password box") && DS.includes("if (f && f.password) throw new Error("), 'types passwords');
      const CS = read('native/VoxUia.cs');
      check('the controls helper has no keyboard or mouse hooks, and knows real pixels', !/SetWindowsHookEx|class Recorder|class FocusGuard/.test(CS) && CS.includes('SetProcessDpiAwarenessContext(new IntPtr(-4))'), 'hooks');
      check('the helper is built and unpacked with the app, with koffi', PKG0.scripts.predist.includes('node scripts/build-uia.js') && PKG0.scripts.prestart.includes('node scripts/build-uia.js')
        && JSON.stringify(PKG0.build.asarUnpack) === JSON.stringify(['node_modules/koffi/**', 'node_modules/@koromix/**', 'resources/uia/**']) && !!PKG0.dependencies.koffi, PKG0.build.asarUnpack);
      check('the helper runs from outside the packed app', read('src/backend/cu/uia.js').includes(".replace(/app\\.asar([\\\\/])/, 'app.asar.unpacked$1')"), 'inside asar');
      check('desktop actions always ask, looking reads in words', AG.includes("return { kind: 'desktop-act', target: d.target") && AG.includes("kind !== 'desktop-act') {") && AG.includes("kind: 'desktop-look'") && HTML.includes("'desktop-act': 'Use your keyboard and mouse?'"), 'raw');
      check('Esc stops a run that is driving the desktop, and is let go after', MAIN.includes("if (ev.type === 'desktop_control') armDesktopEsc(runKey, ctl, ev.phase);") && MAIN.includes("globalShortcut.register('Escape'") && MAIN.includes('disarmDesktopEsc(runKey);   // Esc goes back to the apps'), 'no kill switch');
      check('Esc is held during a desktop action and 6 s after it ends, not 30 s', MAIN.includes('const ESC_AFTER_MS = 6000, ESC_DURING_MS = 60000;') && MAIN.includes("phase === 'end' ? ESC_AFTER_MS : ESC_DURING_MS") && !MAIN.includes('disarmDesktopEsc(runKey), 30000')
        && read('src/backend/cu/desktop.js').includes("async function after(s, ctx, w, did) {\n  busy(ctx, 'end');") && HTML.includes('Esc or moving the mouse stops it'), 'half a minute');
      // The page decides a computer step's surface by the tool's own rule, so a step of bare clicks is headed right.
      const surfSrc = (HTML.match(/function computerSurface\(v, a\)\{[\s\S]*?\n\}\n/) || [''])[0];
      const cs = surfSrc ? new Function(surfSrc + '; return computerSurface;')() : null;
      const vv = {};
      const seq = cs && [cs(vv, { action: 'state', window: 'Calculator' }), cs(vv, { action: 'click', index: 3 }), cs(vv, { action: 'open', url: 'https://a.b' }), cs(vv, { action: 'click', index: 1 }), cs(vv, { action: 'open', nativePath: 'C:/w/calc.exe' })];
      check('a step of desktop clicks without backend or window is headed as the desktop', !!seq && seq.join() === 'native,native,browser,browser,native' && HTML.includes("args = Object.assign({}, args, { backend: computerSurface(v, args) });"), seq);
      check('the skills say a stop cannot recall an action under way, and Google sign-in works', read('resources/skills/computer-use/SKILL.md').includes('A stop cannot recall an action already under way') && read('resources/skills/preview-browser/SKILL.md').includes('"Sign in with Google" works in the preview') && !read('resources/skills/preview-browser/SKILL.md').includes('is refused inside app browsers'), 'stale');
      check('the computer tool can focus a window', TIX.includes("focus: 'cu_focus',") && read('src/backend/tools/sandbox.js').includes("'cu_list', 'cu_focus',"), 'no focus');
      // From the npm start round: a result that is only text, Esc, Store apps, starting programs.
      check('the helper reports the text a window shows (a display, a label)', CS.includes('c.ControlType == ControlType.Text && texts.Count < 60') && CS.includes('{ "texts", texts }'), 'controls only');
      check('state and every step return that text, without glyphs or the controls\' own names', DS.includes('text = readText(r.texts, r.elements);') && DS.includes('...(text.length ? { text } : {}),') && DS.includes("String(t).trim().length > 1") && (DS.match(/readText\(r\.texts, r\.elements\)/g) || []).length === 2, 'unreadable');
      check('the agent\'s own Esc reaches the app instead of ending its run', DS.includes('if (esc) escHooks.suspend();') && MAIN.includes("require('../backend/cu/desktop').setEscHooks({"), 'kills itself');
      check('a Store app is named by its title, not its host', DK.appName({ app: 'ApplicationFrameHost.exe', title: 'Calculator' }) === 'Calculator' && DK.appName({ app: 'notepad.exe', title: 'x.txt - Notepad' }) === 'notepad', DK.appName({ app: 'ApplicationFrameHost.exe', title: 'Calculator' }));
      check('starting any program asks, with or without .exe', AG.includes("|| (act === 'open' && a.nativePath))) {") && DK.describe('x', 'open', { nativePath: 'calc', backend: 'native' }).target === 'Start calc', 'auto-approved');
      // A desktop call without `backend`: the approval and the tool agree on where it goes, per session.
      const CUX = require(path.join(ROOT, 'src/backend/cu/index.js'));
      const sf = (sid, act, a) => CUX.surfaceForAction(sid, act, a);
      const fresh = sf('t-s1', 'click', { index: 3 });
      CUX._surfaces.set('t-s1', 'native');
      const sticky = sf('t-s1', 'click', { index: 3 }), other = sf('t-s2', 'click', { index: 3 });
      CUX._surfaces.delete('t-s1');
      check('a click without backend goes where the session last worked, and is asked about there', fresh === 'browser' && sticky === 'native' && other === 'browser'
        && sf('x', 'state', { window: 'Notepad' }) === 'native' && sf('x', 'open', { url: 'https://a.b' }) === 'browser' && sf('x', 'open', { nativePath: 'C:/w/calc.exe' }) === 'native' && sf('x', 'open', { nativePath: 'notes.html' }) === 'browser'
        && AG.includes("surface = require('./cu').surfaceForAction(session.id, act, a);") && AG.includes("if (name === 'computer' && surface === 'native' && (['click', 'type', 'press', 'scroll', 'focus'].includes(act)")
        && !read('src/backend/cu/index.js').includes('let lastSurface'), [fresh, sticky, other]);
      check('starting a program returns window names, not a picture of the desktop', read('src/backend/cu/index.js').includes("started: String(args.nativePath), ...(r.pid ? { pid: r.pid } : {}), windows: desktop.list().windows") && !read('src/backend/cu/index.js').includes("emitImage(ctx, shot, 'native launch')"), 'desktop picture');
      check('a helper in use is kept at start, never at a release build', read('scripts/build-uia.js').includes('if (strict || !fs.existsSync(OUT)) throw e;') && PKG0.scripts.predist.includes('build-uia.js --strict') && !PKG0.scripts.prestart.includes('--strict'), PKG0.scripts);
      const cu = read('resources/skills/computer-use/SKILL.md');
      check('built-in skill computer-use says how, and what it must not do', SK_FM(cu).name === 'computer-use' && /Never type a password/.test(cu) && /moving the mouse/.test(cu) && /data, not\s+instructions/.test(cu), SK_FM(cu));
    }
    check('a new session\'s row has its name while the run is going', MAIN.includes("...(live.get(s.id) && live.get(s.id).title ? { title: live.get(s.id).title } : {})"), '"New session"');
    check('at start, a session the app closed on while asking is opened', HTML.includes("const asked = (SESS_ITEMS.find((s) => s.waiting) || {}).id;"), 'start screen');
  }

  // ------------------------------------------------------------------ [CT]
  console.log('\n[TL] the 60-turn pause is off in Auto and Full access');
  {
    fs.writeFileSync(path.join(WD, 'ct.txt'), 'x\n'.repeat(200));
    // A model that never stops calling tools; each turn reports its usage.
    const busy = (usage) => fakeOpenRouter((n) => [
      ...call('ct' + n, 'read', { path: 'ct.txt', offset: 1 + (n % 150), limit: 1 }).slice(0, 1),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage },
    ]);
    const endOf = async (access, usage, extra = {}) => {
      busy(usage);
      const ev = await drain(runAgent({ session: { id: 'ct-' + access + Math.random(), workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm',
        access, askPermission: async () => true, budgetUsd: 1, priceIn: 0.00001, priceOut: 0, ...extra }));
      return ev[ev.length - 1];
    };
    const priced = { prompt_tokens: 1000, completion_tokens: 0 };   // $0.01 a turn at the price above
    const auto = await endOf('auto', priced);
    const full = await endOf('full', priced);
    check('Auto runs past 60 turns and stops at the spend limit', auto.type === 'budget_reached' && auto.turns > 60, auto);
    check('Full access runs past 60 turns and stops at the spend limit', full.type === 'budget_reached' && full.turns > 60, full);
    const test = await endOf('test', priced);
    check('Edit and test still pauses at 60 turns', test.type === 'limit_reached' && test.turns === 60, test);
    const blind = await endOf('auto', { prompt_tokens: 1000, completion_tokens: 0 }, { priceIn: 0 });
    check('with no cost reported, Auto keeps the turn pause (the spend limit cannot bite)', blind.type === 'limit_reached' && blind.turns === 60 && /cannot be enforced/.test(blind.message), blind);
    const capped = await endOf('full', priced, { maxTurns: 5 });
    check('an explicit maxTurns still applies in Full access', capped.type === 'limit_reached' && capped.turns === 5, capped);
    const sub = await endOf('auto', priced, { isSubAgent: true });
    check('sub-agents keep their turn cap in Auto', sub.type === 'limit_reached' && sub.turns === 60, sub);
  }

  // ------------------------------------------------------------------ [KS]
  console.log('\n[KS] ending processes: by name always asks, its own by pid does not');
  {
    const MAIN = read('src/main/main.js');
    const HTML = read('src/renderer/index.html');
    const K = require(path.join(ROOT, 'src/backend/tools/kills.js'));
    const P = require(path.join(ROOT, 'src/backend/tools/procs.js'));
    const pk = K.processKills;
    check('taskkill /IM is a kill by name', JSON.stringify(pk('taskkill /IM electron.exe /F')) === JSON.stringify({ pids: [], names: ['electron.exe'], other: [] }), pk('taskkill /IM electron.exe /F'));
    check('taskkill /pid is a kill by pid', pk('taskkill /pid 1234 /T /F').pids[0] === 1234, pk('taskkill /pid 1234 /T /F'));
    check('Stop-Process -Name, Get-Process x | Stop-Process, pkill and killall are by name',
      pk('powershell -Command "Stop-Process -Name node -Force"').names[0] === 'node' && pk('Get-Process chrome | Stop-Process').names[0] === 'chrome'
      && pk('killall node').names[0] === 'node' && pk('pkill vite').names[0] === 'vite', 'by name');
    check('filters, patterns, ports and wmic are neither pid nor name (so they ask)',
      pk('taskkill /F /FI "WINDOWTITLE eq x"').other.length && pk('pkill -f vite').other.length && pk('npx kill-port 3000').other.length
      && pk('wmic process where name="x.exe" delete').other.length && pk('Get-Process | Where-Object CPU -gt 5 | Stop-Process').other.length, 'other');
    check('ordinary commands are not kills', ['npm run build', 'git commit -m fix', 'echo skill', 'npx vitest run', 'node taskkiller.js'].every((c) => pk(c) === null), 'false positive');
    check('only-kills tells a lone kill from a chain', K.onlyKills('taskkill /pid 5 /T /F >NUL 2>&1') && !K.onlyKills('taskkill /pid 5 /T /F & npm run build'), 'onlyKills');
    // Ownership, with a made-up process table: 900 started by the session, 901 its child, 950 someone else's.
    P.claim(900, 'ks-own');
    const table = new Map([[900, { ppid: 1, name: 'cmd.exe' }], [901, { ppid: 900, name: 'electron.exe' }], [950, { ppid: 1, name: 'electron.exe' }], [951, { ppid: 1, name: 'Code.exe' }]]);
    const own = await K.judgeKills(pk('taskkill /pid 901 /F'), 'ks-own', table);
    const other = await K.judgeKills(pk('taskkill /pid 950 /F'), 'ks-own', table);
    const byName = await K.judgeKills(pk('taskkill /IM electron.exe /F'), 'ks-own', table);
    check('a child of a process the session started is its own', own.own === true, own);
    check('someone else\'s pid is not, and the note names it', other.own === false && /pid 950 \(electron\.exe\)/.test(other.note), other);
    check('by name is never its own, even when it would also end its own; the note counts them', byName.own === false && /every process named electron\.exe \(2 running now\)/.test(byName.note) && /taskkill \/pid/.test(byName.hint), byName);

    // Through the agent: Full access asks (no Always) for a kill by name; Auto runs its own by pid.
    const ask = async (access, command, answer, sid) => {
      // By what the request holds, not by count: a call still in flight from an earlier test must not take the tool call.
      fakeOpenRouter((n, b) => (b.messages.some((m) => m.role === 'tool') ? say('done') : call('k1', 'shell', { command })));
      const asked = [];
      const ev = await drain(runAgent({ session: { id: sid || ('ks-' + access), workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access,
        askPermission: async (q) => { asked.push(q); return answer; }, maxTurns: 3 }));
      return { asked, end: ev.find((e) => e.type === 'tool_end' && e.name === 'shell') };
    };
    const full = await ask('full', 'taskkill /IM voxai-no-such-app.exe /F', false);
    check('Full access asks before a kill by name, without an Always button', full.asked.length === 1 && full.asked[0].noAlways === true && /every process named/.test(full.asked[0].note), full.asked);
    check('and a no tells the agent to end its own by pid', full.end && full.end.ok === false && /by its pid/.test(JSON.stringify(full.end.result)), full.end);
    const auto = await ask('auto', 'taskkill /IM voxai-no-such-app.exe /F', false);
    check('Auto never lets its safety check wave a kill by name through', auto.asked.length === 1 && auto.asked[0].noAlways === true, { asked: auto.asked, end: auto.end });
    check('and its no carries the same advice', auto.end && /by its pid/.test(JSON.stringify(auto.end.result)), auto.end);
    P.claim(987654, 'ks-auto-own');
    const mine = await ask('auto', 'taskkill /pid 987654 /T /F', false, 'ks-auto-own');
    check('Auto ends a process it started, by pid, without asking', mine.asked.length === 0, mine.asked);
    // A worker asks the user through the run that started it (it used to answer itself yes).
    const { makeSpawnTool } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));
    const workerAsk = async (parentAsk) => {
      let got = null;
      const runner = (opts) => { got = opts; return (async function* () { yield { type: 'done', content: 'ok' }; })(); };
      const UD2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-wk-'));
      const tool = makeSpawnTool({ runner, agentOpts: { workdir: WD, sessionId: 'wk', model: 'm', access: 'ask', ...(parentAsk ? { askPermission: parentAsk } : {}) }, userData: UD2, emit: () => {} });
      await tool.run('spawn_agent', { task: 'Add a clear command to todo.js' }, { workdir: WD, session: { id: 'wk' } });
      const r = await got.askPermission({ kind: 'shell', target: 'npm install left-pad', note: '' });
      try { fs.rmSync(UD2, { recursive: true, force: true }); } catch {}
      return r;
    };
    const heard = [];
    const yes = await workerAsk(async (q) => { heard.push(q); return true; });
    check('a worker\'s prompt reaches the user, marked as from a sub-agent with its task', yes === true && heard.length === 1 && heard[0].target === 'npm install left-pad'
      && /^From a sub-agent \(build\): Add a clear command to todo\.js\./.test(heard[0].note), heard);
    const no = await workerAsk(async () => false);
    check('and the user\'s no is the worker\'s no', no === false, no);
    check('with nobody to ask, a worker is refused, not waved through', (await workerAsk(null)) === false, 'no parent');
    check('the Sub-agents panel\'s workers ask in the session\'s box too', MAIN.includes('signal: ctl.signal, askPermission: panelAsk,') && !MAIN.includes('askPermission: async () => true')
      && MAIN.includes('function askPermissionFor(sessionId, runKey) {') && MAIN.includes('for (const [k, pp] of pendingPerms) if (pp.runKey === panelKey)'), 'main');
    check('several requests queue in the box instead of replacing each other', HTML.includes('if (!v.permQueue.some((q) => q.permId === permId)) v.permQueue.push(p);')
      && HTML.includes('if (v.permQueue && v.permQueue.length) { v.perm = v.permQueue.shift();'), 'page');
    check('programs opened on the desktop and every shell command are claimed as the session\'s own',
      read('src/backend/cu/index.js').includes("if (r.pid) require('../tools/procs').claim(r.pid, ctx && ctx.session && ctx.session.id);")
      && read('src/backend/cu/native.js').includes('-PassThru') && read('src/backend/tools/index.js').includes('procs.claim(child.pid, ctx.session && ctx.session.id);'), 'claims');
    check('the prompt can hide Always, and a yes is never remembered', MAIN.includes('canAlways: !noAlways') && MAIN.includes('if (v && always && !noAlways) {'), 'main');
  }

  // ------------------------------------------------------------------ [VH]
  console.log('\n[VH] a model that cannot see gets screenshots described');
  {
    const MAIN = read('src/main/main.js');
    const HTML = read('src/renderer/index.html');
    const { describeScreenshot } = require(path.join(ROOT, 'src/backend/agent.js'));
    let sent = null;
    global.fetch = async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'A settings page. The Update rate control overflows its card on the right.' } }], usage: { cost: 0.0012 } }) };
    };
    const d = await describeScreenshot({ apiKey: 'k', model: 'vision/model', url: 'data:image/png;base64,AAAA', about: 'computer {"action":"screenshot"}', request: 'fix the layout' });
    check('the picture goes to the helper model, with what to look for', sent && sent.model === 'vision/model' && sent.messages[0].content[1].image_url.url === 'data:image/png;base64,AAAA'
      && /overflowing/.test(sent.messages[0].content[0].text) && /fix the layout/.test(sent.messages[0].content[0].text), sent && sent.model);
    check('its description and cost come back', /overflows its card/.test(d.text) && d.cost === 0.0012, d);
    global.fetch = async () => { throw new Error('offline'); };
    const bad = await describeScreenshot({ apiKey: 'k', model: 'vision/model', url: 'data:image/png;base64,AAAA', about: 'x', request: '' });
    check('a failed description falls back quietly', bad.text === '' && bad.cost === 0, bad);
    const AG2 = read('src/backend/agent.js');
    check('the run uses it only when the model cannot see, and counts its cost', AG2.includes('if (modelVision !== true && visionHelper) {') && AG2.includes("source: 'screenshot description'"), 'agent.js');
    check('it is on by default with a model that can see, and can be turned off', MAIN.includes("visionHelperModel: typeof raw.visionHelperModel === 'string' ? raw.visionHelperModel : 'deepseek/deepseek-v4.1-flash',")
      && HTML.includes('id="fVisionHelper"') && HTML.includes("patch.visionHelperModel = $('fVisionHelper').value.trim();"), 'settings');
  }

  // ------------------------------------------------------------------ [GL]
  console.log('\n[GL] /goal keeps going until a separate check says it is met');
  {
    const MAIN = read('src/main/main.js');
    const HTML = read('src/renderer/index.html');
    const G = require(path.join(ROOT, 'src/backend/goal.js'));
    check('/goal parses set, show and clear', G.parseGoalCommand('/goal all tests pass').condition === 'all tests pass' && G.parseGoalCommand('/goal').op === 'show'
      && ['clear', 'stop', 'off', 'reset', 'none', 'cancel'].every((w) => G.parseGoalCommand('/goal ' + w).op === 'clear') && G.parseGoalCommand('goal x') === null, 'parse');
    const g = G.newGoal('tests pass', 0);
    check('a run that did work is checked', G.afterRun(g, 'done', { tools: 3, cost: 0.1 }, 5).next === 'check' && g.runs === 1 && g.tools === 3, g);
    check('a run stopped at a limit carries straight on', G.afterRun(g, 'limit_reached', { tools: 60, cost: 0.2 }, 5).next === 'continue'
      && G.afterRun(g, 'budget_reached', { tools: 9, cost: 1 }, 5).next === 'continue', g);
    const g2 = G.newGoal('x', 0);
    const idle = [1, 2, 3].map(() => G.afterRun(g2, 'done', { tools: 0, cost: 0 }, 5).next);
    check('three answers in a row with no work pause it', idle.join() === 'check,check,pause', idle);
    const g3 = G.newGoal('x', 0);
    check('Stop, a failed run and the goal\'s spend limit pause it', G.afterRun(G.newGoal('x', 0), 'cancelled', { tools: 1 }, 5).next === 'pause'
      && G.afterRun(G.newGoal('x', 0), 'error', { tools: 1 }, 5).next === 'pause' && G.afterRun(g3, 'done', { tools: 1, cost: 5.01 }, 5).next === 'pause', g3);
    const g4 = G.newGoal('ship it', 0);
    const nm = G.applyCheck(g4, { verdict: 'not_met', reason: 'No cbx submit output shows the save.', cost: 0.001 });
    check('not met: the next run is told what is missing', nm.next === 'continue' && /^\[VOX GOAL\] Not met yet: No cbx submit output/.test(nm.message) && /ship it/.test(nm.message), nm);
    check('met and impossible end it', G.applyCheck(G.newGoal('a', 0), { verdict: 'met', reason: 'ok' }).next === 'end'
      && G.applyCheck(G.newGoal('a', 0), { verdict: 'impossible', reason: 'no' }).next === 'end', 'end');
    check('a check that fails pauses rather than guessing', G.applyCheck(G.newGoal('a', 0), { verdict: null, reason: 'x', error: true }).next === 'pause', 'err');
    const msgs = [
      { role: 'user', content: 'before the goal' },
      { role: 'user', content: 'Goal: tests pass' },
      { role: 'assistant', content: 'Running them.', tool_calls: [{ id: 't', function: { name: 'shell', arguments: '{"command":"npm test"}' } }] },
      { role: 'tool', tool_call_id: 't', content: '{"exit":0,"stdout":"42 passed"}' },
      { role: 'user', content: [{ type: 'text', text: '[VOX TOOL SCREENSHOTS] 1 screenshot' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
    ];
    const tr = G.goalTranscript(msgs, 1);
    check('the checker reads from the goal on: calls and results, not pictures', !/before the goal/.test(tr) && /TOOL CALL shell: \{"command":"npm test"\}/.test(tr) && /TOOL RESULT: .*42 passed/.test(tr) && !/SCREENSHOTS/.test(tr), tr);
    let asked = null;
    const fake = async (req) => { asked = req; return { choices: [{ message: { content: 'Sure: {"verdict":"not_met","reason":"Run the app from fresh."}' } }], usage: { cost: 0.002 } }; };
    const v1 = await G.evaluateGoal({ apiKey: 'k', model: 'm', goal: G.newGoal('tests pass and the app starts', 1), messages: msgs, chat: fake });
    check('the check judges evidence, not the agent\'s word', /not evidence unless a tool/.test(asked.messages[0].content) && /GOAL: tests pass and the app starts/.test(asked.messages[1].content), asked && asked.messages[0].content.slice(0, 80));
    check('its answer is read even with words around the JSON', v1.verdict === 'not_met' && v1.reason === 'Run the app from fresh.' && v1.cost === 0.002, v1);
    const v2 = await G.evaluateGoal({ apiKey: 'k', model: 'm', goal: G.newGoal('x', 0), messages: [], chat: async () => ({ choices: [{ message: { content: 'probably fine' } }] }) });
    check('no clear answer is an error, not a pass', v2.verdict === null && v2.error === true, v2);
    const { goalPrompt } = require(path.join(ROOT, 'src/backend/agent.js'));
    check('while a goal is on, the agent is told it is checked on evidence', /GOAL \(set by the user with \/goal\): ship it/.test(goalPrompt(G.newGoal('ship it', 0))) && goalPrompt({ status: 'met', condition: 'x' }) === '', 'prompt');
    const SS = require(path.join(ROOT, 'src/backend/sessions.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-goal-'));
    const gs = { id: 'goal-save', title: 't', workdir: WD, model: 'm', messages: [{ role: 'user', content: 'hi' }], todos: [], goal: G.newGoal('persist me', 1) };
    await SS.saveSession(UD, gs);
    const back = await SS.loadSession(UD, 'goal-save');
    check('a goal is saved with its session and read back', back.goal && back.goal.condition === 'persist me' && back.goal.status === 'active', back.goal);
    try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}
    check('main runs the loop after each run, and never alongside a run you started', MAIN.includes("goalStep(sessionId, runEnd, { tools: runTools, cost: runCost })")
      && MAIN.includes("if ([...controllers.keys()].some((k) => k.startsWith(sessionId + ':'))) return;") && MAIN.includes("if (!goalContinue && sess.goal && sess.goal.status === 'active') { sess.goal.paused = false;"), 'main');
    check('the page: /goal in the box, a goal bar, Stop pauses it, its messages are not your bubbles',
      HTML.includes("if (/^\\/goal(\\s|$)/i.test(text) && !v.pendingAsk) { await goalCommand(v, text); return; }") && HTML.includes('id="shGoal"')
      && HTML.includes("try { window.voxai.goalPause(v.id); } catch {}") && HTML.includes("if (/^\\[VOX GOAL\\]/.test(first)) {"), 'page');
  }

  // ------------------------------------------------------------------ [OW]
  console.log('\n[OW] its own window is drawn by the app; workers are named by their task');
  {
    const MAIN = read('src/main/main.js');
    const { taskSummary } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));
    const noisy = 'You are in a Windows environment using cmd.exe as your shell (no bash: use dir/type, chain with &&). Your working directory is C:/w/p. Create hello.txt containing hi.';
    check('setup the model put in front of a task is skipped', taskSummary(noisy, 90) === 'Create hello.txt containing hi.', taskSummary(noisy, 90));
    check('a plain task is kept as it is, and a long one is cut with an ellipsis', taskSummary('Look at todo.js for bugs in the done command.') === 'Look at todo.js for bugs in the done command.'
      && /\u2026$/.test(taskSummary('Refactor '.repeat(30), 40)) && taskSummary('Refactor '.repeat(30), 40).length === 40, taskSummary('Refactor '.repeat(30), 40));
    check('a task that is only setup still says something', taskSummary('You are a reviewer.') === 'You are a reviewer.', taskSummary('You are a reviewer.'));
    const SPW = read('src/backend/tools/spawn.js');
    check('approvals, worker cards and the spawn prompt all use it', SPW.includes('${endSentence(taskSummary(task.task, 90))}') && SPW.includes('label: taskSummary(task.task, 90)')
      && read('src/backend/agent.js').includes("require('./tools/spawn').taskSummary(t.task, 400)") && MAIN.includes("require('../backend/tools/spawn').taskSummary(task, 90)"), 'labels');

    const D = require(path.join(ROOT, 'src/backend/cu/desktop.js'));
    let askedFor = null;
    D.setOwnCapture(async (hwnd) => { askedFor = hwnd; return { dataUrl: 'data:image/png;base64,AAAA', x: 10, y: 20, w: 300, h: 200 }; });
    const shot = await D._shotOf({ hwnd: 4242, pid: process.pid, title: 'VoxAI Coder', app: 'electron' });
    check('a picture of its own window comes from the app, with where it is on screen', askedFor === 4242 && shot.ok && shot.method === 'app' && shot.x === 10 && shot.w === 300
      && /drawn by the app itself/.test(shot.note), shot);
    D.setOwnCapture(null);
    check('main draws the chat and pastes the preview into its slot, in screen pixels', MAIN.includes('const base = await chatV.webContents.capturePage();')
      && MAIN.includes('const img = await browserV.webContents.capturePage();') && MAIN.includes('const r = screen.dipToScreenRect(w, cb);')
      && MAIN.includes("require('../backend/cu/desktop').setOwnCapture(captureOwnWindow);"), 'main');
    const DS = read('src/backend/cu/desktop.js');
    check('state, after-action pictures and screenshot all go through it', (DS.match(/const shot = await shotOf\(w\);/g) || []).length === 2 && DS.includes('const shot = target ? await shotOf(target,')
      && read('src/backend/cu/index.js').includes('const s = await desktop.screenshot(args, ctx);'), 'callers');
    check('its own window can be found for a picture, but is never remembered as the one to act on', DS.includes('findWindow(args.window, { includeOwn: true })')
      && DS.includes('if (!target.own) s.target = target.hwnd;') && DS.includes("const ws = includeOwn ? input.listWindows() : visibleWindows();")
      && DS.includes("thisApp: 'this app -- screenshot only, not state or clicks'"), 'lookup');
    check('the fake model answers by the turn a request carries, not by counting requests', /const n = \(body\.messages \|\| \[\]\)\.filter\(\(m\) => m && m\.role === 'assistant'\)\.length \+ 1;/.test(read('test/regression-refit.js')), 'fake');
  }

  // ------------------------------------------------------------------ [CO]
  console.log('\n[CO] a reply cut off at the output limit is said, and work carries on in smaller steps');
  {
    const cutNothing = [{ choices: [{ delta: { reasoning: 'thinking about the whole app...' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }];
    const cutWrite = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write', arguments: '{"path":"monitor.py","content":"import psutil\\nclass Mon' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] }];
    const bodies = [];
    fakeOpenRouter((n, b) => { bodies.push(b); return n === 1 ? cutNothing : say('done'); });
    const ev1 = await drain(runAgent({ session: { id: 'co1', workdir: WD, messages: [] }, userText: 'build it', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 5 }));
    const note1 = bodies[1] && bodies[1].messages.find((m) => m.role === 'user' && /^\[VOX CUTOFF\]/.test(String(m.content)));
    check('cut off while still thinking: the next turn is told so, and the run goes on', ev1[ev1.length - 1].type === 'done' && note1 && /the thinking used it all up/.test(note1.content) && /at most about 300 lines per write/.test(note1.content), note1 && note1.content);
    check('and it is shown as carrying on, not as "an empty answer twice"', ev1.some((e) => e.code === 'output-cutoff-retry') && !ev1.some((e) => e.code === 'empty-answer'), ev1.map((e) => e.code).filter(Boolean));
    fs.rmSync(path.join(WD, 'monitor.py'), { force: true });
    const bodies2 = [];
    fakeOpenRouter((n, b) => { bodies2.push(b); return n === 1 ? cutWrite : say('done'); });
    const ev2 = await drain(runAgent({ session: { id: 'co2', workdir: WD, messages: [] }, userText: 'build it', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 5 }));
    const note2 = bodies2[1] && bodies2[1].messages.find((m) => m.role === 'user' && /^\[VOX CUTOFF\]/.test(String(m.content)));
    check('cut off mid-write: the half-written call is not run, and the note names the file', !fs.existsSync(path.join(WD, 'monitor.py')) && !ev2.some((e) => e.type === 'tool_start')
      && note2 && /while writing a write call for monitor\.py, so it was not run/.test(note2.content), note2 && note2.content);
    fakeOpenRouter(() => cutNothing);
    const ev3 = await drain(runAgent({ session: { id: 'co3', workdir: WD, messages: [] }, userText: 'build it', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 10 }));
    const last3 = ev3[ev3.length - 1];
    check('three cut-offs in a row end the run with a plain reason', last3.type === 'error' && /cut off at its 16,384-token output limit three times in a row/.test(last3.message), last3);
    const AGC = read('src/backend/agent.js');
    check('the turn after a cut-off thinks less, and only that turn', AGC.includes("effortNext = 'low';") && AGC.includes('reasoningEffort: effortNext || reasoningEffort,') && AGC.includes('effortNext = null;   // the lower level was for one turn'), 'effort');
    check('the prompt says to build a file at a time', AGC.includes('Build big things a file at a time: at most about 300 lines per write'), 'prompt');
    const HTMLc = read('src/renderer/index.html');
    check('reopened, the note is a line, not your message', HTMLc.includes("if (/^\\[VOX CUTOFF\\]/.test(first)) {"), 'page');
  }

  // ------------------------------------------------------------------ [KX]
  console.log('\n[KX] kills written as code are kills; a refused kill stays refused');
  {
    const K = require(path.join(ROOT, 'src/backend/tools/kills.js'));
    const pk = K.processKills;
    const P = require(path.join(ROOT, 'src/backend/tools/procs.js'));
    check('os.kill, process.kill, psutil and (Get-Process -Id).Kill() name the pid they end',
      pk('python -c "import os, signal; os.kill(20340, signal.SIGTERM)"').pids[0] === 20340 && pk('node -e "process.kill(20340)"').pids[0] === 20340
      && pk('python -c "import psutil; psutil.Process(20340).terminate()"').pids[0] === 20340 && pk('powershell -Command "(Get-Process -Id 20340).Kill()"').pids[0] === 20340,
      [pk('python -c "import os; os.kill(20340, 9)"'), pk('node -e "process.kill(20340)"')]);
    check('a script that kills by searching is a kill too', pk('python -c "import psutil; [p.kill() for p in psutil.process_iter()]"').other.length > 0
      && pk('python -c "import ctypes; ctypes.windll.kernel32.TerminateProcess(h, 0)"').other.length > 0, 'script');
    check('one-liners that end nothing are not kills', pk('python -c "print(1)"') === null && pk('node -e "console.log(process.pid)"') === null
      && pk('python -c "import os; print(os.getpid())"') === null, 'false positive');
    check('a refusal is remembered by what it aims at', K.killKeys({ pids: [20340], names: ['pythonw.exe'], other: [] }).join() === 'pid:20340,name:pythonw', 'keys');
    const AGK = read('src/backend/agent.js');
    check('the prompt and the refusal say what the process really is', /function whatIs\(d, row\)/.test(read('src/backend/tools/kills.js'))
      && read('src/backend/tools/kills.js').includes('it is NOT a program you started, so it is not your app.'), 'identity');
    // Through the agent: refused once, the same pid by another command is refused without asking.
    const asked = [];
    let turn = 0;
    fakeOpenRouter((n, b) => {
      turn = n;
      if (n === 1) return call('x1', 'shell', { command: 'taskkill /pid 987650 /T /F' });
      if (n === 2) return call('x2', 'shell', { command: 'python -c "import os; os.kill(987650, 15)"' });
      return say('ok, leaving it');
    });
    const sess = { id: 'kx-sess', workdir: WD, messages: [] };
    const ev = await drain(runAgent({ session: sess, userText: 'restart my app', apiKey: 'k', model: 'm', access: 'full', askPermission: async (q) => { asked.push(q); return false; }, maxTurns: 5 }));
    const ends = ev.filter((e) => e.type === 'tool_end');
    check('refused once, the same pid through os.kill is refused without asking again', asked.length === 1 && ends.length === 2 && ends.every((e) => e.ok === false)
      && /already said no to ending PID 987650/.test(JSON.stringify(ends[1].result)) && /not with another command, not by asking them/.test(JSON.stringify(ends[1].result)), { asked: asked.length, ends: ends.map((e) => String(JSON.stringify(e.result)).slice(0, 160)) });
    const { isReadOnlyCommand: ro } = require(path.join(ROOT, 'src/backend/tools/sandbox.js'));
    check('its own kill with only a pause or a look after it counts as a lone kill', K.harmlessBesidesKills('taskkill /pid 3816 /T /F 2>&1 & ping -n 2 127.0.0.1 >NUL', ro)
      && K.harmlessBesidesKills('taskkill /pid 5 /F & tasklist', ro) === false && K.harmlessBesidesKills('taskkill /pid 5 /F & dir', ro)
      && !K.harmlessBesidesKills('taskkill /pid 5 /F & npm run build', ro) && !K.harmlessBesidesKills('ping -n 2 127.0.0.1', ro), 'chains');
    P.claim(987700, 'kx-own-chain');
    const askedC = [];
    fakeOpenRouter((n) => (n === 1 ? call('c1', 'shell', { command: 'taskkill /pid 987700 /T /F 2>&1 & ping -n 2 127.0.0.1 >NUL' }) : say('restarted')));
    await drain(runAgent({ session: { id: 'kx-own-chain', workdir: WD, messages: [] }, userText: 'restart the app', apiKey: 'k', model: 'm', access: 'auto', askPermission: async (q) => { askedC.push(q); return false; }, maxTurns: 3 }));
    check('so in Auto it goes through without asking', askedC.length === 0, askedC);
    check('and the Auto check is told which processes are the session\'s own', AGK.includes('Processes this session started itself (ending these by pid is its own business)'), 'auto check');
    check('the session keeps the refusal', sess._refusedKills && sess._refusedKills.has('pid:987650') && AGK.includes('const again = keys.filter((k) => refused.has(k));'), sess._refusedKills && [...sess._refusedKills]);
  }

  // ------------------------------------------------------------------ [EY]
  console.log('\n[EY] a model that cannot see says where its screenshots go');
  {
    const HTML = read('src/renderer/index.html');
    const src = /function screenshotNote\(id\)\{[\s\S]*?\n\}/.exec(HTML);
    check('there is one place that words it', !!src, 'no screenshotNote');
    const models = {
      'text/only': { id: 'text/only', vision: false },
      'sees/images': { id: 'sees/images', vision: true },
      'deepseek/deepseek-v4.1-flash': { id: 'deepseek/deepseek-v4.1-flash', vision: true, name: 'DeepSeek: V4.1 Flash' },
    };
    const make = (helper) => vm.runInNewContext(`(() => { ${src[0]}; return screenshotNote; })()`, {
      S: { visionHelperModel: helper }, activeModel: () => 'text/only',
      modelEntry: (id) => models[id] || null, describeModel: (m) => ({ name: m.id === 'deepseek/deepseek-v4.1-flash' ? 'DeepSeek V4.1 Flash' : m.id }),
    });
    const on = make('deepseek/deepseek-v4.1-flash')('text/only');
    check('text-only model: "can\'t see screenshots, routed to" the image model, by name', on && /^Can’t see screenshots — they’re routed to DeepSeek V4\.1 Flash, an image model, which describes them for this model\.$/.test(on.text)
      && on.short === 'Can’t see screenshots — routed to DeepSeek V4.1 Flash', on);
    check('a model that can see says nothing', make('deepseek/deepseek-v4.1-flash')('sees/images') === null, 'sees');
    const off = make('')('text/only');
    check('describing turned off says so', off && /describing them is turned off in Settings/.test(off.text), off);
    check('it shows above the box, and when the model is picked', HTML.includes('id="shEyes"') && HTML.includes("const eyes = $('shEyes'), en = screenshotNote();")
      && HTML.includes('  const en = screenshotNote(id);\n  if (en) toast(en.text);'), 'places');
    check('the picker footer is one fixed line with the model\'s full name, nothing else', HTML.includes('<span class="pk-foot" id="modelMenuFoot" aria-live="polite"><span class="fid" id="pkId"></span></span>')
      && HTML.includes("$('pkId').textContent = id ? ((m && m.name) || id) : '';") && HTML.includes('.pk-foot{display:flex;align-items:center;border-top:1px solid var(--edge);padding:0 12px;height:30px;')
      && !HTML.includes('pkFacts') && !HTML.includes('function modelFacts('), 'footer');
  }

  // ------------------------------------------------------------------ [SC]
  console.log('\n[SC] slash commands: /review /init /rewind /loop, and the "/" menu');
  {
    const C = require(path.join(ROOT, 'src/backend/commands.js'));
    check('the four commands parse, and anything else is not one', C.parseCommand('/review auth code').name === 'review' && C.parseCommand('/review auth code').rest === 'auth code'
      && C.parseCommand('/init').name === 'init' && C.parseCommand('/rewind').name === 'rewind' && C.parseCommand('/loop 5m check').name === 'loop'
      && C.parseCommand('/nope') === null && C.parseCommand('review') === null, 'parse');
    const L = C.parseLoop('5m check the build');
    check('/loop reads its interval (a minute to a day) and defaults to 10 min', L.ms === 300000 && L.task === 'check the build' && C.parseLoop('check it').ms === 600000
      && C.parseLoop('10s x').ms === 60000 && C.parseLoop('every 2 hours, tidy up').ms === 7200000 && C.parseLoop('every 2 hours, tidy up').task === 'tidy up'
      && C.parseLoop('stop').stop === true && C.every(300000) === '5 min', [L, C.parseLoop('10s x')]);
    const rv = C.reviewPrompt('error handling');
    check('/review asks for a review of the uncommitted diff and says not to change anything', /^\[VOX CMD\] \/review error handling\n/.test(rv) && /git status and git diff/.test(rv) && /do not change any files/.test(rv), rv.slice(0, 80));
    check('/init asks for AGENTS.md with checked commands', /^\[VOX CMD\] \/init\n/.test(C.initPrompt()) && /write AGENTS\.md in its root/.test(C.initPrompt()) && /checked by running the quick ones/.test(C.initPrompt()), 'init');

    // Checkpoints: a run edits one file and creates another; /rewind puts it back.
    const CP = require(path.join(ROOT, 'src/backend/tools/checkpoints.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cp-'));
    const PD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cpp-'));
    fs.writeFileSync(path.join(PD, 'app.js'), 'old\n');
    const sess = { id: 'cp-s', workdir: PD };
    CP.startRun(sess);
    await CP.before(UD, sess, CP.pathsOf('edit', { path: 'app.js' }));
    await CP.before(UD, sess, CP.pathsOf('write', { path: 'new/extra.js' }));
    await CP.before(UD, sess, CP.pathsOf('edit', { path: 'app.js' }));   // second change to the same file: kept once
    await CP.before(UD, sess, CP.pathsOf('write', { path: '../outside.js' }));   // outside the project: ignored
    fs.writeFileSync(path.join(PD, 'app.js'), 'new\n');
    fs.mkdirSync(path.join(PD, 'new'), { recursive: true });
    fs.writeFileSync(path.join(PD, 'new/extra.js'), 'made by the run\n');
    const trashed = [];
    const r = await CP.rewind(UD, 'cp-s', async (f) => { trashed.push(f); fs.rmSync(f, { force: true }); });
    check('/rewind puts a changed file back and takes away one the run made', r.ok && fs.readFileSync(path.join(PD, 'app.js'), 'utf8') === 'old\n' && !fs.existsSync(path.join(PD, 'new/extra.js'))
      && r.restored.join() === 'app.js' && r.removed.join() === 'new/extra.js' && trashed.length === 1, r);
    const again = await CP.rewind(UD, 'cp-s', null);
    check('and it is used up: /rewind again says there is nothing more', again.ok === false && /nothing to rewind/.test(again.error), again);
    check('fs move and remove are recorded too', CP.pathsOf('fs', { action: 'move', source: 'a', destination: 'b' }).join() === 'a,b' && CP.pathsOf('fs', { action: 'remove', path: 'c' }).join() === 'c'
      && CP.pathsOf('read', { path: 'x' }).length === 0, 'paths');
    try { fs.rmSync(UD, { recursive: true, force: true }); fs.rmSync(PD, { recursive: true, force: true }); } catch {}
    const AGS = read('src/backend/agent.js');
    check('every run is checkpointed before its file changes', AGS.includes('checkpoints.startRun(session);') && AGS.includes('await checkpoints.before(userData, session, checkpoints.pathsOf(tc.name, args));'), 'agent');
    check('AGENTS.md (else CLAUDE.md) is read into every session', AGS.includes("for (const name of ['AGENTS.md', 'CLAUDE.md'])") && AGS.includes('[PROJECT NOTES] from ${name} in the project folder'), 'notes');

    const MAIN = read('src/main/main.js');
    check('/review runs read-only: ask-first, and only the looking tools plus the shell', MAIN.includes("access: readOnly ? 'ask' : s.access")
      && MAIN.includes("...(readOnly ? { allowTools: require('../backend/tools/spawn').READ_TOOLS.concat(['shell']) } : {}),")
      && MAIN.includes("? { sessionId, text: commands.reviewPrompt(cmd.rest), readOnly: true }"), 'review');
    check('/rewind tells the agent its last changes are gone', MAIN.includes("'[VOX REWIND] The user rewound the file changes of your last run. '"), 'rewind note');
    check('/loop skips a turn while busy, and stops after three failed starts', MAIN.includes("loopEvent(sessionId, { phase: 'skipped', reason: 'still busy from before' })") && MAIN.includes('if (l.fails >= 3) stopLoop('), 'loop');

    const HTML = read('src/renderer/index.html');
    const pageNames = [...HTML.matchAll(/\{ name: '([a-z]+)', args: /g)].map((m) => m[1]);
    check('the "/" menu lists the same commands as the backend', JSON.stringify(pageNames.slice(0, 5)) === JSON.stringify(C.COMMANDS.map((c) => c.name)), pageNames);
    check('the menu opens on "/", and arrows, Tab, Enter and Esc work it before the box sends', HTML.includes('id="slashMenu"') && HTML.includes("$('prompt').addEventListener('input', paintSlashMenu);")
      && HTML.includes("e.preventDefault(); e.stopImmediatePropagation();\n    pickSlash(c);") && /\}, true\);\n\n\/\*\* \/review \/init \/rewind \/loop/.test(HTML), 'menu');
    check('reopened, a command shows as typed, not the instructions behind it', HTML.includes("addUser(first.split('\\n')[0].replace(/^\\[VOX CMD\\] /, ''));"), 'reload');
    check('Clear goal and Stop loop buttons work', HTML.includes("$('shGoalClear').onclick = async () => {") && HTML.includes("$('shLoopStop').onclick = async () => {"), 'buttons');
  }

  // ------------------------------------------------------------------ [QD]
  console.log('\n[QD] the agent\'s questions pop up on the input bar, not in the thread');
  {
    const HTML = read('src/renderer/index.html');
    check('it sits inside the input box, at the top, like an approval', /<div class="box" id="cmpBox">\n[^\n]*\n\s*<div class="qdock" id="qDock" hidden[^>]*><\/div>/.test(HTML) && HTML.includes("const box = el('div', 'ask qa');"), 'markup');
    check('every kind of question goes into it (one renderer), none into the thread', (HTML.match(/    mountAsk\(v, box\);\n/g) || []).length === 1 && HTML.includes('const box = askPanel(v, event);')
      && !HTML.includes('function askCard(') && !HTML.includes('rq.appendChild(box)'), 'mount');
    check('answered or expired, it leaves the box and its one-line record goes into the thread', (HTML.match(/settleAsk\(v, box, record\(/g) || []).length === 2 && !/box\.replaceWith\(/.test(HTML)
      && HTML.includes('if (rec && v.root) { (v.curRun && v.curRun.body || v.root).appendChild(rec);'), 'settle');
    check('one question at a time: a pick moves to the next, the last one sends', HTML.includes('picks[i] = new Set([value]); typed[i] = \'\';\n    next();')
      && HTML.includes("if (cur < steps.length - 1) { cur += 1; otherOpen = false; paint(); }\n    else finish(false);") && HTML.includes("h.appendChild(el('span', '', (cur + 1) + ' of ' + steps.length));"), 'stepper');
    check('choose-any questions have Next, and Back goes to the one before', HTML.includes("const go = el('button', 'b pri', cur < steps.length - 1 ? 'Next' : 'Send');") && HTML.includes("const back = el('button', 'b lnk', '← Back');"), 'next/back');
    check('typing in the box answers the question on screen, then moves on', HTML.includes("typed[cur] = String(text || ''); picks[cur] = steps[cur].multi ? picks[cur] : new Set();\n      next();"), 'typed');
    check('each session keeps its own, and the dock follows the session on screen', HTML.includes('const v = actView(), box = v && v.askEl;') && HTML.includes("  paintQDock();\n  const any = [...$('shelf').children]"), 'switch');
  }

  // ------------------------------------------------------------------ [RW]
  console.log('\n[RW] /rewind takes workers\' changes too; the plan is closed before finishing; quieter chips');
  {
    const CP = require(path.join(ROOT, 'src/backend/tools/checkpoints.js'));
    const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cpw-'));
    const PD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-cpwp-'));
    fs.writeFileSync(path.join(PD, 'a.js'), 'parent-old\n');
    fs.writeFileSync(path.join(PD, 'b.js'), 'worker-old\n');
    const parent = { id: 'rw-parent', workdir: PD };
    CP.startRun(parent);
    const worker = { id: 'rw-worker', workdir: PD, _checkpoint: parent._checkpoint };   // what runAgent does for a worker
    await CP.before(UD, parent, ['a.js']);
    await CP.before(UD, worker, ['b.js']);
    fs.writeFileSync(path.join(PD, 'a.js'), 'parent-new\n');
    fs.writeFileSync(path.join(PD, 'b.js'), 'worker-new\n');
    const r = await CP.rewind(UD, 'rw-parent', null);
    check('one /rewind undoes what the run and its worker changed', r.ok && fs.readFileSync(path.join(PD, 'a.js'), 'utf8') === 'parent-old\n' && fs.readFileSync(path.join(PD, 'b.js'), 'utf8') === 'worker-old\n'
      && r.restored.length === 2 && !fs.existsSync(CP.dirOf(UD, 'rw-worker')), r);
    try { fs.rmSync(UD, { recursive: true, force: true }); fs.rmSync(PD, { recursive: true, force: true }); } catch {}
    const AGR = read('src/backend/agent.js');
    check('a worker in the same folder shares its parent\'s checkpoint; in a worktree it keeps its own', AGR.includes('if (checkpointFrom && checkpointFrom._checkpoint && checkpointFrom.workdir === session.workdir) session._checkpoint = checkpointFrom._checkpoint;')
      && read('src/backend/tools/spawn.js').includes('checkpointFrom: agentOpts.checkpointSession || null,'), 'wiring');

    // The plan: finishing with open steps asks once to close it, then finishes.
    const bodies = [];
    fakeOpenRouter((n, b) => { bodies.push(b); return n === 1 ? call('p1', 'todo', { items: ['one', 'two', 'three'], done: [0] }) : say(n === 2 ? 'All done.' : 'Marked two done; three was not needed.'); });
    const sessP = { id: 'plan-close', workdir: WD, messages: [] };
    const ev = await drain(runAgent({ session: sessP, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 6 }));
    const note = bodies[2] && bodies[2].messages.find((m) => m.role === 'user' && /^\[VOX PLAN\]/.test(String(m.content)));
    check('finishing with open plan steps: asked once to close the plan, then it finishes', note && /2 open steps \("two", "three"\)/.test(note.content) && ev[ev.length - 1].type === 'done'
      && bodies.length === 3 && ev.some((e) => e.code === 'plan-close'), { bodies: bodies.length, note: note && note.content, last: ev[ev.length - 1] });
    const HTMLr = read('src/renderer/index.html');
    check('the reminder is quiet in the thread and on reopening', HTMLr.includes("} else if (event.type === 'warning' && event.code === 'plan-close') {") && HTMLr.includes("if (/^\\[VOX PLAN\\]/.test(first)) { finalizeRunCard(); continue; }"), 'noisy');
    check('the file or command on an action line is toned like inline code', HTMLr.includes('.tr-chip{font:12.5px "Sometype Mono",monospace;color:var(--mut);background:rgba(127,127,127,.12);border:0;'), 'chip');
  }

  try { fs.rmSync(WD, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
