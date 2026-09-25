/**
 * Renderer regression tests — the pure logic inside index.html.
 *
 * The tool-result summariser is the difference between a transcript that reads as a
 * description of what happened and one that reads as a JSON dump, so it is worth
 * holding still. It lives in the renderer HTML, so we extract it and evaluate it
 * rather than duplicating it here — a copy would drift.
 *
 * Also checks the renderer script parses at all: a stray newline inside a string or
 * regex kills the whole UI silently, which has happened twice during this work.
 *
 * Run: node test/regression-renderer.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.VOX_ROOT || path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  got: ' + JSON.stringify(got)); }
};

function inlineScripts() {
  return [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

console.log('\n[S] renderer script integrity');
const blocks = inlineScripts();
check('renderer has an inline script', blocks.length >= 1, blocks.length);
let parseErr = '';
for (const b of blocks) {
  try { new vm.Script(b); } catch (e) { parseErr = e.message; break; }
}
check('every inline script parses', !parseErr, parseErr);

// A script tag with src= ignores inline content — putting code there silently drops it.
const srcWithBody = /<script[^>]*\bsrc=[^>]*>\s*[^\s<][\s\S]*?<\/script>/.test(HTML);
check('no code hidden inside a src= script tag', !srcWithBody, 'found one');

console.log('\n[T] tool result summariser');
const fnSrc = /function summariseResult\(name, raw, ok\)\{[\s\S]*?\n\}/.exec(HTML);
check('summariseResult is present', !!fnSrc, 'missing');

if (fnSrc) {
  const ctx = { module: {} };
  vm.createContext(ctx);
  new vm.Script(fnSrc[0] + '\nmodule.exports = summariseResult;').runInContext(ctx);
  const sum = ctx.module.exports;
  const J = (o) => JSON.stringify(o);

  check('file read reports line count', sum('read', J({ path: 'a', lines: 312 }), true) === '312 lines', sum('read', J({ lines: 312 }), true));
  check('truncated read says so', /truncated/.test(sum('read', J({ lines: 4000, truncated: true }), true)), sum('read', J({ lines: 4000, truncated: true }), true));
  check('edit reports a replacement', sum('edit', J({ replaced: 24, match: 'exact' }), true) === 'replaced', sum('edit', J({ replaced: 24, match: 'exact' }), true));
  check('a fuzzy match is called out', /line-trimmed/.test(sum('edit', J({ replaced: 5, match: 'line-trimmed' }), true)), sum('edit', J({ replaced: 5, match: 'line-trimmed' }), true));
  check('patch reports edit count', sum('patch', J({ edits: 3 }), true) === '3 edits', sum('patch', J({ edits: 3 }), true));
  check('write reports bytes', sum('write', J({ bytes: 1840 }), true) === '1,840 bytes', sum('write', J({ bytes: 1840 }), true));
  check('grep reports match count', sum('grep', J({ hits: [1, 2, 3] }), true) === '3 matches', sum('grep', J({ hits: [1, 2, 3] }), true));
  check('one match is singular', sum('grep', J({ hits: [1] }), true) === '1 match', sum('grep', J({ hits: [1] }), true));
  check('glob reports file count', sum('glob', J({ files: [1, 2], total: 57 }), true) === '57 files', sum('glob', J({ files: [1, 2], total: 57 }), true));

  // A failed verification must be visible in the one-line summary, not buried.
  check('unparseable write is flagged inline',
    sum('write', J({ path: 'a', bytes: 10, verification: { verified: 'failed' } }), true) === 'written · does not parse',
    sum('write', J({ path: 'a', verification: { verified: 'failed' } }), true));

  // Shell output is plain text; the verdict is at the END, not the start.
  check('shell shows the last meaningful line',
    sum('shell', '> voxai@0.1.0 test\n\nrunning…\n147 passed, 0 failed', true) === '147 passed, 0 failed',
    sum('shell', '> voxai@0.1.0 test\n\nrunning…\n147 passed, 0 failed', true));

  // Errors strip the machine prefix the model needs but a person does not.
  const err = sum('write', 'DENIED_OR_ERROR: src/x.js was written, but it does not parse.', false);
  check('error drops the DENIED_OR_ERROR prefix', !/DENIED_OR_ERROR/.test(err), err);
  check('error keeps the message', /does not parse/.test(err), err);

  // Sub-agent receipts summarise to what changed.
  check('sub-agent reports files changed',
    sum('spawn_agent', J({ files_changed: [{ path: 'a' }, { path: 'b' }], stopReason: 'completed' }), true) === '2 files changed',
    sum('spawn_agent', J({ files_changed: [{ path: 'a' }, { path: 'b' }], stopReason: 'completed' }), true));
  check('an incomplete sub-agent says why',
    /budget/.test(sum('spawn_agent', J({ files_changed: [{ path: 'a' }], stopReason: 'budget' }), true)),
    sum('spawn_agent', J({ files_changed: [{ path: 'a' }], stopReason: 'budget' }), true));
  check('backgrounded dispatch is labelled',
    sum('spawn_agent', J({ status: 'running', subId: 'x' }), true) === 'started in background',
    sum('spawn_agent', J({ status: 'running' }), true));

  check('empty result never renders blank', sum('read', '', true) === 'done', sum('read', '', true));
  check('nothing is ever raw JSON', !/[{}"]/.test(sum('read', J({ lines: 9 }), true)), sum('read', J({ lines: 9 }), true));
}

console.log('\n[U] context bar');
check('context bar markup exists', /id="ctxBar"/.test(HTML), 'missing');
// Each shown once, where it belongs: the project in the title bar, the branch in the
// header, the changes (and files touched) on the strip above the message box.
check('it shows repo, branch, diff and touched files',
  ['tbProj', 'cbBranch', 'cbDiff', 'cbTouched'].every((id) => HTML.includes('id="' + id + '"')), 'incomplete');
check('touched files come from mutation receipts', /noteTouched\(sid, event\.mutated\.path\)/.test(HTML), 'not wired');
check('background agent changes count too', /for \(const f of \(event\.files_changed \|\| \[\]\)\) noteTouched/.test(HTML), 'not wired');
check('git state refreshes when a run ends', /refreshUsage\(\); refreshCtx\(\);/.test(HTML), 'not wired');

console.log('\n[V] every backend event has a renderer branch');
// An emitted event with no handler is silent: the work happened and the user never
// learns of it. `artifact` was exactly that — publishing succeeded and showed nothing.
const SRC_DIRS = ['src/backend', 'src/backend/tools', 'src/backend/cu'];
const emitted = new Set();
for (const d of SRC_DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\btype:\s*'([a-z_]+)'/g)) emitted.add(m[1]);
  }
}
// A broad scan also catches JSON-Schema keywords and action maps like
// `{ click: 'cu_click', type: 'cu_type' }`. Narrowing the regex to emission sites
// instead looked cleaner but silently dropped token/sub/image/display, which are
// emitted through callbacks and Object.assign — false confidence is worse than a
// short exclusion list, so the list is explicit and the tool names come from the
// live registry rather than being hand-maintained.
const SCHEMA_KEYWORDS = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'function', 'text', 'image_url', 'ephemeral']);
let TOOL_NAMES = new Set();
try {
  const t = require(path.join(ROOT, 'src/backend/tools'));
  TOOL_NAMES = new Set(t.buildTools({
    workdir: process.cwd(), session: { id: 'x', messages: [] }, emit: () => {},
    checkPermission: async () => {}, resolveIn: (a, b) => b, getSettings: () => ({}), getAccess: () => 'full',
  }).ALL.map((x) => x.def.function.name));
} catch { /* registry unavailable — the exclusion just does less */ }
// Members folded behind a facade (cu_*, browser_*, mcp_*, skill*_, spawn_*) still
// appear as action-map VALUES in the registry, but are no longer tool names.
const FOLDED_MEMBER = /^(cu_|browser_|mcp_|skills?_|spawn_)/;
const uiEvents = [...emitted]
  .filter((t) => !SCHEMA_KEYWORDS.has(t) && !TOOL_NAMES.has(t) && !FOLDED_MEMBER.test(t))
  .sort();
const unhandled = uiEvents.filter((t) => !HTML.includes("'" + t + "'"));
check('no backend event is unhandled by the UI', unhandled.length === 0, unhandled);
console.log('        (' + uiEvents.length + ' event types checked: ' + uiEvents.join(', ') + ')');

console.log('\n[W] DOM API misuse that fails silently');
// `children` / `childNodes` are collections, not arrays. Calling an array method on
// one throws at runtime inside an event branch, killing that branch only — so the
// feature simply never appears and nothing is logged. This actually happened to the
// compaction notice.
const badCollection = [...HTML.matchAll(/\.(children|childNodes)\.(find|filter|map|forEach|some|every|reduce)\s*\(/g)]
  .map((m) => m[0]);
check('no array methods called on HTMLCollection', badCollection.length === 0, badCollection);


console.log('\n[Z] preview panel state');
// The agent can open Atlas itself, so the renderer must be TOLD, not left to guess.
check('renderer subscribes to pushed preview state', HTML.includes('preview.onState(ppSyncState)'), 'not subscribed');
check('close clears the dragged inline width', HTML.includes("p.style.width = ''"), 'stale width kept');
check('toggle asks main, not the DOM', HTML.includes('await window.voxai.preview.state()'), 'reads DOM only');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
check('main broadcasts state changes', (MAIN.match(/broadcastPreviewState\(\)/g) || []).length >= 3, 'not broadcast');
check('closing resets the split', /atlasOpen = false;[\s\S]{0,140}atlasFrac = 0\.5/.test(MAIN), 'split not reset');

console.log('\n[AA] a warning is not an error');
check('warnings default to amber', /\.\msg\.\warn{[^}]*var\(--gold\)/.test(HTML), 'still red');
check('only real breakage goes red', HTML.includes("' severe'"), 'no severity split');
const AG = fs.readFileSync(path.join(ROOT, 'src/backend/agent.js'), 'utf8');
check('one helper reads every cache field', AG.includes('function cacheReadTokens'), 'missing helper');
check('accounting and warning agree', (AG.match(/cacheReadTokens\(/g) || []).length >= 3, 'not shared');
check('unknown is not treated as zero', AG.includes('null = provider did not report it'), 'still assumes zero');


console.log('\n[AB] the preview is a real panel, not a bare view');
// A WebContentsView cannot be styled from the renderer, so if it owns its own half
// of the window it always reads as a separate window pasted alongside. The DOM owns
// the chrome; the view is slotted into a measured hole in its body.
check('panel keeps its header and address bar', HTML.includes('id="ppUrl"') && HTML.includes('id="ppHost"'), 'chrome missing');
check('panel has nav controls', ['ppBack','ppFwd','ppReload','ppClose'].every((id) => HTML.includes('id="' + id + '"')), 'controls missing');
check('renderer measures the slot', HTML.includes('function syncViewport'), 'no measurement');
check('it measures the panel body', HTML.includes("$('ppBody')") && HTML.includes('getBoundingClientRect'), 'wrong element');
check('the slot is re-reported on reflow', HTML.includes('ResizeObserver'), 'drifts on resize');
check('main honours the reported rect', MAIN.includes("'preview:viewport'") && MAIN.includes('previewRect'), 'ignores it');
check('chat view always fills the window', MAIN.includes('chatV.setBounds({ x: 0, y: 0, width: W, height: H })'), 'still splits');
check('address bar follows real navigation', MAIN.includes("'did-navigate'") && HTML.includes('ppSetUrl(st.url)'), 'stale url');
// Waiting for main to echo the URL back left the bar reading "http://localhost"
// while a different page was already loading into the panel.
check('address bar paints the destination on open', /function ppOpen[\s\S]{0,400}ppSetUrl\(url\)/.test(HTML), 'waits for the round trip');
check('the stop-gap strip is retired', HTML.includes('no longer needed'), 'duplicate chrome');

console.log('\n[AJ] the panel eases, and its scrollbars belong to the app');
// It appeared and disappeared in one frame. A keyframe fade cannot fix that: the
// browser view is slotted into the body and is not part of page compositing, so the
// hole must have a real width every frame for the view to travel with it.
check('open/close is a width transition', /\.preview-panel\{[^}]*transition:width/.test(HTML), 'still pops');
check('the open state is a class, not display', HTML.includes('.preview-panel.open{'), 'display toggle');
check('min-width eases too', /\.preview-panel\{[^}]*min-width var\(--pp-ease-ms\)/.test(HTML), 'clamps on frame one');
check('the collapsed panel starts at zero width', /\.preview-panel\{[^}]*width:0/.test(HTML), 'nothing to ease from');
// The compositor never calls back into script, so the slot has to be re-measured
// per frame or the view snaps at the end of an animation it sat out.
check('the slot is pumped per frame', HTML.includes('function ppPumpViewport') && HTML.includes('requestAnimationFrame(step)'), 'view snaps');
check('opening pumps it', /function ppSetOpen[\s\S]{0,900}ppPumpViewport\(\)/.test(HTML), 'not pumped');
check('a start frame is forced before easing', HTML.includes('void p.offsetWidth'), 'transition skipped');
check('an inline drag width cannot block the collapse', /function ppSetOpen[\s\S]{0,900}p\.style\.width = ''/.test(HTML), 'panel sticks open');
// Blanking the view up front left an empty box shrinking.
check('the view is dropped after the collapse, not before', /function ppClose[\s\S]{0,700}setTimeout\(/.test(HTML), 'content blanks first');
// A hard-coded duration in script drifts from the one in CSS, and when it does the
// panel is torn down mid-collapse and vanishes in a jump.
check('the duration has one source of truth', HTML.includes('function ppAnimMs') && HTML.includes("getPropertyValue('--pp-ease-ms')"), 'duplicated');
check('nothing hard-codes it any more', !HTML.includes('PP_ANIM_MS'), 'constant survives');
check('reopening mid-collapse cancels the teardown', HTML.includes("if (p && p.classList.contains('open')) return;"), 'closes anyway');
check('a drag opts out of the easing', HTML.includes('.preview-panel.dragging{transition:none}'), 'panel lags the cursor');
check('the divider eases shut with the panel', HTML.includes('.pp-divider.open{'), 'vanishes on frame one');
check('reduced motion is honoured', HTML.includes('prefers-reduced-motion'), 'forced animation');
// Default scrollbars read as OS furniture sitting on top of the app.
check('app scrollbars are themed', HTML.includes('::-webkit-scrollbar-thumb{background-color:#2e2e34'), 'default thumb');
// var() does not resolve reliably inside scrollbar pseudo-elements; a silent
// fallback there is the OS scrollbar, which is what this replaces.
check('scrollbar colours avoid var()', !/::-webkit-scrollbar-thumb\{background:var\(/.test(HTML), 'may fall back');
check('horizontal scrollbars too', /::-webkit-scrollbar\{width:10px;height:10px\}/.test(HTML), 'height unset');
// Injected CSS dies with the document, so it has to run per navigation.
check('preview pages get the same scrollbars', MAIN.includes('PREVIEW_SCROLLBAR_CSS') && MAIN.includes('insertCSS'), 'default scrollbars in preview');
check('injection repeats on every navigation', /'dom-ready'[\s\S]{0,200}insertCSS/.test(MAIN), 'once at startup only');
// ppHistory is only fed by the no-Electron text fallback, so under Electron it was
// empty and the header's "open externally" read undefined and did nothing.
check('open externally uses the live URL', HTML.includes('let ppLiveUrl') && /ppExternal'\)\.onclick[\s\S]{0,300}ppLiveUrl/.test(HTML), 'reads empty history');
check('the live URL tracks navigation', /function ppSetUrl[\s\S]{0,120}ppLiveUrl = url/.test(HTML), 'never updated');
check('only safe schemes open externally', /shell:openExternal'[\s\S]{0,400}https\?\|file/.test(MAIN), 'any protocol handler');

console.log('\n[AK] sub-agent runs are legible while they run');
const AG3 = fs.readFileSync(path.join(ROOT, 'src/backend/agent.js'), 'utf8');
const SPAWN = fs.readFileSync(path.join(ROOT, 'src/backend/tools/spawn.js'), 'utf8');
// `yield` cannot cross an `await`. Everything a tool emitted sat in emitQueue until
// the call returned, so a 5-way fan-out showed NOTHING for minutes -- a live run
// that is indistinguishable from a hang.
check('the queue drains while a tool runs', /toolSettled[\s\S]{0,600}while \(emitQueue\.length\)[\s\S]{0,200}yield/.test(AG3), 'drains only after');
check('emitting wakes the loop', AG3.includes('const pushEvent') && AG3.includes('emitWake'), 'no wake-up');
check('every emitter goes through it', !AG3.includes('emit: (e) => emitQueue.push(e)'), 'bypasses the wake-up');
check('a lost wake-up cannot stall the run', /emitWake = res; setTimeout\(res,/.test(AG3), 'can hang');
check('the tool error still propagates', AG3.includes('if (outcome.error) throw outcome.error;'), 'errors swallowed');
// Five concurrent workers were five identical unlabelled boxes.
check('a sub-agent announces what it is', SPAWN.includes("broadcast(sub.id, 'start'"), 'anonymous');
check('the row labels its worker from that', /ev === 'start'\) \{ W\.role = [^\n]*W\.label = String\(event\.label/.test(HTML), 'ignored');
check('the title is not a list of tool names', !HTML.includes("card._title.textContent + ' / '"), 'header fills with tool names');
// A worker's actions are the same quiet rows as the thread's, each opening on click.
check('a worker\'s actions are rows', HTML.includes('function subActRow(act)') && /line\.onclick = \(\) => \{ if \(inner\.hidden\) fillDetail\(inner, act\)/.test(HTML), 'no rows');
check('the live preview is bounded', HTML.includes('next.slice(-400)'), 'unbounded wall of text');
check('the preview goes when the report lands', /W\.state = ev === 'done'[^\n]*W\.live = '';/.test(HTML), 'same text twice');
check('worker detail starts collapsed', HTML.includes("const inner = el('div', 'tr-card tr-inner'); inner.hidden = true;"), 'opens expanded');

console.log('\n[AM] T1 rail; delegation lives on the row that delegated it');
// They were the same object: 1px border, 8px radius, --panel fill, chevron, title,
// right-aligned status. Two different things in one costume.
check('reasoning has no border, fill or radius', /\.think\{display:grid;grid-template-columns:9px/.test(HTML), 'still a box');
check('the rail replaces the chrome', HTML.includes('.think-rail{') && HTML.includes("el('div', 'think-rail')"), 'no rail');
check('the rail settles when thinking stops', HTML.includes('.think.sealed .think-rail{'), 'pulses forever');
// A sub-agent's progress was a separate table; while a reviewer thought for three
// minutes the row that started it said only "Delegating". Found in a live run.
check('sub-agent events reach the delegating row', HTML.includes('if (host) subEvent(host, event);') && HTML.includes('v._subHost = rec;'), 'separate table');
check('the row says what the worker is doing', HTML.includes("return { html: rec.subs && rec.subs.size ? subMeta(rec) : '' };") && HTML.includes('function subDoing(W)'), 'just Delegating');
check('a fan-out is one row, its workers inside', /ws\.length \+ ' agents'/.test(HTML) && HTML.includes('function fillSubs(box, rec)'), 'row per worker');
// An interval left running keeps repainting a finished row forever.
check('one timer per row, stopped when nothing runs', HTML.includes('if (running && !rec._subTimer) {') && /if \(!live \|\| !\(rec\.view && rec\.view\.busy\)\) \{ clearInterval\(rec\._subTimer\)/.test(HTML), 'leaks');
check('the note repaints alone, the spinner keeps turning', HTML.includes('function paintRowMeta(g)'), 'whole row every second');
check('role colour is separate from status colour', HTML.includes('.tr-role.explore{') && HTML.includes('.tr-role.review{'), 'role doubles as status');
check('the old table is gone', !HTML.includes('sub-ledger') && !HTML.includes('sealLedger'), 'still there');

console.log('\n[AN] the message queue can be reordered');
check('every queued row has a grip', HTML.includes("el('button', 'q-grip')") && HTML.includes("icon('grip'"), 'no handle');
check('the grip is dots, not strokes', /grip: '<circle[\s\S]{0,600}fill="currentColor"/.test(HTML), 'draws blank');
// Making the whole pill draggable broke text selection and caused accidental drags.
check('only the grip starts a drag', /grip\.onmousedown = \(\) => \{ pill\.draggable = true/.test(HTML), 'whole row drags');
check('draggable is cleared afterwards', /ondragend[\s\S]{0,200}pill\.draggable = false/.test(HTML), 'row stays draggable');
check('the drop target is a line between rows', HTML.includes('.drop-before') && HTML.includes('.drop-after'), 'highlights a row');
// A marker promising a move that then does nothing reads as a broken control.
check('a no-op drop is not marked', HTML.includes('if (to === dragFrom || to === dragFrom + 1) return;'), 'marks a no-op');
check('reordering is keyboard reachable', /e\.altKey[\s\S]{0,400}ArrowUp[\s\S]{0,400}ArrowDown/.test(HTML), 'mouse only');
check('the grip keeps focus after a move', HTML.includes('function focusGrip'), 'focus lost each move');
// steerIdx is an index, not a reference: a reorder must carry it.
check('a steered message keeps its steer', HTML.includes('function moveQueued') && HTML.includes('v.queue.indexOf(steered)'), 'steer retargets');
check('the index shift is accounted for', HTML.includes('to > from ? to - 1 : to'), 'off-by-one on downward moves');
check('drop marks are cleared without array methods', HTML.includes('function clearDropMarks') && !/\.querySelectorAll\('\.drop-before, \.drop-after'\)\.forEach/.test(HTML), 'NodeList misuse');

// And moveQueued itself, run for real.
const mvSrc = /function moveQueued\(v, from, to\)\{[\s\S]*?\n\}/.exec(HTML);
check('moveQueued is extractable', !!mvSrc, 'missing');
if (mvSrc) {
  const mctx = { module: {}, renderQueue: () => {}, updateSendState: () => {}, updateSteerHint: () => {} };
  vm.createContext(mctx);
  new vm.Script(mvSrc[0] + '\nmodule.exports = moveQueued;').runInContext(mctx);
  const mv = mctx.module.exports;
  const mk = () => ({ queue: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }], steerIdx: null });
  const txt = (v) => v.queue.map((x) => x.text).join('');
  let v;
  v = mk(); mv(v, 0, 4); check('first moves to last', txt(v) === 'BCDA', txt(v));
  v = mk(); mv(v, 3, 0); check('last moves to first', txt(v) === 'DABC', txt(v));
  v = mk(); mv(v, 1, 3); check('a downward move lands where dropped', txt(v) === 'ACBD', txt(v));
  v = mk(); mv(v, 2, 1); check('an upward move lands where dropped', txt(v) === 'ACBD', txt(v));
  v = mk(); mv(v, 1, 2); check('dropping in place changes nothing', txt(v) === 'ABCD', txt(v));
  v = mk(); mv(v, 9, 0); check('an out-of-range move is refused', txt(v) === 'ABCD', txt(v));
  v = mk(); v.steerIdx = 2; mv(v, 0, 4);
  check('a steer follows its message, not its slot', v.queue[v.steerIdx].text === 'C', v.queue[v.steerIdx]);
  v = mk(); v.steerIdx = 0; mv(v, 0, 3);
  check('steering the dragged message still tracks it', v.queue[v.steerIdx].text === 'A', v.queue[v.steerIdx]);
}
// The fan-out goes through spawn_agent with tasks[], not spawn_parallel.
check('a fan-out row names the agents', /name==='spawn_agent'[\s\S]{0,400}args\.tasks/.test(HTML), "prints a bare 'task:'");
check('a resume row says so', /name==='spawn_agent'[\s\S]{0,500}args\.resume/.test(HTML), 'looks like a fresh spawn');

console.log('\n[AC] previewable HTML: detect, offer, remember');
const AGT = fs.readFileSync(path.join(ROOT, 'src/backend/agent.js'), 'utf8');
check('a written page is detected', AGT.includes('function isPreviewableWrite'), 'no detector');
check('only whole documents qualify', AGT.includes('<html[') || AGT.includes('/<html'), 'fragments would trigger');
check('fixtures and deps are excluded', AGT.includes('NOT_A_DELIVERABLE'), 'no exclusions');
check('an edit does not trigger it', AGT.includes("if (toolName !== 'write') return false"), 'edits trigger');
check('the same file is offered once', AGT.includes('session._offered'), 'repeats');
check('it emits an offer, not an auto-open', AGT.includes("type: 'previewable'"), 'no event');
check('renderer offers a choice', HTML.includes("el('button', 'pv-btn ghost', 'Always')") && HTML.includes('Open previews in this project automatically'), 'no remember option');
check('the choice is honoured next time', HTML.includes('preview.autoPref'), 'not remembered');
check('main persists it per project', MAIN.includes('previewAuto'), 'not stored');
check('file:// is allowed inside the workdir', MAIN.includes('function previewableUrl'), 'still http-only');
check('outside the workdir is refused', /rel\.startsWith\('\.\.'\)/.test(MAIN), 'no containment');


console.log('\n[AD] icons match the prototype');
// The prototype draws every control as an inline 24x24 stroke SVG. Emoji render in
// the OS emoji font, ignore the theme colour, and sit at the wrong optical weight.
check('an icon set exists', HTML.includes('const ICON = {'), 'no icon set');
check('preview toggle is a panel, not an eye', HTML.includes("ppToggle: 'panel'"), 'still an eye');
check('icons are stroke SVGs on a 24 grid', HTML.indexOf('viewBox=') !== -1 && HTML.indexOf('0 0 24 24') !== -1, 'not svg');
const EMOJI = /&#(128065|128204|8634|8599|10227|9881);/g;
check('no emoji glyphs left in controls', !EMOJI.test(HTML), 'emoji remain');
check('icons are painted into the buttons', HTML.includes('function paintIcons'), 'never rendered');


console.log('\n[AE] one screen, diff on the input strip');
// A Sub-agents TAB, not the word: "Sub-agents" is now a section inside Settings.
check('no Sub-agents tab', !/<button class="tab\b[^>]*>Sub-agents</.test(HTML) && !/data-screen="subagents"/.test(HTML), 'still there');
check('no Memory tab', !/data-screen="memory"/.test(HTML), 'still there');
check('Settings survives as an action', HTML.includes('id="btnSettings"'), 'lost settings');
check('diff list sits above the composer', HTML.includes('id="diffList"'), 'no diff list');
check('the strip expands it', HTML.includes('function toggleDiff'), 'not expandable');
check('per-file data comes from git', MAIN.includes("'workspace:diff'"), 'no ipc');
check('numstat drives the counts', MAIN.includes("'--numstat'"), 'no numstat');
check('untracked files are marked added', MAIN.includes("code.includes('?') ? 'A'"), 'status ignored');
// A batch delta must never invent numbers the tools did not report.
check('no invented +/- in the run delta', !HTML.includes("bits.push('+'+(st.add"), 'fabricated counts');


console.log('\n[AF] persisted ledger is restored, not just live');
check('switching sessions repaints the stats', /paintActive\(\); go\('work'\); updateSendState\(\);[\s\S]{0,400}updateSessStats\(v\)/.test(HTML), 'never repainted');
check('context bar repaints too', /paintActive[\s\S]{0,400}paintCtxBar\(\)/.test(HTML), 'stale ctx');
const SESS = fs.readFileSync(path.join(ROOT, 'src/backend/sessions.js'), 'utf8');
check('usage rows are written to disk', SESS.includes("kind: 'usage'"), 'not persisted');
check('stats rebuild on load', SESS.includes('rebuild accumulated stats'), 'not rebuilt');

console.log('\n[AG] truncated tool results still summarise');
check('truncated JSON is recovered', HTML.includes('TRUNCATED mid-object'), 'no recovery');
check('recovery avoids string-built regexes', HTML.includes('const after = (k) =>'), 'uses RegExp from string');


console.log('\n[AH] a new session carries nothing from the last one');
// A fresh session in one project was showing another project's branch and diff.
check('new session sets its own workdir', HTML.includes('v.workdir = created.workdir'), 'unset');
check('new session clears cached git state', HTML.includes('v.ctx = null') && HTML.includes('v.diff = null'), 'stale ctx kept');
check('no workdir means no context request', HTML.includes('if (!v.workdir) { v.ctx = null; paintCtxBar(); return; }'), 'asks anyway');
check('diff refuses without a workdir', HTML.includes('if (!v || !v.workdir) return;'), 'asks anyway');
check('main will not guess the project', MAIN.includes('unknown: true'), 'still falls back');
check('preview history is per session', HTML.includes('v.ppHistory'), 'global history');
// Both session-entry paths must clear the tray: creating one, and switching to one.
check('attachments do not follow you', (HTML.match(/try \{ clearAttachments\(\); \} catch \{\}/g) || []).length >= 2, 'tray carried over');
// Things that SHOULD be shared are left alone.
const FRESH = fs.readFileSync(path.join(ROOT, 'src/backend/tools/freshness.js'), 'utf8');
check('freshness guard stays keyed by file, not session', FRESH.includes('fullPath'), 'wrongly scoped');
const BG = fs.readFileSync(path.join(ROOT, 'src/backend/background.js'), 'utf8');
check('background agents are bucketed per session', BG.includes('function bucket(sessionId)'), 'shared bucket');


console.log('\n[AI] turn batching and preview framing');
const AG2 = fs.readFileSync(path.join(ROOT, 'src/backend/agent.js'), 'utf8');
// A model can call tools for several turns straight without a word of prose; text
// was the only boundary, so every call piled into one unbroken block.
check('the loop emits a turn boundary', AG2.includes("type: 'turn'"), 'no boundary');
check('the UI closes the batch on it', HTML.includes("event.type === 'turn'"), 'ignored');
// Thinking used to be appended BELOW an open batch while the next tool rows went back
// up into it, so the transcript read out of order. Now it goes inside the open step.
check('thinking lands inside the open step, in order', /event\.type === 'reasoning'[\s\S]{0,1600}const r = flowRoot\(v\)/.test(HTML), 'thinking appended outside the step');
check('empty batches are dropped', HTML.includes("card.body.querySelector('.toolrow')"), 'empty cards kept');
// A raw WebContentsView has no chrome; the frame has to come from geometry.
check('preview corners are rounded', MAIN.includes('setBorderRadius'), 'square panel');
// Framing now comes from the panel around it, not from insetting a bare view.

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
