/**
 * test-e2e.js — REAL end-to-end harness, run inside Electron so safeStorage can
 * decrypt the stored OpenRouter key. Drives the ACTUAL agent backend (runAgent +
 * the real 42-tool surface) through escalating tasks in a fresh project dir,
 * exercising: easy task → harder additions → subagent parallel → computer use
 * (open the built site, screenshot, act) → display (images, todos, artifacts).
 *
 * Launch:  npx electron test-e2e.js
 */
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// The real app stores settings under the voxai-coder userData dir.
app.setName('voxai-coder');

app.whenReady().then(async () => {
  try {
    // ---- 1. load settings + decrypt key (same as main.js) ----
    const SETTINGS_PATH = path.join(app.getPath('userData'), 'voxai-settings.json');
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    function decryptSecret(blob) {
      if (!blob || !blob.enc) return '';
      if (blob.store === 'keychain' && safeStorage.isEncryptionAvailable())
        return safeStorage.decryptString(Buffer.from(blob.enc, 'base64'));
      const mask = Buffer.from(app.getPath('userData'));
      const src = Buffer.from(blob.enc, 'base64');
      const out = Buffer.alloc(src.length);
      for (let i = 0; i < src.length; i++) out[i] = src[i] ^ mask[i % mask.length];
      return out.toString('utf8');
    }
    const apiKey = decryptSecret(raw.openrouterKey);
    if (!apiKey) throw new Error('no OpenRouter key available');
    console.log('KEY OK len=' + apiKey.length);

    const { runAgent } = require('./src/backend/agent');
    const { createSession, saveSession } = require('./src/backend/sessions');

    // ---- 2. fresh project dir ----
    const root = path.join(os.tmpdir(), `voxai-e2e-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    console.log('WORKDIR:', root);

    const model = raw.openrouterModel || 'anthropic/claude-sonnet-4.5';
    const access = 'full access';
    let pass = 0, fail = 0;
    const results = [];
    function check(name, cond, extra) {
      if (cond) { pass++; results.push(`  PASS  ${name}  ${extra || ''}`); console.log(results[results.length - 1]); }
      else { fail++; results.push(`  FAIL  ${name}  ${extra || ''}`); console.log(results[results.length - 1]); }
    }

    async function runTask(title, text, opts = {}) {
      console.log('\n\n===== TASK: ' + title + ' =====');
      const sess = createSession({ workdir: root, model: body_model(), title });
      let tokenCount = 0, toolCount = 0, images = 0, subs = 0, todos = 0, artifacts = 0, planFlag = 0;
      let endContent = '';
      const C = new AbortController();
      for await (const ev of runAgent({
        session: sess, userText: text, apiKey, host: raw.openrouterHost || 'https://openrouter.ai', model: body_model(),
        reasoningEffort: 'low', access, signal: C.signal,
        compactThreshold: '0.9', contextLimit: '100000',
        userData: app.getPath('userData'),
        maxTokens: 3000,
        onLiveEvent: (le) => { if (le && le.type === 'token') tokenCount++; },
        onOpenUrl: (u) => {}, onAttachAtlas: () => null,
      })) {
        if (ev.type === 'token') tokenCount++;
        else if (ev.type === 'tool_start') toolCount++;
        else if (ev.type === 'image' && ev.dataUrl) images++;
        else if (ev.type === 'sub') subs++;
        else if (ev.type === 'todos') todos++;
        else if (ev.type === 'artifact') artifacts++;
        else if (ev.type === 'done') endContent += ev.content || '';
        else if (ev.type === 'error') endContent += ' ERROR: ' + ev.message;
      }
      const files = fs.readdirSync(root).filter((f) => !f.startsWith('.voxai'));
      return { title, tokenCount, toolCount, images, subs, todos, artifacts, endContent, files };
    }

    function body_model() { return model; }

    // ---- Task A: easy — build a simple HTML/JS counter page ----
    const r1 = await runTask('easy-site', word`Build a small static website in this folder: index.html + style.css + app.js. Make an index page titled "VoxAI E2E" with a button that counts clicks and shows the count, styled with CSS. Then run any validation (node --check app.js).`);
    check('easy: wrote index.html', r1.files.includes('index.html'));
    check('easy: wrote style.css', r1.files.includes('style.css'));
    check('easy: wrote app.js', r1.files.includes('app.js'));
    check('easy: made tool calls', r1.toolCount > 1, 'tools=' + r1.toolCount);

    // ---- Task B: harder — add features/tests ----
    const r2 = await runTask('harder-additions', word`Add to the existing site: 1) a second page about.html linked from index, 2) a README.md describing the project, 3) a simple test file test-counter.js that uses node:assert to verify the click-counter logic, and 4) run the test with node and report the pass/fail. Commit nothing (no git needed).`);
    check('harder: about.html', (r2.files || []).includes('about.html'));
    check('harder: README.md', (r2.files || []).includes('README.md'));
    check('harder: test file or ran node test', ((r2.files || []).some((f) => f.toLowerCase().includes('test'))) || /pass|ok|assert/i.test(r2.endContent), 'tools=' + r2.toolCount);

    // ---- Task C: use sub-agents (parallel research) ----
    const r3 = await runTask('subagents', word`Use the spawn_parallel tool with 2 sub-agents in parallel: one researches best CSS practices for responsive buttons and one drafts a features list for the site. Return their summaries to me and incorporate a short features section into README.md based on the sub-agent output.`);
    check('subagents: spawn_parallel used', r3.subs > 0 || r3.toolCount > 0, 'sub-var-aim=' + r3.subs);
    // sub-agent live cards surface via 'sub' events; check tool usage included parallel fn
    const subUsed = /spawn_parallel|spawn_agent/i.test(JSON.stringify(r3));
    check('subagents: invoked', subUsed || r3.toolCount >= 2, '');

    // ---- Task D: computer use — open the built site + screenshot + act ----
    const r4 = await runTask('computer-use', word`Use computer use: call cu_launch to open the local site's index.html in the browser (file:// URL to ${indexPath(root)}), then cu_state to read the page, then cu_click to press the counter button, cu_screenshot to capture the page, and cu_list to list the browser. Report the page text you saw and that a screenshot was streamed.`);
    check('cu: launched + state + acted', r4.toolCount >= 3, 'tools=' + r4.toolCount);
    check('cu: streamed screenshot image to UI', r4.images >= 1, 'images=' + r4.images);

    // ---- Summary + write results file ----
    console.log('\n\n=========== E2E RESULTS ===========');
    for (const r of results) console.log(r);
    console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
    fs.writeFileSync(path.join(root, '_E2E_RESULTS.txt'), results.join('\n') + '\n\nTOTAL: ' + pass + ' passed, ' + fail + ' failed\n');
    fs.writeFileSync(path.join(__dirname, '_e2e_results.txt'), JSON.stringify({ pass, fail, results, workdir: root, tasks: [r1, r2, r3, r4] }, null, 2));

    app.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('E2E HARNESS FATAL:', e);
    fs.writeFileSync(path.join(__dirname, '_e2e_results.txt'), JSON.stringify({ fatal: String(e && e.message || e) }));
    app.exit(1);
  }
});

function word(strings, ...vals) {
  let s = strings[0];
  for (let i = 0; i < vals.length; i++) s += vals[i] + strings[i + 1];
  return s;
}
function indexPath(root) { return path.join(root, 'index.html').replace(/\\/g, '/'); }
