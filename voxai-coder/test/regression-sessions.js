/**
 * Regressions found by auditing two real sessions (2026-09-19, 2026-09-21) that hit
 * what looked like permission or tooling blocks. None of them were permissions.
 *
 *   [AO] attached images never reached the model
 *   [AP] text-only model + image is refused up front, not silently ignored
 *   [AQ] screenshots are images, not truncated base64 in a text result
 *   [AR] app-authored messages are not drawn as things the user said
 *   [AS] sub-agent timeout: the UI said seconds, the code read milliseconds
 *   [AT] the model is told it is on Windows / cmd.exe
 *   [AU] computer.open infers what to do from what it was given
 *   [AV] web_fetch cannot search, so it must hand back links and stop guessing
 *   [AW] no control characters in source (escape corruption guard)
 *
 * Offline. Run: node test/regression-sessions.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const Module = require('module');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MAIN = read('src/main/main.js');
const HTML = read('src/renderer/index.html');
const SPAWN_SRC = read('src/backend/tools/spawn.js');

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

const B = String.fromCharCode(92); // a backslash, without typing one into a string
const winPath = (...parts) => parts.join(B);

/** A fake OpenRouter that records every request body and replies with `script(n)`. */
function fakeOpenRouter(script) {
  const bodies = [];
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    const chunks = script(bodies.length, body);
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
  return bodies;
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

/** Load a module with some of its requires replaced. */
function loadWith(file, stubs) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    for (const [pattern, value] of stubs) if (pattern.test(req)) return value;
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve(file)];
    return require(file);
  } finally {
    Module._load = orig;
  }
}

(async () => {
  const agentPath = path.join(ROOT, 'src/backend/agent.js');
  const { runAgent, extractImages, TOOL_IMAGES_MARKER } = require(agentPath);
  const WD = fs.mkdtempSync(path.join(os.tmpdir(), 'voxai-sess-'));

  // ------------------------------------------------------------------ [AO]
  console.log('\n[AO] attached images reach the model');
  {
    // Exactly the shape the renderer sends: pendingAttachments() in index.html.
    const parts = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } }];
    const bodies = fakeOpenRouter(() => say('ok'));
    const session = { id: 'ao', workdir: WD, messages: [] };
    await drain(runAgent({ session, userText: 'here is my character', attachments: parts, apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2 }));
    const user = bodies[0].messages.find((m) => m.role === 'user');
    check('the renderer-shaped image is sent', JSON.stringify(user.content).includes('image_url'), user.content);
    check('the text is still sent with it', JSON.stringify(user.content).includes('here is my character'), user.content);

    // The legacy {dataUrl} shape keeps working.
    const bodies2 = fakeOpenRouter(() => say('ok'));
    await drain(runAgent({ session: { id: 'ao2', workdir: WD, messages: [] }, userText: 'x', attachments: [{ dataUrl: 'data:image/png;base64,AAAA' }], apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2 }));
    check('the legacy dataUrl shape still works', JSON.stringify(bodies2[0].messages).includes('data:image/png;base64,AAAA'), 'dropped');

    // Something unreadable must be said, not skipped.
    fakeOpenRouter(() => say('ok'));
    const ev = await drain(runAgent({ session: { id: 'ao3', workdir: WD, messages: [] }, userText: 'x', attachments: [{ type: 'image_url', image_url: {} }], apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2 }));
    check('an unreadable attachment is reported', ev.some((e) => e.type === 'warning' && e.code === 'attachment-dropped'), ev.map((e) => e.type));
  }

  // ------------------------------------------------------------------ [AP]
  console.log('\n[AP] text-only model + image is refused up front');
  check('vision is read from input_modalities', MAIN.includes("m.architecture.input_modalities.includes('image')"), 'not recorded');
  check('an unknown modality is not treated as "no"', MAIN.includes(": null,") && /vision: m\.architecture/.test(MAIN), 'unknown == false');
  check('a known text-only model refuses images', MAIN.includes('opts.images > 0 && cap.vision === false'), 'sent anyway');
  check('the send counts the attached images', /assertModelUsable\([^)]*fetchModels, \{\s*images:/.test(MAIN), 'never passed');
  check('the refusal says what to do', MAIN.includes('Switch to a vision model'), 'unhelpful');

  // ------------------------------------------------------------------ [AQ]
  console.log('\n[AQ] screenshots are images, not truncated base64 text');
  {
    const png = 'data:image/png;base64,' + 'A'.repeat(4000);
    const original = { ok: true, title: 't', screenshot: png };
    const { result, images } = extractImages(original);
    check('the image is taken out of the result', result.screenshot === null && images.length === 1, result);
    // The UI's `image` event and anything else holding the tool's return value still
    // need the real screenshot.
    check('the original result is not mutated', original.screenshot === png && result !== original, original.screenshot && original.screenshot.slice(0, 30));
    check('its size is reported', images[0].bytes === 3000, images[0].bytes);
    const untouched = { ok: true, screenshot: null };
    check('a result without images is returned as-is', extractImages(untouched).result === untouched, 'copied');
    check('a short non-image string is left alone', extractImages({ screenshot: 'n/a' }).images.length === 0, 'stripped');

    // End to end: a tool that returns a screenshot, on a vision model and a text model.
    const shot = { ok: true, screenshot: png };
    for (const [vision, label] of [[true, 'vision'], [false, 'text-only']]) {
      const bodies = fakeOpenRouter((n) => (n === 1 ? call('c1', 'todo', { items: ['a'] }) : say('done')));
      const session = { id: 'aq_' + label, workdir: WD, messages: [] };
      // Stand in for a computer-use tool by making `todo` return a screenshot.
      const tools = require(path.join(ROOT, 'src/backend/tools'));
      const origBuild = tools.buildTools;
      tools.buildTools = (o) => {
        const built = origBuild(o);
        const t = built.ALL.find((x) => x.def.function.name === 'todo');
        if (t) t.run = async () => shot;
        return built;
      };
      try {
        await drain(runAgent({ session, userText: 'look', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3, modelVision: vision }));
      } finally { tools.buildTools = origBuild; }
      const toolMsg = session.messages.find((m) => m.role === 'tool');
      check(`${label}: no base64 in the text result`, toolMsg && !String(toolMsg.content).includes('base64,AAAA'), toolMsg && String(toolMsg.content).slice(0, 120));
      const imgMsg = session.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && String(m.content[0].text || '').startsWith(TOOL_IMAGES_MARKER));
      if (vision) {
        check('vision: the screenshot follows as a real image', !!imgMsg && imgMsg.content.some((p) => p.type === 'image_url'), session.messages.map((m) => m.role));
        const iTool = session.messages.indexOf(toolMsg);
        const iImg = session.messages.indexOf(imgMsg);
        check('vision: it comes after the tool result, keeping the pairing', iImg > iTool, [iTool, iImg]);
        check('vision: the second request carries the image', JSON.stringify(bodies[1].messages).includes('image_url'), 'not sent');
      } else {
        check('text-only: no image message is added', !imgMsg, 'added anyway');
        check('text-only: the model is told it did not see it', /NOT shown to you/.test(String(toolMsg.content)), String(toolMsg.content).slice(0, 160));
      }
    }
  }

  // ------------------------------------------------------------------ [AR]
  console.log('\n[AR] app-authored messages are not drawn as the user');
  check('the renderer recognises both markers', HTML.includes('[VOX (COMPACTED CONTEXT|TOOL SCREENSHOTS)]') || /VOX \(COMPACTED CONTEXT\|TOOL SCREENSHOTS\)/.test(HTML), 'drawn as bubbles');
  check('the marker the agent writes is the one the renderer reads', TOOL_IMAGES_MARKER === '[VOX TOOL SCREENSHOTS]', TOOL_IMAGES_MARKER);
  check('compaction still writes its marker', read('src/backend/compact.js').includes('[VOX COMPACTED CONTEXT]'), 'renamed');

  // ------------------------------------------------------------------ [AS]
  console.log('\n[AS] sub-agent timeout units');
  {
    const src = /function subagentTimeoutToMs\(raw\) \{[\s\S]*?\n\}/.exec(MAIN);
    check('the normaliser exists', !!src, 'missing');
    if (src) {
      const toMs = vm.runInNewContext('(' + src[0] + ')');
      const cases = [
        [undefined, 300000, 'never set'],
        ['300', 300000, 'the old default, which meant 300 s'],
        ['120', 120000, 'an old save in seconds'],
        ['300000', 300000, 'a new save in ms'],
        ['5', 10000, 'below the floor'],
        ['99999999', 3600000, 'above the ceiling'],
        ['abc', 300000, 'garbage'],
      ];
      for (const [input, want, why] of cases) check(`${why}: ${input} -> ${want} ms`, toMs(input) === want, toMs(input));
    }
    check('the default is no longer a bare 300', !MAIN.includes("process.env.VOX_SUBAGENT_TIMEOUT_MS || '300',"), 'still 300 ms');
    check('the Settings field saves seconds as ms', HTML.includes("Number($('fSubTimeout').value) * 1000"), 'saves raw seconds');
    check('spawn floors the timeout', SPAWN_SRC.includes('Math.max(floor, requestedTimeout)'), 'no floor');
    check('the floor defaults to 10 s unless injected', SPAWN_SRC.includes('const SUB_TIMEOUT_FLOOR_MS = 10000;')
      && SPAWN_SRC.includes(': SUB_TIMEOUT_FLOOR_MS;'), 'no default');

    // The failure itself: a 600 ms first token under the old 300 ms default.
    let n = 0;
    global.fetch = async (_u, opts) => {
      n++;
      const first = n === 1;
      await new Promise((r) => setTimeout(r, first ? 0 : 600));
      if (opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const chunks = first ? call('s1', 'spawn_agent', { task: 'look around', role: 'explore' }) : say('report');
      const enc = new TextEncoder();
      return { ok: true, text: async () => '', body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }) };
    };
    let end = null;
    for await (const ev of runAgent({ session: { id: 'as', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3, userData: WD, subagentTimeoutMs: '300' })) {
      if (ev.type === 'tool_end' && ev.name === 'spawn_agent') end = JSON.parse(ev.result);
      if (['done', 'error', 'limit_reached'].includes(ev.type)) break;
    }
    check('a worker survives a realistic first-token delay', end && end.stopReason === 'completed', end && [end.stopReason, end.error]);
  }

  // ------------------------------------------------------------------ [AT]
  console.log('\n[AT] the model knows its shell');
  {
    const src = read('src/backend/tools/index.js');
    check('the shell description names cmd.exe on Windows', /WINDOWS and it runs in cmd\.exe, not bash/.test(src), 'unnamed');
    check('it lists what is missing', src.includes('There is no ls, cat, grep, head or 2>/dev/null'), 'bash assumed');
    check('it steers away from nested powershell quoting', src.includes('Avoid nesting powershell -Command'), 'mangled quoting');
    const agent = read('src/backend/agent.js');
    check('the system prompt names the platform', agent.includes('`Platform: ${PLATFORM_LINE}. `'), 'not in prompt');
    if (process.platform === 'win32') {
      const tools = require(path.join(ROOT, 'src/backend/tools'));
      const { ALL } = tools.buildTools({ workdir: WD, session: { id: 'x', messages: [] }, emit: () => {}, checkPermission: async () => {}, resolveIn: (a, b) => b, getSettings: () => ({}), getAccess: () => 'full' });
      const sh = ALL.find((t) => t.def.function.name === 'shell');
      check('on this machine the live tool says cmd.exe', sh && /cmd\.exe/.test(sh.def.function.description), sh && sh.def.function.description);
    }
  }

  // ------------------------------------------------------------------ [AU]
  console.log('\n[AU] computer.open infers the surface from its arguments');
  {
    const seen = [];
    const cu = loadWith(path.join(ROOT, 'src/backend/cu/index.js'), [
      [/\.\/cdp$/, { launch: async (u) => { seen.push(u); return { title: 't', url: u, elements: [], text: '' }; } }],
      [/\.\/native$/, { launch: (p) => { seen.push('NATIVE ' + p); return { ok: true }; }, screenshot: () => ({}), listWindows: () => ({ windows: [] }) }],
    ]);
    const t = cu.makeComputerUseTool({});
    const ctx = { workdir: winPath('A:', 'Github', 'Desktop3D'), emit: () => {} };
    const run = async (args) => { seen.length = 0; try { await t.run('cu_launch', args, ctx); return seen[0]; } catch (e) { return 'ERROR ' + e.message; } };

    // The exact call that failed on 2026-09-21.
    const png = await run({ nativePath: winPath('A:', 'Github', 'Desktop3D', 'assets', 'renders', 'byte-qt-preview.png') });
    check('a local image opens as file://', png === 'file:///A:/Github/Desktop3D/assets/renders/byte-qt-preview.png', png);
    const rel = await run({ nativePath: 'assets/renders/byte-main-pose.png' });
    check('a relative path resolves against the workdir', rel === 'file:///A:/Github/Desktop3D/assets/renders/byte-main-pose.png', rel);
    const exe = await run({ nativePath: winPath('C:', 'Windows', 'notepad.exe') });
    check('an .exe is launched natively', exe === 'NATIVE ' + winPath('C:', 'Windows', 'notepad.exe'), exe);
    const web = await run({ url: 'https://example.com' });
    check('a url goes to the browser even right after a native launch', web === 'https://example.com', web);
    const none = await run({});
    check('nothing to open is an error, not a launch of undefined', /^ERROR open needs something to open/.test(none), none);
    const blank = await run({ url: 'data:image/png;base64,' });
    check('an empty data: url is refused', /^ERROR that data: URL is empty/.test(blank), blank);
  }

  // ------------------------------------------------------------------ [AV]
  console.log('\n[AV] web_fetch: links instead of guesses');
  {
    const wf = require(path.join(ROOT, 'src/backend/tools/web_fetch.js'));
    const page = '<a href="/products/gemini-app/">Gemini app</a>'
      + "<a href='https://blog.google/technology/ai/'>AI</a>"
      + '<a href="https://other.example.com/x">elsewhere</a>'
      + '<a href="#top">skip</a><a href="mailto:a@b.c">mail</a><a href="javascript:void 0">js</a>'
      + '<a class="n" href="/products/gemini-app/">dup</a><a href=/rel/path>unquoted</a>'
      + '<a href="http://insecure.example.com/">http</a>';
    const links = wf.extractLinks(page, 'https://blog.google/');
    const urls = links.map((l) => l.url);
    check('links are extracted at all', links.length > 0, links);
    check('relative links become absolute', urls.includes('https://blog.google/products/gemini-app/'), urls);
    check('link text is kept', links.some((l) => l.text === 'Gemini app'), links);
    check('unquoted hrefs are read', urls.includes('https://blog.google/rel/path'), urls);
    check('duplicates are dropped', urls.filter((u) => u === 'https://blog.google/products/gemini-app/').length === 1, urls);
    check('anchors, mailto and javascript are skipped', !urls.some((u) => /#top|mailto|javascript/.test(u)), urls);
    check('only https is offered, matching what can be fetched', !urls.some((u) => u.startsWith('http:')), urls);
    check('same-site links come first', urls.indexOf('https://other.example.com/x') > urls.indexOf('https://blog.google/rel/path'), urls);
    check('the list is capped', wf.extractLinks(page.repeat(50).replace(/gemini-app/g, () => 'p' + Math.random()), 'https://blog.google/', 10).length <= 10, 'unbounded');

    const def = wf.makeWebFetchTool({ checkPermission: async () => {} }).def.function.description;
    check('the tool says it is not a search engine', /not a search engine/.test(def), def);
    check('it says not to guess URLs', /Do not construct or guess/.test(def), def);
    check('it forbids describing unfetched pages', /never describe a page you did not successfully fetch/.test(def), def);
    const src = read('src/backend/tools/web_fetch.js');
    check('a guessing streak gets a stop hint', src.includes('if (misses >= MISS_STREAK_WARN)'), 'no hint');
    check('a success resets the streak', src.includes('if (sess) sess._fetchMisses = 0;'), 'never resets');
    check('html results carry links', /kind: 'html'[^\n]*links \}/.test(src), 'links dropped');
  }

  // ------------------------------------------------------------------ [AX]
  console.log('\n[AX] web_search finds pages instead of guessing them');
  {
    const { makeWebSearchTool, SEARCH_FEE_USD } = require(path.join(ROOT, 'src/backend/tools/web_search.js'));
    let lastBody = null;
    let reply = null;
    global.fetch = async (_u, opts) => {
      lastBody = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
    };
    const cite = (url, title, content) => ({ type: 'url_citation', url_citation: { url, title, content, start_index: 0, end_index: 1 } });
    reply = {
      choices: [{ message: { role: 'assistant', content: 'done', annotations: [
        cite('https://blog.google/products/gemini-app/', 'Gemini app', 'The Gemini app can  connect to\n Gmail, Drive and Calendar. ' + 'x'.repeat(900)),
        cite('https://gemini.google/overview/', 'Overview', 'Overview text'),
        cite('https://blog.google/products/gemini-app/', 'dup', 'dup'),
        { type: 'something_else' },
      ] } }],
      usage: { prompt_tokens: 900, completion_tokens: 2, cost: 0.0081 },
    };
    const t = makeWebSearchTool({ checkPermission: async () => {}, agentOpts: { apiKey: 'k', model: 'm' } });
    const r = await t.run({ query: 'gemini app extensions', max_results: 50, include_domains: ['https://blog.google/products', 'gemini.google'] }, {});

    check('results come from url_citation annotations', r.results.length === 2 && r.results[0].url === 'https://blog.google/products/gemini-app/', r.results);
    check('duplicate URLs are dropped', r.results.filter((x) => x.url === 'https://blog.google/products/gemini-app/').length === 1, r.results);
    check('snippets are whitespace-collapsed and capped', r.results[0].snippet.length <= 500 && !/\n|  /.test(r.results[0].snippet), r.results[0].snippet.slice(0, 60));
    check('the real charge is reported', r.cost_usd === 0.0081, r.cost_usd);
    const plugin = lastBody.plugins && lastBody.plugins[0];
    check('the request uses the web plugin', plugin && plugin.id === 'web' && plugin.engine === 'exa', lastBody.plugins);
    check('max_results is capped at 10', plugin && plugin.max_results === 10, plugin && plugin.max_results);
    check('domains are normalised to bare hosts', plugin && JSON.stringify(plugin.include_domains) === JSON.stringify(['blog.google', 'gemini.google']), plugin && plugin.include_domains);
    check('usage accounting is requested', lastBody.usage && lastBody.usage.include === true, lastBody.usage);
    check('the completion is kept tiny — only citations are used', lastBody.max_tokens <= 32, lastBody.max_tokens);

    reply = { choices: [{ message: { content: 'nothing', annotations: [] } }], usage: { cost: 0.007 } };
    const empty = await t.run({ query: 'zzzz' }, {});
    check('no results says so, and says not to guess', empty.results.length === 0 && /do not fall back\s+to guessing URLs/.test(empty.note), empty);

    const broke = makeWebSearchTool({ checkPermission: async () => {}, agentOpts: { apiKey: 'k', model: 'm', budgetRemaining: SEARCH_FEE_USD } });
    let refused = '';
    lastBody = null;
    try { await broke.run({ query: 'x' }, {}); } catch (e) { refused = e.message; }
    check('a search the budget cannot cover is refused', /not enough run budget/.test(refused), refused);
    check('...before any request is made', lastBody === null, lastBody);

    let noKey = '';
    try { await makeWebSearchTool({ checkPermission: async () => {}, agentOpts: {} }).run({ query: 'x' }, {}); } catch (e) { noKey = e.message; }
    check('no key is a clear error', /needs an OpenRouter key/.test(noKey), noKey);

    let asked = null;
    await makeWebSearchTool({ checkPermission: async (kind, target) => { asked = [kind, target]; }, agentOpts: { apiKey: 'k', model: 'm' } }).run({ query: 'q1' }, {});
    check('it goes through the permission check', asked && asked[0] === 'web-search' && asked[1] === 'q1', asked);

    // End to end: the agent charges the search to the run and reports it.
    reply = null;
    let n = 0;
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.plugins) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'done', annotations: [cite('https://a.example/', 'A', 'a')] } }], usage: { cost: 0.0075 } }) };
      }
      n++;
      const chunks = n === 1 ? call('w1', 'web_search', { query: 'thing' }) : say('found it');
      const enc = new TextEncoder();
      return { ok: true, text: async () => '', body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }) };
    };
    const evs = await drain(runAgent({ session: { id: 'ax', workdir: WD, messages: [] }, userText: 'research', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3, budgetUsd: 1 }));
    const end = evs.find((e) => e.type === 'tool_end' && e.name === 'web_search');
    check('the agent can call it', end && end.ok === true, end && end.result);
    check('its cost is charged to the run budget', evs.some((e) => e.type === 'budget' && e.source === 'web_search' && e.spent >= 0.0075), evs.filter((e) => e.type === 'budget'));
    check('and reported as usage, so parents and the ledger see it', evs.some((e) => e.type === 'usage' && e.usage.source === 'web_search' && e.usage.cost === 0.0075), evs.filter((e) => e.type === 'usage'));

    const tools = require(path.join(ROOT, 'src/backend/tools'));
    const { ALL } = tools.buildTools({ workdir: WD, session: { id: 'x', messages: [] }, emit: () => {}, checkPermission: async () => {}, resolveIn: (a, b) => b, getSettings: () => ({}), getAccess: () => 'full', agentOpts: { apiKey: 'k', model: 'm' } });
    check('the tool is registered', ALL.some((x) => x.def.function.name === 'web_search'), ALL.map((x) => x.def.function.name));
    const { ROLES } = require(path.join(ROOT, 'src/backend/tools/spawn.js'));
    check('explore workers can search and fetch', ROLES.explore.tools.includes('web_search') && ROLES.explore.tools.includes('web_fetch'), ROLES.explore.tools);
    check('...but still cannot write', !ROLES.explore.tools.some((x) => ['write', 'edit', 'patch', 'shell'].includes(x)), ROLES.explore.tools);
    check('it sits at the same permission tier as web_fetch', /web_fetch: 1, web_search: 1/.test(read('src/backend/tools/sandbox.js')), 'different tier');
    check('the system prompt names the research workflow', read('src/backend/agent.js').includes('web_search to find sources, web_fetch to read them'), 'missing');
    check('the renderer labels and summarises it', HTML.includes("if (name==='web_search') return 'FIND';") && HTML.includes("Array.isArray(o.results) && o.query !== undefined"), 'raw');
  }

  // ------------------------------------------------------------------ [AW]
  console.log('\n[AW] no control characters in source');
  {
    // Edits made through shell heredocs have repeatedly turned "\b" into a literal
    // backspace byte. Inside a regex that PARSES fine and silently never matches —
    // web_fetch's link regex shipped that way for one edit. A parse check cannot see
    // it; this can.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'test'))].filter((f) => /\.(js|html|css)$/.test(f));
    const hits = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => { if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(l)) hits.push(path.relative(ROOT, f) + ':' + (i + 1)); });
    }
    check(`${files.length} source files are free of control characters`, hits.length === 0, hits);
  }

  try { fs.rmSync(WD, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
