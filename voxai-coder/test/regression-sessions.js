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
 *   [BB] attachments: pictures and files, in the box and in the sent message
 *   [BC] Linux desktop control and preview (from the Linux edition)
 *   [BD] macOS groundwork
 *   [BE] Settings > Appearance
 *   [BF] Settings > Computer use
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

  // ------------------------------------------------------------------ [CR]
  // A real session's whole memory became 480 characters of nested recaps: each one took the last
  // recap as "the goal", cut to 400 characters. What the user asked was gone.
  console.log('\n[CR] a compacted session keeps what the user asked, and what is done');
  {
    const { compactSession } = require(path.join(ROOT, 'src/backend/compact.js'));
    const turn = (i) => [
      { role: 'assistant', content: `Step ${i} done.`, tool_calls: [{ id: 'w' + i, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `src/part${i}.js`, content: 'x' }) } }] },
      { role: 'tool', tool_call_id: 'w' + i, content: i === 3 ? 'DENIED_OR_ERROR: the disk is full' : 'x'.repeat(900) },
    ];
    const brief = 'Build a tower defence game with a level editor. ' + 'Waves get harder each round. '.repeat(30);
    const s = {
      todos: [{ text: 'Map and towers', done: true }, { text: 'Level editor', done: false }],
      messages: [
        { role: 'user', content: brief },
        ...turn(1), ...turn(2),
        { role: 'user', content: [{ type: 'text', text: 'Make the towers blue' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'user', content: '[VOX PLAN] Before you finish: your plan has open steps.' },
        ...turn(3), ...turn(4),
        { role: 'user', content: '[VOX STEER] The user sent this while you were working: also add a pause button' },
        ...Array.from({ length: 12 }, (_, i) => turn(5 + i)).flat(),
      ],
    };
    compactSession(s, { contextLimit: 8000, force: true, keepRecent: 2 });
    const first = s.messages[0].content;
    check('the brief is kept in full, not cut to 400 characters', first.includes(brief.trim()), first.slice(0, 300));
    check('a request sent with a picture is kept, and says so', first.includes('Make the towers blue (with 1 picture)'), 'lost');
    check('words sent while it worked are the user\'s; the app\'s own notes are not', first.includes('also add a pause button') && !first.includes('Before you finish'), 'mixed');
    check('the newest request is marked current', /\d+\. \[current\] \(sent while you were working\) also add a pause button/.test(first), 'unmarked');
    check('it says which files are done, where the plan stands and what failed', first.includes('src/part1.js') && first.includes('[open] Level editor') && first.includes('the disk is full'), 'missing');
    // Compact again: the last recap is carried forward, never nested inside the new one.
    s.messages.push({ role: 'user', content: 'Now add sound' }, ...Array.from({ length: 12 }, (_, i) => turn(30 + i)).flat());
    compactSession(s, { contextLimit: 8000, force: true, keepRecent: 2 });
    const again = s.messages[0].content;
    check('a second compaction carries the requests forward without nesting', (again.match(/VOX COMPACTED CONTEXT/g) || []).length === 1
      && again.includes('Build a tower defence game') && again.includes('[current] Now add sound') && again.includes('src/part1.js'), again.slice(0, 400));
    // A recap the old compactor nested is dropped, not carried on.
    const old = { messages: [{ role: 'user', content: '[VOX COMPACTED CONTEXT]\n### Prior session context (compacted)\nGoal/direction: [VOX COMPACTED CONTEXT]' }, { role: 'user', content: 'fix the save menu' }, ...Array.from({ length: 12 }, (_, i) => turn(i)).flat()] };
    compactSession(old, { contextLimit: 8000, force: true, keepRecent: 2 });
    check('an old nested recap is dropped', !old.messages[0].content.includes('Prior session context') && old.messages[0].content.includes('fix the save menu'), old.messages[0].content.slice(0, 300));
  }

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

    // Found live: a worker's spend was in the saved ledger but never on screen, because
    // the header only sums `usage` events and none was emitted for the worker.
    {
      let k = 0;
      global.fetch = async () => {
        k++;
        const chunks = k === 1 ? call('s2', 'spawn_agent', { task: 'count things', role: 'explore' })
          : [{ choices: [{ delta: { content: k === 2 ? 'worker report' : 'done' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0012 } }];
        const enc = new TextEncoder();
        return { ok: true, text: async () => '', body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }) };
      };
      const ev2 = await drain(runAgent({ session: { id: 'as2', workdir: WD, messages: [] }, userText: 'go', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3, userData: WD }));
      const subUsage = ev2.find((e) => e.type === 'usage' && e.usage.source === 'subagent');
      check("a worker's spend reaches the live header", subUsage && subUsage.usage.cost === 0.0012 && subUsage.usage.prompt_tokens === 1000, ev2.filter((e) => e.type === 'usage').map((e) => e.usage));
    }
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
    const native = { launch: (p) => { seen.push('NATIVE ' + p); return { ok: true }; }, screenshot: () => ({}), listWindows: () => ({ windows: [] }) };
    const cu = loadWith(path.join(ROOT, 'src/backend/cu/index.js'), [
      [/\.\/cdp$/, { launch: async (u) => { seen.push(u); return { title: 't', url: u, elements: [], text: '' }; } }],
      // index.js gets native through platform.js, which picks the Windows or Linux module.
      [/\.\/platform$/, { native, input: {}, UiaHelper: class {}, backend: 'windows' }],
      [/\.\/native$/, native],
    ]);
    const t = cu.makeComputerUseTool({});
    // Drive-letter paths only mean something on Windows; elsewhere the same checks use a POSIX workdir.
    const WIN = process.platform === 'win32';
    const wd = WIN ? winPath('A:', 'Github', 'Desktop3D') : '/home/dev/Desktop3D';
    const wdUrl = WIN ? 'file:///A:/Github/Desktop3D' : 'file:///home/dev/Desktop3D';
    const ctx = { workdir: wd, emit: () => {} };
    const run = async (args) => { seen.length = 0; try { await t.run('cu_launch', args, ctx); return seen[0]; } catch (e) { return 'ERROR ' + e.message; } };

    // The exact call that failed on 2026-09-21.
    const png = await run({ nativePath: path.join(wd, 'assets', 'renders', 'byte-qt-preview.png') });
    check('a local image opens as file://', png === `${wdUrl}/assets/renders/byte-qt-preview.png`, png);
    const rel = await run({ nativePath: 'assets/renders/byte-main-pose.png' });
    check('a relative path resolves against the workdir', rel === `${wdUrl}/assets/renders/byte-main-pose.png`, rel);
    if (WIN) {
      const exe = await run({ nativePath: winPath('C:', 'Windows', 'notepad.exe') });
      check('an .exe is launched natively', exe === 'NATIVE ' + winPath('C:', 'Windows', 'notepad.exe'), exe);
    }
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
    check('html results carry links', /kind: 'html'[^\n]*links, text:/.test(src), 'links dropped');
    // Found live, not offline: on a real page the links came AFTER ~20k chars of text,
    // and the 8k head+tail bound cut them out every time. The offline fixture was tiny,
    // so this passed while the feature did nothing. Bound a realistic result for real.
    {
      const { boundToolResult } = require(agentPath);
      const bigPage = '<html><body>' + ('<p>' + 'lorem ipsum dolor sit amet '.repeat(40) + '</p>').repeat(30)
        + Array.from({ length: 80 }, (_, i) => `<a href="/post-${i}">A reasonably long link title number ${i}</a>`).join('') + '</body></html>';
      const linksOut = wf.extractLinks(bigPage, 'https://blog.google/', 30);
      const result = { url: 'https://blog.google/', status: 200, kind: 'html', chars: bigPage.length, links: linksOut, text: wf.stripHtml(bigPage).slice(0, 20000) };
      const bounded = boundToolResult(JSON.stringify(result), 8000);
      check('a realistic page is actually bounded', bounded.length <= 8200 && /characters truncated/.test(bounded), bounded.length);
      check('...and its links survive the bound', bounded.includes('"links"') && bounded.includes('https://blog.google/post-0'), bounded.slice(0, 200));
      check('the link list is capped to fit', linksOut.length === 30 && JSON.stringify(linksOut).length < 4000, JSON.stringify(linksOut).length);
    }
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
    const axSession = { id: 'ax', workdir: WD, messages: [] };
    const evs = await drain(runAgent({ session: axSession, userText: 'research', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3, budgetUsd: 1 }));
    // Found live: the header counted the fee, the SAVED ledger did not, so a reopened
    // session's cost dropped by every search.
    check('the search fee reaches the saved ledger', axSession._runUsage && axSession._runUsage.cost >= 0.0075, axSession._runUsage);
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

  // ------------------------------------------------------------------ [AY]
  console.log('\n[AY] found by driving the real app (2026-09-24)');
  {
    const script = (HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || []).join('\n');
    const code = script.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Settings threw "process is not defined" whenever a setting was blank, so every
    // field after the sub-agent model silently showed only its placeholder.
    check('the sandboxed renderer never touches process', !/\bprocess\.env\b/.test(code) && !/\bprocess\.(platform|versions|argv)\b/.test(code), (code.match(/process\.\w+/g) || []).slice(0, 3));

    // A refused send (e.g. image to a text-only model) cleared the image it told you to resend.
    check('a refused send gives the text back', /catch \(err\)[\s\S]{0,1600}if \(here && ta && !ta\.value\.trim\(\)\) ta\.value = text;/.test(HTML), 'text lost');
    check('...and the attachments', /catch \(err\)[\s\S]{0,1800}PENDING_ATTACH\.push\(\{ dataUrl: url/.test(HTML), 'image lost');
    check("Electron's IPC wrapper is stripped from errors", HTML.includes("replace(/^Error invoking remote method '[^']*':\\s*/, '')"), 'wrapper shown');

    // The model picker only changed the global default; runs use the session's model.
    check('switching model switches the open session', MAIN.includes("ipcMain.handle('sessions:setModel'") && read('src/preload/preload.js').includes('sessionsSetModel') && /async function setModel[\s\S]{0,500}sessionsSetModel\(activeId, id\)/.test(HTML), 'chip-only switch');
    check('the chip names the model the next send will use', HTML.includes('function activeModel()') && /function refreshChips\(\)\{\s*\$\('chipModelVal'\)\.textContent = modelLabel\(activeModel\(\)\)/.test(HTML), 'shows the global default');
    check('the chip follows session switches', /function paintActive\(\)\{[\s\S]{0,300}refreshChips\(\)/.test(HTML), 'stale chip');
    check('a loaded session remembers its model', HTML.includes("v.model = full.model || '';"), 'model dropped');

    // OpenRouter reports spend as usage.cost; the header read only total_cost.
    check('the header reads usage.cost', HTML.includes('const billed = Number(u.total_cost) || Number(u.cost) || 0;'), 'stuck at $0.00');
    check('sub-cent spend is visible', HTML.includes('Math.abs(costUsd) < 0.01 ? Number(costUsd).toFixed(4)'), 'rounds to $0.00');

    // A long session title wrapped one word per line and pushed the stats off-screen.
    check('the session title stays on one line', /\.workhead \.t\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(HTML), 'wraps');
    check('the header stats never shrink', /\.workhead \.workstats\{[^}]*flex:none/.test(HTML), 'clipped');

    // The state PULL lacked the url the PUSH had: after a reload the bar read http://localhost.
    check('preview state has one source', MAIN.includes('function previewState()') && MAIN.includes("ipcMain.handle('preview:state', () => previewState());"), 'pull without url');
    // preview:open judged file:// against the GLOBAL folder, refusing other projects' files.
    check("preview:open is judged against the session's folder", MAIN.includes('atlasOpenUrl(arg.url, arg.workdir)') && /b\.open\(url, wd\)/.test(HTML), 'global folder');

    // The ledger showed the worker's LAST turn, not its total (4,337 of 9,973).
    check('a worker\'s tokens accumulate', HTML.includes("W.tok += (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);"), 'last turn only');
    check('the shell row is not labelled BASH on Windows', !HTML.includes("if (name==='shell') return 'BASH';"), 'BASH');
  }

  // ------------------------------------------------------------------ [AZ]
  console.log('\n[AZ] web search settings');
  {
    // Settings panel: the three controls exist, are filled when it opens, and are saved.
    check('Settings has a web search on/off', HTML.includes('id="wsToggle" role="switch"') && HTML.includes('<input type="hidden" id="fWebSearch" value="on">'), 'missing');
    check('...an engine picker with prices', ['exa', 'parallel', 'perplexity'].every((e) => HTML.includes(`data-v="${e}"`)) && /data-v="exa">Exa<small>\$0\.007<\/small>/.test(HTML) && /data-v="parallel">Parallel<small>\$0\.005<\/small>/.test(HTML), 'missing');
    check('...and a results-per-search field', HTML.includes('id="fWebResults" type="number" min="1" max="10"'), 'missing');
    check('the fields are filled when Settings opens', /prefillAdvanced[\s\S]*fWebSearch'\)\.value = s\.webSearchEnabled === false \? 'off' : 'on'/.test(HTML), 'blank on open');
    check('they are saved', HTML.includes("patch.webSearchEnabled = $('fWebSearch').value !== 'off'") && HTML.includes('patch.webSearchEngine =') && HTML.includes('patch.webSearchMaxResults ='), 'not saved');

    // main.js checks stored values, and passes them to BOTH places that start a run.
    check('stored values are validated', MAIN.includes("['exa', 'parallel', 'perplexity'].includes(raw.webSearchEngine)") && MAIN.includes('webSearchMaxResults: Math.min(10, Math.max(1,'), 'trusted blindly');
    // The second path was the Sub-agents panel's spawn IPC, removed (no panel ever called it).
    check('the run path gets the setting', (MAIN.match(/webSearch: \{ enabled: s\.webSearchEnabled, engine: s\.webSearchEngine, maxResults: s\.webSearchMaxResults \}/g) || []).length === 1, 'ignored');

    // The tool uses the chosen engine, its fee and the default count.
    const { makeWebSearchTool, ENGINES } = require(path.join(ROOT, 'src/backend/tools/web_search.js'));
    let sent = null;
    global.fetch = async (_u, opts) => { sent = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'done', annotations: [] } }], usage: { cost: 0.001 } }) }; };
    const par = makeWebSearchTool({ checkPermission: async () => {}, agentOpts: { apiKey: 'k', model: 'm', webSearch: { enabled: true, engine: 'parallel', maxResults: 3 } } });
    await par.run({ query: 'x' }, {});
    check('the chosen engine is used', sent.plugins[0].engine === 'parallel', sent.plugins[0]);
    check('the default result count is used', sent.plugins[0].max_results === 3, sent.plugins[0].max_results);
    check("the description quotes that engine's fee", /about \$0\.005 of the run budget/.test(par.def.function.description), par.def.function.description.slice(0, 160));
    check('an unknown engine falls back to Exa', (await (async () => { const t = makeWebSearchTool({ checkPermission: async () => {}, agentOpts: { apiKey: 'k', model: 'm', webSearch: { engine: 'bogus' } } }); await t.run({ query: 'x' }, {}); return sent.plugins[0].engine; })()) === 'exa', sent.plugins[0].engine);
    check('every engine has a fee', Object.values(ENGINES).every((e) => e.fee > 0), ENGINES);
    let offErr = '';
    try { await makeWebSearchTool({ checkPermission: async () => {}, agentOpts: { apiKey: 'k', model: 'm', webSearch: { enabled: false } } }).run({ query: 'x' }, {}); } catch (e) { offErr = e.message; }
    check('a call while off is refused', /turned off in Settings/.test(offErr), offErr);

    // End to end: with search OFF the model is not offered the tool, and the prompt does
    // not tell it to use one. With it ON, both are present.
    for (const enabled of [false, true]) {
      const bodies = fakeOpenRouter(() => say('ok'));
      await drain(runAgent({ session: { id: 'az' + enabled, workdir: WD, messages: [] }, userText: 'hi', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 2, webSearch: { enabled, engine: 'exa', maxResults: 5 } }));
      const names = (bodies[0].tools || []).map((t) => t.function.name);
      const sys = bodies[0].messages[0].content;
      const sysText = typeof sys === 'string' ? sys : JSON.stringify(sys);
      if (enabled) {
        check('on: the model is offered web_search', names.includes('web_search'), names);
        check('on: the prompt names the research workflow', sysText.includes('web_search to find sources'), sysText.slice(0, 80));
      } else {
        check('off: the model is not offered web_search', !names.includes('web_search') && names.includes('web_fetch'), names);
        check('off: the prompt says search is off', sysText.includes('Web search is turned off') && !sysText.includes('web_search to find sources'), 'still mentions it');
      }
    }
    check('workers follow the setting', SPAWN_SRC.includes('webSearch: agentOpts.webSearch || null,'), 'workers ignore it');

    // Found live: a model that searched earlier in the session calls web_search again
    // after it is turned off. It must be refused (no fee) and told the real reason.
    {
      let searched = false;
      let k = 0;
      global.fetch = async (_u, opts) => {
        const body = JSON.parse(opts.body);
        if (body.plugins) { searched = true; return { ok: true, status: 200, text: async () => '{}' }; }
        k++;
        const chunks = k === 1 ? call('w9', 'web_search', { query: 'x' }) : say('ok');
        const enc = new TextEncoder();
        return { ok: true, text: async () => '', body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n')); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }) };
      };
      const offSession = { id: 'azoff', workdir: WD, messages: [] };
      await drain(runAgent({ session: offSession, userText: 'search', apiKey: 'k', model: 'm', access: 'full', askPermission: async () => true, maxTurns: 3, webSearch: { enabled: false } }));
      const reply = offSession.messages.find((m) => m.role === 'tool');
      check('off: a web_search call from memory does not search', !searched, 'searched anyway');
      check('off: the model is told search is turned off', reply && /turned off in Settings/.test(reply.content), reply && reply.content);
    }
  }

  // ------------------------------------------------------------------ [BA]
  console.log('\n[BA] the refit: one app, not parts bolted together');
  {
    const code = (HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || []).join('\n')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const titlebar = HTML.slice(HTML.indexOf('<header class="titlebar"'), HTML.indexOf('</header>', HTML.indexOf('<header class="titlebar"')));

    // chrome
    check('the leftover tab bar is gone', !HTML.includes('<div class="tabs">') && !/^\.tabs\{/m.test(HTML), 'still there');
    check('Settings is a gear in the title bar', titlebar.includes('id="btnSettings"'), 'not in the title bar');
    check('the title bar carries project / session', titlebar.includes('id="tbProj"') && titlebar.includes('id="tbTitle"') && code.includes("pj.textContent = wd ? folderName(wd) : ''"), 'no crumb');
    check('the session title stays as a heading for screen readers', HTML.includes('<h1 class="sr-only" id="sessTitle">'), 'removed');
    check('header stats are one pill with a detail card', HTML.includes('id="statPill"') && HTML.includes('class="stat-card"') && /\.workstats:hover \.stat-card,\.workhead \.workstats:focus \.stat-card\{display:flex\}/.test(HTML), 'five loose stats');
    check('the pill can be reached by keyboard', HTML.includes('id="statPill" tabindex="0"'), 'mouse only');
    check('the branch sits in the header', /<div class="workhead">[\s\S]{0,1500}id="cbBranch"/.test(HTML), 'elsewhere');
    check("summarise doesn't reuse the refresh icon", code.includes("btnCompact: 'compress'"), 'same arrow as refresh');

    // sidebar
    check('no placeholder identity', !/<span[^>]*>Vox User<\/span>/.test(HTML) && !HTML.includes('class="usercard"'), 'still there');
    check('no empty Sessions heading', !HTML.includes('<div class="projhead">SESSIONS</div>') && !code.includes("'PROJECTS'"), 'still there');
    check('one status row replaces three cards', HTML.includes('id="sideStatus"') && !HTML.includes('class="usage"') && !HTML.includes('id="backendBox"'), 'cards remain');
    check('the model is not repeated in the sidebar', !HTML.includes('id="modelTag"') && !code.includes("$('modelTag')"), 'shown twice');
    check('sessions show how long ago', code.includes('function relTime(') && code.includes("b.querySelector('time').textContent = waiting ? 'needs you' : relTime(s.updatedAt)"), 'no times');
    check('only a working session gets a dot', code.includes("(waiting ? '<span class=\"dot wait\"></span>' : busy ? '<span class=\"dot busy\"></span>' : '')"), 'every row dotted');

    // rename: prompt() does not exist in Electron
    check('rename happens in place', code.includes('function renameInPlace(s)') && code.includes('renameInPlace(s);'), 'no inline rename');
    check('nothing calls prompt()', !/\bprompt\(/.test(code), 'prompt() is a no-op in Electron');

    // context strip + message box
    check('the strip is about changes only', !HTML.includes('id="cbRepo"') && /<div class="ctxbar" id="ctxBar"[\s\S]{0,400}id="cbDiff"/.test(HTML), 'repeats folder/branch');
    check('+0 −0 is never shown', code.includes("(ad ? '<span class=\"add\">+'") && code.includes("(rm ? '<span class=\"del\">"), 'zero counts shown');
    check('only a strip with changes opens', code.includes("cb.classList.contains('can-open')"), 'opens an empty list');
    check('Send lives at the end of the control row', /<div class="composer-row">[\s\S]*id="btnSend"[\s\S]*?<\/div>/.test(HTML) && !HTML.includes('composer-main'), 'beside the textarea');
    check('the message box grows with its text', /\.box #prompt\{[^}]*field-sizing:content[^}]*max-height:40vh/.test(HTML), 'fixed height');
    check('the footer is the keys, not backend notes', HTML.includes('<div class="composer-keys" id="cmpKeys">') && !HTML.includes('agent = vox backend (tools)'), 'dev notes');
    check('an empty box never has a live Send', code.includes('btn.disabled = !hasText && !queued;'), 'live on the start screen');

    // settings
    check('Settings is a sheet with five sections', ['account', 'spend', 'web', 'subs', 'ctx'].every((k) => HTML.includes('data-set="' + k + '"')) && HTML.includes('class="sheet"'), 'one column');
    check('hidden sections really hide', HTML.includes('.set-page[hidden]{display:none}'), 'display:flex beats [hidden]');
    check('the do-nothing Cache TTL field is gone', !HTML.includes('fCacheTtl'), 'still there');
    check('changes save as they are made', code.includes('queueSettingsSave();') && code.includes('function saveSettingsNow(withKeys)'), 'Save button only');
    check('...but never the keys', code.includes("if (!t || /^f(Key|MgmtKey|AntKey|OaiKey)$/.test(t.id)) return;") && /if \(withKeys\) \{\s*if \(\$\('fKey'\)\.value\)/.test(code), 'half-typed keys saved');
    check('a stored key leaves the field (every key, the Anthropic and OpenAI ones too)', code.includes("for (const [w, u] of Object.entries(KEY_UI)) { if ($(u.input)) $(u.input).value = ''; KEY_EDIT[w] = false; }"), 'secret left in the field');
    check('clearing the sub-agent model saves', code.includes("patch.subagentModel = $('fSubModel').value.trim();"), 'cannot reset');
    check('steppers stay inside their limits', code.includes('function clampNum(inp)'), 'unbounded');
    check('the status row opens Account', code.includes("st.onclick = () => openModal('account')"), 'dead row');
    check('usage history is a labelled button', !code.includes("btnUsage: 'gear'"), 'label replaced by an icon');
    check('the misleading balance bar is gone', !HTML.includes('bal-bar'), 'bar shows used share');
  }

  // ------------------------------------------------------------------ [AW]
  console.log('\n[AW] no control characters in source');
  {
    // Edits made through shell heredocs have repeatedly turned "\b" into a literal
    // backspace byte. Inside a regex that PARSES fine and silently never matches —
    // web_fetch's link regex shipped that way for one edit. A parse check cannot see
    // it; this can.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      // vendor/ is third-party minified code (xterm.js carries control bytes on purpose), not edited here.
      ? (e.name === 'node_modules' || e.name === 'vendor' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'test'))].filter((f) => /\.(js|html|css)$/.test(f));
    const hits = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => { if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(l)) hits.push(path.relative(ROOT, f) + ':' + (i + 1)); });
    }
    check(`${files.length} source files are free of control characters`, hits.length === 0, hits);
  }

  try { fs.rmSync(WD, { recursive: true, force: true }); } catch {}
  
// ---- Fork from one of your messages (Pi's /fork) ----
{
  const S = require(path.join(__dirname, '..', 'src', 'backend', 'sessions.js'));
  const src = S.createSession({ workdir: 'C:/p', model: 'm', title: 'Red button' });
  src.promptFrozen = 'FROZEN';
  src.messages = [
    { role: 'user', content: '[VOX CONTEXT] the project changed' },
    { role: 'user', content: 'make a red button' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: '[VOX CHECK] check it' },
    { role: 'assistant', content: 'checked' },
    { role: 'user', content: [{ type: 'text', text: 'now make it blue' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    { role: 'assistant', content: 'blue' },
    { role: 'user', content: '[VOX CMD] /review\nreview the changes' },
  ];
  check('your messages are the ones the thread draws as yours (app notes are not; a slash command is)', JSON.stringify(S.personMessages(src.messages)) === '[1,5,7]', S.personMessages(src.messages));
  const r = S.forkSession(src, { nth: 1, text: 'now make it blue' });
  check('a fork keeps everything before the message, gives it back with its picture, and keeps the cached prompt', r.ok && r.session.messages.length === 5 && r.text === 'now make it blue'
    && r.images.length === 1 && r.session.promptFrozen === 'FROZEN' && r.session.id !== src.id && r.session.title === 'Fork: Red button' && src.messages.length === 8, { ok: r.ok, n: r.session && r.session.messages.length });
  // Older turns summarised away shift the count: the text decides.
  const shifted = S.forkSession(src, { nth: 2, text: 'now make it blue' });
  check('when the count is off (turns summarised away), the text finds the right message', shifted.ok && shifted.session.messages.length === 5, shifted.session && shifted.session.messages.length);
  const cmd = S.forkSession(src, { nth: 2, text: '/review' });
  check('a slash command is forked from as you typed it', cmd.ok && cmd.text === '/review' && cmd.session.messages.length === 7, cmd.text);
  const gone = S.forkSession(src, { nth: 9, text: 'something summarised away' });
  check('a message that is no longer there says so', !gone.ok && /summarised/.test(gone.error), gone);
  const H = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  check('each of your messages has a Fork button; the fork opens with the message back in the box', H.includes("const fk = el('button', 'u-fork',") && H.includes('r = await window.voxai.sessionsFork(v.id, nth, text);')
    && H.includes("const p = $('prompt'); p.value = r.text || '';") && fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').includes("ipcMain.handle('sessions:fork'"), 'wiring');
}

// ------------------------------------------------------------------ [BB]
console.log('\n[BB] attachments: pictures and files, in the box and in the sent message');
{
  const H = HTML;
  const fn = (name, args) => { const m = new RegExp('function ' + name + '\\(' + args + '\\)\\{[\\s\\S]*?\\n\\}').exec(H); return m && m[0]; };
  const splitSrc = fn('splitAttachedFiles', 'text');
  const lineSrc = fn('attachedFileLine', 'v');
  const kindSrc = /const attKind = [^\n]+/.exec(H);
  check('the helpers are there', !!(splitSrc && lineSrc && kindSrc), { splitSrc: !!splitSrc, lineSrc: !!lineSrc, kindSrc: !!kindSrc });
  if (splitSrc && lineSrc && kindSrc) {
    const ctx = vm.createContext({ PENDING_ATTACH: [], viewDir: () => 'C:/proj', actView: () => ({}) });
    vm.runInContext(kindSrc[0].replace(/^const /, 'var ') + '\n' + splitSrc + '\n' + lineSrc, ctx);
    const split = (t) => JSON.stringify(vm.runInContext('splitAttachedFiles(' + JSON.stringify(t) + ')', ctx));
    check('the last line of @-mentions comes off as files', split('What is wrong here?\n@src/a.js @"docs/my notes.md"') === JSON.stringify({ text: 'What is wrong here?', files: ['src/a.js', 'docs/my notes.md'] }), split('What is wrong here?\n@src/a.js @"docs/my notes.md"'));
    check('a mention inside a sentence stays text', split('look at @src/a.js please') === JSON.stringify({ text: 'look at @src/a.js please', files: [] }), split('look at @src/a.js please'));
    check('only files: no text left', split('@README.md') === JSON.stringify({ text: '', files: ['README.md'] }), split('@README.md'));
    ctx.PENDING_ATTACH = [
      { kind: 'image', dataUrl: 'data:image/png;base64,AA', name: 'shot.png' },
      { kind: 'file', path: 'C:' + B + 'proj' + B + 'src' + B + 'game.js', name: 'game.js' },
      { kind: 'file', path: 'D:/elsewhere/my notes.txt', name: 'my notes.txt' },
      { dataUrl: 'data:image/png;base64,AA' }, // an older entry without a kind is a picture
    ];
    const line = vm.runInContext('attachedFileLine()', ctx);
    check('files go as mentions, inside the project from its folder, a path with spaces quoted, pictures not', line === '@src/game.js @"D:/elsewhere/my notes.txt"', line);
    // What the backend reads back from that line.
    const { findMentions } = require(path.join(ROOT, 'src/backend/mentions.js'));
    check('the backend reads the same paths back', JSON.stringify(findMentions('Fix it\n' + line)) === JSON.stringify(['src/game.js', 'D:/elsewhere/my notes.txt']), findMentions('Fix it\n' + line));
  }
  check('any file can be picked, dropped or pasted, not just pictures', H.includes('<input type="file" id="fileInput" multiple style="display:none">') && H.includes('drop-on') && /'dragenter'/.test(H), 'composer');
  check('big pictures are shrunk before they go (1568 px, 1.5 MB)', /MAX_SIDE\s*=\s*1568/.test(H) && H.includes('MAX_BYTES = 1.5 * 1048576'), 'shrinkImage');
  check('the sent message shows pictures as thumbnails that open full size, and files as chips', H.includes("el('div', 'u-imgs ' + (pics.length === 1 ? 'one' : 'many'))") && H.includes('openImageViewer(img.src') && H.includes('splitAttachedFiles(') && H.includes('window.voxai.revealFile('), 'addUser');
  check('reopening a session leaves [VOX ...] blocks out of your bubble', H.includes("!/^\\[VOX [A-Z ]+\\]/.test(p.text||'')"), 'replay filter');
  check('a file chip reveals the file in its folder, never opens or runs it', MAIN.includes("ipcMain.handle('files:reveal'") && MAIN.includes('shell.showItemInFolder(full)') && !/files:reveal[\s\S]{0,400}shell\.openPath/.test(MAIN), 'files:reveal');
  check('the session title is the text, not the attached-file line', MAIN.includes("text.replace(/\\n(@(\"[^\"]+\"|\\S+)\\s*)+$/, '')"), 'title');
}

// ------------------------------------------------------------------ [BC]
console.log('\n[BC] Linux desktop control and preview, from the Linux edition');
{
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const loadPlatform = (os) => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: os });
    try {
      const f = path.join(ROOT, 'src/backend/cu/platform.js');
      delete require.cache[require.resolve(f)];
      return require(f);
    } finally { Object.defineProperty(process, 'platform', realPlatform); delete require.cache[require.resolve(path.join(ROOT, 'src/backend/cu/platform.js'))]; }
  };
  const L = loadPlatform('linux');
  check('on Linux the desktop backend is xdotool / xwininfo', L.backend === 'linux' && L.native === require(path.join(ROOT, 'src/backend/cu/linux-native.js')), L.backend);
  check('keys parse the same on Linux (parseKeys borrowed from the Windows module)', typeof L.input.parseKeys === 'function' && typeof L.input.pressKeys === 'function', typeof L.input.parseKeys);
  const W = loadPlatform('win32');
  check('on Windows it is UI Automation, as before', W.backend === 'windows' && W.native === require(path.join(ROOT, 'src/backend/cu/native.js')), W.backend);
  check('macOS has no backend yet, and says so', loadPlatform('darwin').backend === 'none', 'darwin');
  const keysOf = (m) => Object.keys(require(path.join(ROOT, 'src/backend/cu', m)));
  const missing = [['win-input', 'linux-input'], ['native', 'linux-native']]
    .flatMap(([w, l]) => keysOf(w).filter((k) => k !== 'parseKeys' && !keysOf(l).includes(k)).map((k) => l + '.' + k));
  check('the Linux modules have everything the Windows ones offer', missing.length === 0, missing);
  const DESK = read('src/backend/cu/desktop.js') + read('src/backend/cu/index.js');
  check('desktop.js and index.js take their modules from platform.js', /require\('\.\/platform'\)/.test(DESK) && !/require\('\.\/(win-input|native|uia)'\)/.test(DESK), 'requires');
  check('a Linux preview is nudged a pixel after each load so the compositor repaints it', /function nudgeView\(v\)/.test(MAIN) && /function nudgeWindow\(\)/.test(MAIN) && /did-frame-finish-load/.test(MAIN), 'nudge');
  check('on Linux parked previews stay under the chat in the window (Wayland has no hidden window)', MAIN.includes("const PARK_IN_WINDOW = process.platform === 'linux';") && MAIN.includes('rootV.addChildView(v, 0);'), 'park');
  check('a preview shown again goes back in the window even if something took it out', MAIN.includes('inTree = kids.includes(v)') && MAIN.includes('if (v._onTop === onTop && inTree) return;'), 'inTree');
}

// ------------------------------------------------------------------ [BD]
console.log('\n[BD] macOS groundwork');
{
  const LE = require(path.join(ROOT, 'src/main/local-engine.js'));
  for (const arch of ['arm64', 'x64']) {
    const e = LE.engineFor('darwin', arch);
    check(`llama.cpp's macOS ${arch} build is pinned and checked`, !!e && /macos-/.test(e.file) && /^[0-9a-f]{64}$/.test(e.sha256) && e.kind === 'tgz', e);
  }
  const ENG = read('src/main/local-engine.js');
  check('the engine finds its libraries and cores on a Mac', ENG.includes('DYLD_LIBRARY_PATH') && ENG.includes('hw.physicalcpu'), 'engine');
  check('the window keeps the traffic lights and the Edit menu on a Mac', MAIN.includes("titleBarStyle: 'hiddenInset'") && MAIN.includes("role: 'appMenu'") && MAIN.includes("role: 'editMenu'"), 'window');
  check("the page leaves room for the traffic lights and hides its own buttons there", HTML.includes('html[data-platform="darwin"] .titlebar') && HTML.includes('document.documentElement.dataset.platform'), 'titlebar');
  check('shortcuts use Cmd on a Mac and show as ⌘', /const MOD = \(e\) => \(IS_MAC \? e\.metaKey : e\.ctrlKey\)/.test(HTML) && HTML.includes("'\\u2318'") && !/keys: \['Ctrl', '(N|K|O|L|V|,)'\]/.test(HTML), 'MOD');
  const UPD = read('src/main/updater.js');
  check('updates are off on a Mac, with a reason, until there is a signed build', UPD.includes("process.platform === 'darwin'") && UPD.includes('This Mac build does not update itself yet'), 'updater');
  check('the Dock shows how many sessions wait for you', read('src/main/attention.js').includes('app.setBadgeCount('), 'badge');
  const PKG = JSON.parse(read('package.json'));
  const mac = PKG.build && PKG.build.mac;
  check('npm run dist:mac makes a dmg and zip for both Mac chips', !!(PKG.scripts['dist:mac'] && mac && JSON.stringify(mac.target).includes('dmg') && JSON.stringify(mac.target).includes('arm64') && mac.entitlements && fs.existsSync(path.join(ROOT, mac.entitlements)) && fs.existsSync(path.join(ROOT, mac.icon))), mac);
  const CLEAN = read('scripts/clean-release.js');
  const BUILT = new RegExp(/const BUILT = \/(.*)\/i;/.exec(CLEAN)[1], 'i');
  check('a new build clears the last Mac build too', ['VoxAI-Coder-0.2.87-mac-arm64.dmg', 'VoxAI-Coder-0.2.87-mac-x64.zip', 'latest-mac.yml'].every((n) => BUILT.test(n)) && !BUILT.test('notes.zip') && CLEAN.includes("'mac-arm64'"), 'clean-release');
  check('the porting notes are there', fs.existsSync(path.join(ROOT, '..', 'docs', 'MACOS.md')), 'docs/MACOS.md');
}

// ------------------------------------------------------------------ [BE]
console.log('\n[BE] Settings > Appearance: theme, accent, message text, reduced motion');
{
  const AJS = read('src/renderer/appearance.js');
  // Run appearance.js against a fake page, as the <head> script it is.
  const props = {}, classes = new Set(), head = { children: [], appendChild(n) { this.children.push(n); } };
  const root = { dataset: {}, style: { setProperty: (k, v) => { props[k] = v; } }, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  let darkOS = true, reduceOS = false;
  const win = {
    voxai: { appearance: () => ({ theme: 'light', accent: 'blue', msgSize: 'l', reduceMotion: null }) },
    matchMedia: (q) => ({ get matches() { return /dark/.test(q) ? darkOS : reduceOS; }, addEventListener() {} }),
  };
  const doc = { documentElement: root, head, getElementById: (id) => head.children.find((n) => n.id === id) || null, createElement: () => ({}) };
  vm.runInNewContext(AJS, { window: win, document: doc, getComputedStyle: () => ({ getPropertyValue: (k) => (k === '--edge2' ? '#c9c2b5' : '') }) });
  const VA = win.VoxAppearance;
  check('it themes the page before it paints, from the saved settings', root.dataset.theme === 'light' && props['--gold'] === '#2f5fbf' && props['--msg-fs'] === '16.5px', { theme: root.dataset.theme, props });
  check('the scrollbars are written for the theme (custom properties do not reach them)', head.children.some((n) => n.id === 'voxScrollbars' && /#c9c2b5/.test(n.textContent)), head.children.map((n) => n.id));
  VA.apply({ theme: 'system' });
  check('System follows the computer: dark', root.dataset.theme === 'dark', root.dataset.theme);
  darkOS = false; VA.apply({ theme: 'system' });
  check('and light', root.dataset.theme === 'light', root.dataset.theme);
  VA.apply({ theme: 'nonsense', accent: 'nonsense' });
  check('an unknown theme or accent falls back to dark and gold', root.dataset.theme === 'dark' && props['--gold'] === '#c8a961', props['--gold']);
  // Every preset reads on every theme, and its text is readable on it.
  const lum = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const weak = [];
  for (const t of ['dark', 'midnight', 'light']) for (const k of [...Object.keys(VA.ACCENTS), '#fff8e0', '#101010']) {
    const c = VA.accentFor(k, t);
    if (ratio(c.gold, VA.BG[t]) < 3 || ratio(c.gold, c.on) < 4.5) weak.push(`${k} on ${t}: ${ratio(c.gold, VA.BG[t]).toFixed(2)} / ${ratio(c.gold, c.on).toFixed(2)}`);
  }
  check('every accent, presets and odd colours of your own, reads on every theme (3:1) and under its own text (4.5:1)', weak.length === 0, weak);
  reduceOS = true; VA.apply({ reduceMotion: null });
  check('reduce motion follows the system unless you set it', classes.has('calm'), [...classes]);
  VA.apply({ reduceMotion: false });
  check('and you can turn it off anyway', !classes.has('calm'), [...classes]);

  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const rules = css.replace(/:root\{[^}]*\}/, '');   // the tokens themselves are defined there
  check('no gold literal is left in the stylesheet: the accent is a token', !/rgba\(200,169,97/.test(rules) && !/#d8bb74|#16130c/.test(rules) && (css.match(/color-mix\(in srgb,var\(--gold\)/g) || []).length >= 30, 'literals');
  check('Midnight and Light redefine the surface and text tokens, and Light darkens the code colours', /html\[data-theme="midnight"\]\{[^}]*--bg:/.test(css) && /html\[data-theme="light"\]\{[^}]*--ink:[^}]*color-scheme:light/.test(css) && css.includes('html[data-theme="light"] .tk-kw'), 'themes');
  check('appearance.js loads in <head>, from the app (the CSP allows it as \'self\')', /<script src="appearance\.js"><\/script>\s*<\/head>/.test(HTML), 'head');
  check('message text size reaches the conversation', css.includes('.md{font-size:var(--msg-fs,15px);') && css.includes('font-size:calc(var(--msg-fs,15px) - .5px)'), 'msg-fs');
  check('the page has the Appearance section: theme, accent, text size, motion, a preview and a reset', HTML.includes('data-set="look"') && ['apTheme', 'apAccent', 'apSize', 'apCalm', 'apReset'].every((id) => HTML.includes(`id="${id}"`)) && HTML.includes('class="ap-prev"'), 'markup');
  check('a change is saved, shown in every pane, and behind the page as it loads', MAIN.includes("ipcMain.on('appearance:get'") && MAIN.includes("allRenderers().send('appearance', a)") && MAIN.includes('w.setBackgroundColor(appearanceBg(a))')
    && read('src/main/split.js').includes('view.setBackgroundColor((typeof background === \'function\' && background()) || \'#0e0e10\')') && read('src/preload/preload.js').includes("ipcRenderer.sendSync('appearance:get')"), 'wiring');
  check('stored values are checked: a hand-edited file cannot inject CSS through the accent', MAIN.includes("accent: typeof raw.accent === 'string' && (/^[a-z]{3,10}$/.test(raw.accent) || /^#[0-9a-f]{6}$/i.test(raw.accent)) ? raw.accent : 'gold'"), 'accent check');
}

// ------------------------------------------------------------------ [BF]
console.log('\n[BF] Settings > Computer use: the browser and the desktop, each with its own switch');
{
  const T = require(path.join(ROOT, 'src/backend/tools'));
  const build = (cu) => T.buildTools({ workdir: ROOT, session: { id: 'cu-test', messages: [] }, emit: () => {}, checkPermission: async () => {}, resolveIn: (a, b) => path.resolve(a, b), getSettings: () => ({}), getAccess: () => 'full', computerUse: cu }).ALL;
  const comp = (cu) => build(cu).find((t) => t.def.function.name === 'computer');
  const loader = (cu) => build(cu).find((t) => t.def.function.name === 'load_tools');
  check('on by default: the computer tool is there, waiting behind load_tools', !!comp(null) && comp(null).deferred === true && /computer:/.test(loader(null).def.function.description), 'default');
  check('both off: no computer tool at all, and load_tools does not offer it', !comp({ browser: false, desktop: false }) && !/computer:/.test(loader({ browser: false, desktop: false }).def.function.description), 'both off');
  const refused = async (cu, args) => { try { await comp(cu).run(args, { session: { id: 'cu-test' } }); return ''; } catch (e) { return e.message; } };
  check('desktop off: a desktop action says it is turned off, and where', /desktop is turned off \(Settings > Computer use\)/.test(await refused({ browser: true, desktop: false }, { action: 'list', backend: 'native' })), await refused({ browser: true, desktop: false }, { action: 'list', backend: 'native' }));
  check('browser off: a browser action says so', /browser is turned off/.test(await refused({ browser: false, desktop: true }, { action: 'open', url: 'https://example.com' })), await refused({ browser: false, desktop: true }, { action: 'open', url: 'https://example.com' }));
  check('the tool tells the model which half is off', /Desktop apps are turned off in Settings/.test(comp({ browser: true, desktop: false }).def.function.description), 'desc');
  check('it names the desktop it drives, not always Windows', /DESKTOP_NAME = process\.platform === 'win32' \? 'Windows' : process\.platform === 'linux'/.test(read('src/backend/tools/index.js')), 'name');

  const A = require(path.join(ROOT, 'src/backend/agent.js'));
  const P = (cu) => A._systemPrompt('W', 'auto', false, '', true, cu);
  check('the prompt says computer use is there (the tool waits behind load_tools, so models rarely knew)', /You can use a browser \(the preview the user sees\)/.test(P(null)) && /load it with load_tools/.test(P(null)), P(null).slice(0, 80));
  check('and says when it is off, so it does not try', /Computer use is turned off in Settings/.test(P({ browser: false, desktop: false })) && !/You can use/.test(P({ browser: false, desktop: false })), 'off');
  check('desktop off: only the browser is offered in words', /Desktop apps are not available to you/.test(P({ browser: true, desktop: false })), 'desktop off');
  check('a model on this PC (not given the tool) is told nothing about it', !/computer tool|Computer use/.test(P('none')), 'local');
  const AG = read('src/backend/agent.js');
  check('a turned-off surface is not asked about first (the approval came, then the refusal)', AG.includes("if (name === 'computer' && computerUse && (surface === 'native' ? computerUse.desktop === false : computerUse.browser === false)) return null;"), 'gate');
  check('sub-agents follow the switches too (Team\'s coder included)', AG.includes('maxTokensOf, maxTokens, webSearch, computerUse, onOpenUrl') && read('src/backend/tools/spawn.js').includes('computerUse: agentOpts.computerUse || null,'), 'agentOpts');
  check('the run is given the switches from Settings', MAIN.includes('computerUse: { browser: s.cuBrowser, desktop: s.cuDesktop },') && MAIN.includes('cuBrowser: raw.cuBrowser !== false,') && MAIN.includes('cuDesktop: raw.cuDesktop !== false,'), 'settings');

  const st = require(path.join(ROOT, 'src/backend/cu/platform.js')).status();
  check('the status says what this system can do, without taking a screenshot', typeof st.ok === 'boolean' && typeof st.system === 'string' && Array.isArray(st.missing) && !/screenshot\(|captureSupported\(/.test(read('src/backend/cu/platform.js').slice(read('src/backend/cu/platform.js').indexOf('function status'))), st);
  check('the Computer use page: two switches, the status, the skill, Try it', HTML.includes('data-set="cu"') && ['cuBrowserTog', 'cuDesktopTog', 'cuStatus', 'cuSkill', 'cuTry'].every((id) => HTML.includes(`id="${id}"`))
    && HTML.includes("['cuBrowserTog', 'cuBrowser'], ['cuDesktopTog', 'cuDesktop']") && MAIN.includes("ipcMain.handle('cu:status'"), 'page');
  check('the status rows escape what they show (el() sets innerHTML)', HTML.includes("tx.appendChild(el('div', 'set-lbl', esc(label)));") && HTML.includes("const d = el('div', 'set-desc', esc(desc));"), 'esc');
  const SK = fs.readFileSync(path.join(ROOT, 'resources/skills/computer-use/SKILL.md'), 'utf8');
  check('the skill covers Linux, says macOS is not there yet, and that a switch may be off', /Windows, or Linux on X11 and XWayland/.test(SK) && /\*\*Linux\*\*/.test(SK) && /\*\*macOS\*\*: not available yet/.test(SK) && /Settings > Computer use/.test(SK), 'skill');
}

console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
