/**
 * VoxAI Coder — Electron main process (standalone backend edition).
 *
 * NO goose.exe. The agent backend is our own Node code in ../backend:
 *   backend/agent.js            — tool-calling loop (OpenRouter, streaming SSE)
 *   backend/providers/openrouter.js — OpenRouter chat-completions client
 *   backend/tools/index.js      — read/write/edit/glob/grep/shell/todo
 *   backend/sessions.js         — JSONL session store
 *
 * Main owns: settings + keychain, session registry, agent run orchestration
 * (streams events to the renderer over IPC), permission round-trips, and the
 * direct (tool-less) OpenRouter chat used for cheap turns / key test.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, View, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { runAgent, pendingAsk, answerPendingAsk } = require('../backend/agent');
const { chatOnce, normalizeReasoning } = require('../backend/providers/openrouter');
const store = require('../backend/sessions');
const { compactSession, estimateSessionTokens } = require('../backend/compact');

const isDev = process.argv.includes('--dev');

// One data folder for `npm start` and the installed app. Electron names it after the
// app: "voxai-coder" from source, "VoxAI Coder" once packaged -- so the installed app
// opened with no sessions and no key. Must run before anything reads userData.
// An explicit --user-data-dir (Chromium's own switch) wins: a separate, empty profile
// for trying the first run, or a second setup, without touching the real one.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'voxai-coder'));
// The same identity as the installed build (build.appId), so Windows groups the
// taskbar button under the VoxAI icon rather than Electron's.
if (process.platform === 'win32') app.setAppUserModelId('ai.vox.coder');

// One copy at a time. Two copies share that data folder, so they fought over its cache
// and could write the same session file; and an update cannot replace files that a
// second copy still holds open. Opening the app again brings the open window forward.
// (The lock belongs to the data folder, so `npm start` and the installed app count as
// one: close one before starting the other.)
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

// ---------------------------------------------------------------- settings ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'voxai-settings.json');

function readSettingsFile() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch { /* corrupted → fresh */ }
  return {};
}
function writeSettingsFile(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}
function encryptSecret(plain) {
  if (safeStorage.isEncryptionAvailable())
    return { enc: safeStorage.encryptString(plain).toString('base64'), store: 'keychain' };
  const mask = Buffer.from(app.getPath('userData'));
  const src = Buffer.from(plain, 'utf8');
  const out = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] ^ mask[i % mask.length];
  return { enc: out.toString('base64'), store: 'obfuscated-file' };
}
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
function getSettings(redacted = true) {
  const raw = readSettingsFile();
  return {
    openrouterHost: raw.openrouterHost || 'https://openrouter.ai',
    openrouterModel: raw.openrouterModel || 'anthropic/claude-sonnet-4.5',
    reasoningEffort: normalizeReasoning(raw.reasoningEffort),
    access: raw.access ? (require('../backend/tools/sandbox').normalizeAccess(raw.access)) : 'test',
    planMode: raw.planMode === true || raw.planMode === 'true',
    workingDir: raw.workingDir || os.homedir(),
    // Fix 4: advanced knobs
    compactThreshold: raw.compactThreshold || process.env.VOX_COMPACT_THRESHOLD || '0.8',
    toolResultMaxChars: raw.toolResultMaxChars || process.env.VOX_TOOL_RESULT_MAX_CHARS || '8000',
    cacheTtlMinutes: raw.cacheTtlMinutes || process.env.VOX_CACHE_TTL_MIN || '5',
    // Stall-hardening: sane defaults instead of trusting the alias's 1.31M metadata
    contextLimit: raw.contextLimit || process.env.VOX_CONTEXT_LIMIT || '200000',
    hardFraction: raw.hardFraction || process.env.VOX_HARD_LIMIT_FRACTION || '0.9',
    // Hard spend ceiling per run, in USD. Sub-agents draw from the same allowance.
    runBudgetUsd: raw.runBudgetUsd || process.env.VOX_RUN_BUDGET_USD || '1.00',
    // Per-project: has the user said "always show previews here"? Claude Code saves
    // the equivalent choice into .claude/launch.json; this is the same idea, kept in
    // settings so it survives without writing into the user's repo.
    previewAuto: raw.previewAuto && typeof raw.previewAuto === 'object' ? raw.previewAuto : {},
    // Sub-agent defaults (UI pickers)
    subagentModel: raw.subagentModel || process.env.VOX_SUBAGENT_MODEL || '',
    subagentMaxTurns: raw.subagentMaxTurns || process.env.VOX_SUBAGENT_MAX_TURNS || '25',
    subagentTimeoutMs: String(subagentTimeoutToMs(raw.subagentTimeoutMs || process.env.VOX_SUBAGENT_TIMEOUT_MS)),
    // Web search. Stored values are checked, so a hand-edited file cannot select an
    // engine OpenRouter does not have or ask for a result count it bills extra for.
    webSearchEnabled: raw.webSearchEnabled !== false && raw.webSearchEnabled !== 'false',
    webSearchEngine: ['exa', 'parallel', 'perplexity'].includes(raw.webSearchEngine) ? raw.webSearchEngine : 'exa',
    webSearchMaxResults: Math.min(10, Math.max(1, Math.round(Number(raw.webSearchMaxResults) || 5))),
    hasOpenRouterKey: !!(raw.openrouterKey && raw.openrouterKey.enc),
    openrouterKey: redacted ? undefined : decryptSecret(raw.openrouterKey),
    keyStore: (raw.openrouterKey && raw.openrouterKey.store) || 'none',
    hasManagementKey: !!(raw.managementKey && raw.managementKey.enc),
    managementKey: redacted ? undefined : decryptSecret(raw.managementKey),
    mkeyStore: (raw.managementKey && raw.managementKey.store) || 'none',
  };
}
function saveSettings(patch) {
  const raw = readSettingsFile();
  if (patch.openrouterKey !== undefined) {
    if (patch.openrouterKey) raw.openrouterKey = encryptSecret(patch.openrouterKey);
    else delete raw.openrouterKey;
    delete patch.openrouterKey;
  }
  if (patch.managementKey !== undefined) {
    if (patch.managementKey) raw.managementKey = encryptSecret(patch.managementKey);
    else delete raw.managementKey;
    delete patch.managementKey;
  }
  Object.assign(raw, patch);
  writeSettingsFile(raw);
  return getSettings(true);
}

// ------------------------------------------------------------- live sessions --
const live = new Map(); // id → session object
const controllers = new Map(); // runKey → AbortController
const sessionAlwaysAllow = new Map(); // sessionId -> Set<string> (normalized target) 
const pendingPerms = new Map(); // permId → {resolve, timer}
const pendingInputs = new Map(); // inputId → {resolve, timer}  (ask_user / ask_confirm)

function userData() { return app.getPath('userData'); }
async function getLive(id) {
  if (live.get(id)) return live.get(id);
  const s = await store.loadSession(userData(), id);
  live.set(id, s);
  return s;
}
function win() { return BrowserWindow.getAllWindows()[0]; }
// With Atlas split the window content is a root View; the chat lives in
// chatV.webContents. `win()` still returns the BrowserWindow (for geometry),
// but message sends must target chatV.webContents.
function chatWebContents() {
  return (chatV && chatV.webContents) || (win() && win().webContents);
}

// File menu -> the window (New Session, Open Folder). It lived inside the startup
// function, out of reach of the menu built in createWindow, so the menu items and
// their shortcuts (Ctrl+N, Ctrl+O) threw and did nothing. Found in a live test.
function relay(ch) { const c = chatWebContents(); if (c) c.send('vox:menu', ch); }

// ------------------------------------------------------------------- window ---
function createWindow() {
  const w = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1100, minHeight: 700,
    backgroundColor: '#0e0e10',
    title: 'VoxAI Coder',
    // The VoxAI mark in the taskbar and Alt-Tab, not Electron's. The installed app also
    // carries it in the .exe (build.win.icon in package.json).
    icon: path.join(__dirname, '..', '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // The UI draws its own title bar (Forge-style, with in-UI window buttons),
    // so the platform frame is removed — the app is not a shell over a web page.
    frame: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  // Broadcast window state to the renderer so the title-bar maximize button
  // can flip to "restore" (mirrors CodeBox's window:state channel).
  const reportState = () => {
    const c = chatWebContents();
    if (c) c.send('window:state', w.isMaximized() ? 'maximized' : 'normal');
  };
  w.on('maximize', reportState);
  w.on('unmaximize', reportState);
  // Native application menu (File / View / Help) — Alt reveals it on Windows
  const template = [
    { label: 'File', submenu: [
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => relay('new-session') },
      { type: 'separator' },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => relay('open-folder') },
      { type: 'separator' },
      { role: 'quit' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ]},
    { label: 'Help', submenu: [
      { label: 'About VoxAI Coder', click: () => dialog.showMessageBox(w, {
        type: 'info', title: 'VoxAI Coder',
        message: 'VoxAI Coder ' + app.getVersion(),
        detail: 'Forge-style desktop coder · own Vox backend · OpenRouter models.' }) },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  attachSplitViews(w);
  // Frameless window: start un-maximized (the UI title bar owns the buttons).
  if (process.env.VOX_START_MAXIMIZED === '1') w.maximize();
  if (isDev) { const c = chatWebContents(); if (c) c.openDevTools({ mode: 'detach' }); }
  return w;
}

// ------------------------------------------------------------------ Atlas ----
/*
 * Atlas: a real, resizable in-app browser side-by-side with the chat (the same
 * pattern VoxAI Web / Codex / Claude Code / AI_GUI use). The window content is a
 * root View with TWO child WebContentsViews:
 *   - chatView    (left)   -> the existing renderer (index.html)
 *   - browserView (right)  -> a real web browser (any https URL)
 * The renderer owns a draggable divider; on drag it sends `preview:set-bounds`,
 * and we lay the two views out so the chat + composer reflow with the split.
 */
let rootV = null;
let chatV = null;
let browserV = null;
let atlasOpen = false;
let atlasFrac = 0.5; // share of width given to chat (0..1)

// Capability cache for the OpenRouter catalogue, populated by the `openrouter:models`
// handler and consulted before a run starts. See assertModelUsable().
let modelCapCache = { at: 0, byId: new Map() };
const MODEL_CAP_TTL = 60 * 60 * 1000;

/**
 * Refuse to start a run on a model that cannot call tools.
 *
 * This is the failure that looked like "some models just don't work": a model with
 * no native tool support accepts the request, ignores the tools array, and replies
 * in prose. The agent then loops or gives up, and nothing in the UI says why.
 * Fails OPEN — if the catalogue is unreachable we let the run proceed rather than
 * blocking work on a network hiccup.
 */
/** Catalogue price in $/token (promptCents is cents-per-token x100). */
function modelPrice(modelId) {
  const cap = modelCapCache.byId.get(modelId);
  if (!cap) return { in: 0, out: 0 };
  return {
    in: cap.promptCents != null ? Number(cap.promptCents) / 100 : 0,
    out: cap.completionCents != null ? Number(cap.completionCents) / 100 : 0,
  };
}

/**
 * Sub-agent timeout, always in MILLISECONDS on the way out.
 *
 * Settings labels this field in seconds ("SUB-AGENT TIMEOUT (s)", default 300) but
 * stored the number unconverted under `subagentTimeoutMs`, and the default here was
 * the string '300' -- so every sub-agent was aborted 300 ms after it started, before
 * the model had produced a single token. It surfaced as "failed · 0 tools · 0s" and
 * the parent model narrating that its workers "timed out instantly".
 *
 * Nobody means a sub-agent timeout under a second, so anything below 1000 is read as
 * seconds. That keeps both old saved values and the new ms values correct. Clamped to
 * 10 s .. 1 h, matching the input's own min/max.
 */
function subagentTimeoutToMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 300000;
  const ms = n < 1000 ? n * 1000 : n;
  return Math.min(3600000, Math.max(10000, Math.round(ms)));
}

/**
 * The model's catalogue `reasoning` entry: the entry, null when the catalogue lists the
 * model without one (it cannot reason), undefined when the model is not in the cache.
 */
function modelReasoning(modelId) {
  const cap = modelCapCache.byId.get(modelId);
  if (!cap) return undefined;
  return cap.reasoningSpec || null;
}

/** true / false from the catalogue; null when the catalogue has not said. */
function modelVision(modelId) {
  const cap = modelCapCache.byId.get(modelId);
  return cap && typeof cap.vision === 'boolean' ? cap.vision : null;
}

async function assertModelUsable(modelId, getModels, opts = {}) {
  if (!modelId) return;
  if (process.env.VOX_SKIP_MODEL_CHECK) return;
  const stale = Date.now() - modelCapCache.at > MODEL_CAP_TTL;
  if (stale || !modelCapCache.byId.size) {
    try { await getModels(); } catch { return; } // fail open
  }
  if (!modelCapCache.byId.size) return;          // fail open
  const cap = modelCapCache.byId.get(modelId);
  if (!cap) {
    throw new Error(`Model "${modelId}" is not in the OpenRouter catalogue — it may have been renamed or retired. Pick another model in Settings.`);
  }
  if (!cap.tools) {
    throw new Error(`Model "${modelId}" does not support tool calling, so the agent cannot read or edit files with it. Pick a tool-capable model in Settings.`);
  }
  // You attached an image because you want it looked at. Sending it to a text-only
  // model either errors at the provider or -- worse -- gets quietly ignored, and the
  // model answers as if it had seen it. Say so before any money is spent.
  if (opts.images > 0 && cap.vision === false) {
    throw new Error(`Model "${modelId}" cannot read images, so the ${opts.images === 1 ? 'image you attached' : opts.images + ' images you attached'} would not be seen. Switch to a vision model (one that lists image input), or remove the attachment and send again.`);
  }
}

/**
 * The app's own page never leaves the app.
 *
 * It holds the full `window.voxai` bridge. A link in an answer -- which can come from
 * a web page the agent read -- loaded that site IN PLACE of the app, and the site got
 * the bridge: saveSettings, agentSend, agentPermission. Found in a live run. Web links
 * go to the user's browser instead; nothing else is followed.
 */
function isAppPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && /\/renderer\/index\.html$/i.test(decodeURIComponent(u.pathname).replace(/\\/g, '/'));
  } catch { return false; }
}
function guardTrustedView(wc) {
  const outside = (url) => { if (/^https?:\/\//i.test(String(url || ''))) { try { shell.openExternal(url); } catch {} } };
  wc.on('will-navigate', (e, url) => { if (!isAppPage(url)) { e.preventDefault(); outside(url); } });
  wc.on('will-redirect', (e, url) => { if (!isAppPage(url)) { e.preventDefault(); } });
  wc.setWindowOpenHandler(({ url }) => { outside(url); return { action: 'deny' }; });
}

function attachSplitViews(w) {
  // Trusted surface: our own renderer, gets the full `window.voxai` bridge.
  const chatPrefs = {
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: false,
  };
  // UNTRUSTED surface: the Atlas view loads arbitrary https:// pages (browser_open,
  // preview:go, agent-driven navigation). It must NOT receive the preload — any page
  // holding `window.voxai` could call saveSettings({access:'full'}) and then
  // agentSend(), i.e. drive a shell-capable agent from a web page. No preload, no
  // node, sandboxed.
  const browserPrefs = {
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false,
  };
  rootV = new View();
  chatV = new WebContentsView({ webPreferences: chatPrefs });
  browserV = new WebContentsView({ webPreferences: browserPrefs });
  rootV.addChildView(chatV, 0);
  rootV.addChildView(browserV, 1);
  w.setContentView(rootV);

  chatV.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  guardTrustedView(chatV.webContents);
  browserV.webContents.loadURL('about:blank');
  // Keep the preview strip's URL honest as the page navigates (links, redirects).
  try {
    browserV.webContents.on('did-navigate', () => broadcastPreviewState());
    browserV.webContents.on('did-navigate-in-page', () => broadcastPreviewState());
    // The preview sits inside the app's own chrome, so its scrollbars have to look
    // like the app's. They belong to the loaded document, not to us, so the only way
    // to reach them is to inject -- and injected CSS dies with the document, so this
    // runs for every navigation, not once at startup.
    browserV.webContents.on('dom-ready', () => {
      try { browserV.webContents.insertCSS(PREVIEW_SCROLLBAR_CSS); } catch {}
    });
  } catch {}
  browserV.setVisible(false);

  // keep the split correct when the window is resized/maximized
  // 'resized' fires only once the drag ENDS, so the split lagged the window the whole
  // time you were dragging and any path that resizes without a drag (snap, restore,
  // a DPI change, leaving full screen) never relaid out at all.
  const relayout = () => layoutAtlas();
  w.on('resize', relayout);          // continuous, during the drag
  w.on('resized', relayout);         // and once more when it settles
  w.on('maximize', relayout);
  w.on('unmaximize', relayout);
  w.on('restore', relayout);
  w.on('enter-full-screen', relayout);
  w.on('leave-full-screen', relayout);
  try { w.on('always-on-top-changed', relayout); } catch {}
  layoutAtlas();
}

/**
 * Tell the renderer the preview actually changed.
 *
 * The agent can open Atlas on its own (computer.open -> showInApp -> atlasOpenUrl),
 * and nothing told the UI. So the renderer still believed the panel was closed: its
 * toggle was off, its divider hidden, and clicking the toggle to CLOSE the visible
 * browser called ppOpen() instead. State has to be pushed, not only polled.
 */
/**
 * Is this something the preview may load?
 *
 * http(s) is obvious. file:// matters because the agent writes HTML to the
 * workspace constantly and the view used to reject it — so the model's only route
 * to showing you a page was to spin up `python -m http.server` first. It tried three
 * times in one session before it worked. A local file inside the session workdir is
 * content the agent can already read, so rendering it grants nothing new; anything
 * OUTSIDE the workdir is refused.
 */
function previewableUrl(url, workdir) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  if (!/^file:\/\//i.test(u)) return null;
  if (!workdir) return null;
  try {
    const p = decodeURIComponent(new URL(u).pathname).replace(/^\/+([a-zA-Z]:)/, '$1');
    const abs = path.resolve(p);
    const root = path.resolve(workdir);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;   // escapes the workdir
    return u;
  } catch { return null; }
}

/**
 * The preview's state, in one place. The push (broadcast) carried the URL but the pull
 * (preview:state, which the renderer calls when it starts) did not -- so after a reload
 * the panel kept showing the page while its address bar read "http://localhost".
 */
function previewState() {
  let url = '';
  try { url = (browserV && browserV.webContents && browserV.webContents.getURL()) || ''; } catch {}
  if (url === 'about:blank') url = '';
  return { open: atlasOpen, chatFraction: atlasFrac, url };
}

function broadcastPreviewState() {
  const c = chatWebContents();
  if (!c) return;
  try { c.send('preview:state', previewState()); } catch {}
}

/**
 * Scrollbar styling injected into whatever the preview loads.
 *
 * Deliberately translucent rather than the app's flat --edge2: the preview can load
 * any page, light or dark, and a fixed dark thumb is invisible on a white document.
 * These read on both.
 */
const PREVIEW_SCROLLBAR_CSS = [
  '::-webkit-scrollbar{width:10px;height:10px}',
  '::-webkit-scrollbar-track{background:transparent}',
  '::-webkit-scrollbar-corner{background:transparent}',
  '::-webkit-scrollbar-thumb{background:rgba(138,133,125,.45);border:2px solid transparent;background-clip:content-box;border-radius:10px}',
  '::-webkit-scrollbar-thumb:hover{background:rgba(200,169,97,.7);background-clip:content-box}',
  '::-webkit-scrollbar-thumb:active{background:rgba(200,169,97,.95);background-clip:content-box}',
].join('');

// Where the renderer's preview panel body currently is, in window coordinates.
// The renderer measures its own DOM and reports it; main just honours it.
let previewRect = null;

function layoutAtlas() {
  try {
    if (!rootV || !chatV) return;
    let cb = null;
    try { const w0 = win(); cb = w0 && w0.getContentBounds(); } catch { cb = null; }
    // Defensive: never let bad/incomplete geometry kill window setup.
    let W = cb && Number.isFinite(cb.width) && cb.width > 0 ? Math.floor(cb.width) : 1440;
    let H = cb && Number.isFinite(cb.height) && cb.height > 0 ? Math.floor(cb.height) : 900;
    W = Math.max(50, Math.min(W, 100000));
    H = Math.max(50, Math.min(H, 100000));
    // The chat view ALWAYS fills the window. The preview is a real panel drawn by
    // the renderer — title bar, address bar, back/forward/reload/close — and the
    // browser view is positioned to sit inside that panel's body.
    //
    // This is the arrangement Codex and Claude Code use, and it is the only way the
    // preview reads as part of the app: a WebContentsView cannot be styled from the
    // renderer, so if it owns its own half of the window it will always look like a
    // separate window pasted alongside. Letting the DOM own the chrome and slotting
    // the view into a measured hole gives real chrome around real web content.
    chatV.setBounds({ x: 0, y: 0, width: W, height: H });

    if (atlasOpen && previewRect && previewRect.width > 20 && previewRect.height > 20) {
      const r = previewRect;
      browserV.setBounds({
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.max(20, Math.round(r.width)),
        height: Math.max(20, Math.round(r.height)),
      });
      try { if (typeof browserV.setBorderRadius === 'function') browserV.setBorderRadius(6); } catch {}
      browserV.setVisible(true);
    } else {
      browserV.setVisible(false);
    }
  } catch (e) {
    // A layout hiccup must never black-screen the app.
    try { console.error('layoutAtlas (non-fatal):', e && e.message); } catch {}
  }
}

function atlasSetBounds(frac) {
  if (frac != null && Number.isFinite(frac)) atlasFrac = Math.min(0.85, Math.max(0.2, Number(frac)));
  layoutAtlas();
}

function atlasOpenUrl(url, workdir) {
  atlasOpen = true;
  atlasFrac = 0.5;
  const ok = previewableUrl(url, workdir || getSettings(false).workingDir);
  if (ok) browserV.webContents.loadURL(ok);
  layoutAtlas();
  broadcastPreviewState();
}

function atlasClose() {
  atlasOpen = false;
  atlasFrac = 0.5;                 // forget a dragged split, or the next open is lopsided
  browserV.webContents.loadURL('about:blank');
  browserV.setVisible(false);
  layoutAtlas();
  broadcastPreviewState();
}

app.whenReady().then(() => {
  // frameless window controls (in-UI title-bar buttons)
  ipcMain.on('window:minimize', (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize(),
  );
  ipcMain.handle('window:toggle-maximize', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return 'normal';
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized() ? 'maximized' : 'normal';
  });
  ipcMain.on('window:close', (event) =>
    BrowserWindow.fromWebContents(event.sender)?.close(),
  );
  ipcMain.handle('window:toggle-fullscreen', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return false;
    w.setFullScreen(!w.isFullScreen());
    return w.isFullScreen();
  });
  ipcMain.handle('window:get-state', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return w ? (w.isMaximized() ? 'maximized' : 'normal') : 'normal';
  });

  // Atlas: in-app resizable browser (chat | browser split)
  // Judge a file:// URL against the SESSION's project. With only the url, containment
  // used the global working folder, so a local file from any other project was refused
  // and the panel sat on about:blank. Found live. A bare string still works.
  ipcMain.on('preview:open', (_e, arg) => {
    if (arg && typeof arg === 'object') atlasOpenUrl(arg.url, arg.workdir);
    else atlasOpenUrl(arg);
  });
  ipcMain.on('preview:close', () => atlasClose());
  ipcMain.on('preview:set-bounds', (_e, frac) => { atlasSetBounds(frac); broadcastPreviewState(); });
  // The renderer owns the panel's geometry; it reports the body rect and we slot the
  // browser view into it.
  ipcMain.on('preview:viewport', (_e, rect) => {
    previewRect = rect && Number.isFinite(rect.width) ? rect : null;
    layoutAtlas();
  });
  ipcMain.handle('preview:state', () => previewState());
  ipcMain.on('preview:back', () => { try { browserV && browserV.webContents.goBack(); } catch {} });
  ipcMain.on('preview:forward', () => { try { browserV && browserV.webContents.goForward(); } catch {} });
  ipcMain.on('preview:reload', () => { try { browserV && browserV.webContents.reload(); } catch {} });
  ipcMain.on('preview:go', (_e, url) => { try { atlasOpen = true; setTimeout(broadcastPreviewState, 0); const ok = previewableUrl(url, getSettings(false).workingDir); if (ok) browserV.webContents.loadURL(ok); layoutAtlas(); } catch {} });

  // settings
  ipcMain.handle('settings:get', () => getSettings(true));
  ipcMain.handle('settings:save', (_e, patch) => saveSettings(patch));
  ipcMain.handle('settings:keychain', () => ({ available: safeStorage.isEncryptionAvailable() }));

  // sessions
  ipcMain.handle('sessions:list', () => store.listSessions(userData()));
  ipcMain.handle('sessions:search', (_e, query) => store.searchSessions(userData(), query));
  ipcMain.handle('sessions:create', async (_e, { title, workdir, model }) => {
    const s = getSettings(false);
    // Only a folder that is there. A typo made a session in C:\does\not\exist without a
    // word, and its first action failed. Found in a live run.
    const dir = String(workdir || s.workingDir || '').trim();
    let isDir = false;
    try { isDir = path.isAbsolute(dir) && fs.statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) return { ok: false, error: `There is no folder at ${dir || '(nothing given)'}. Choose a folder that exists, by its full path.` };
    const sess = store.createSession({ workdir: dir, model: model || s.openrouterModel, title });
    await store.saveSession(userData(), sess);
    live.set(sess.id, sess);
    return { ok: true, id: sess.id, title: sess.title, workdir: sess.workdir, model: sess.model, updatedAt: sess.updatedAt };
  });
  ipcMain.handle('sessions:open', async (_e, id) => {
    const sess = await getLive(id);
    // Fix 1: surface persisted usage ledger back to the UI
    // How full it is, for the meter by Send. The same estimate the run uses, less the
    // system prompt the run adds; the first live `context` event corrects it.
    const s = getSettings(false);
    const context = {
      tokens: estimateSessionTokens(sess, ''),
      limit: Number(s.contextLimit) > 0 ? Number(s.contextLimit) : 200000,
      threshold: Number(s.compactThreshold) > 0 ? Number(s.compactThreshold) : 0.8,
    };
    // A question the app closed on, still waiting for its answer (a live run's own
    // questions come from agent:live instead).
    const running = [...controllers.keys()].some((k) => k.startsWith(id + ':'));
    const ask = running ? null : pendingAsk(sess);
    return { id: sess.id, title: sess.title, workdir: sess.workdir, model: sess.model, messages: sess.messages, todos: sess.todos, usage: sess.usage, stats: sess.stats, stops: sess.stops || [], context, pendingAsk: ask };
  });
  // To the Recycle Bin, not erased: one misclick on Delete lost a whole conversation
  // for good. If the bin refuses, nothing is deleted and the user is told why.
  ipcMain.handle('sessions:delete', async (_e, id) => {
    const file = path.join(store.sessionsDir(userData()), `${path.basename(String(id || ''))}.jsonl`);
    try {
      await require('electron').shell.trashItem(file);
    } catch (e) {
      return { ok: false, error: 'Could not move it to the Recycle Bin: ' + String((e && e.message) || e) };
    }
    live.delete(id);
    // Its sub-agents' sessions go with it: they stayed behind, unlisted, for good.
    try {
      const subs = (await store.listSessions(userData(), 10000, { subs: true })).filter((s) => s.parentId === id);
      for (const s of subs) {
        try { await require('electron').shell.trashItem(path.join(store.sessionsDir(userData()), `${path.basename(s.id)}.jsonl`)); } catch {}
      }
    } catch {}
    return { ok: true };
  });
  // Sub-agent sessions left behind by a conversation deleted before they went with it:
  // to the Recycle Bin, once, a little after start. Only ones that name their parent.
  setTimeout(async () => {
    try {
      const dir = store.sessionsDir(userData());
      for (const s of await store.listSessions(userData(), 100000, { subs: true })) {
        if (!s.parentId || live.has(s.parentId) || fs.existsSync(path.join(dir, `${path.basename(s.parentId)}.jsonl`))) continue;
        try { await require('electron').shell.trashItem(path.join(dir, `${path.basename(s.id)}.jsonl`)); } catch {}
      }
    } catch {}
  }, 20000);
  ipcMain.handle('sessions:rename', async (_e, { id, title }) => {
    const t = String(title || '').trim();
    if (!id || !t) return false;
    const sess = await getLive(id);
    sess.title = t.slice(0, 120);
    await store.saveSession(userData(), sess);
    return true;
  });
  // The composer's model picker. It used to save only the GLOBAL model, but a run uses
  // `sess.model || s.openrouterModel` and every session is created with its model set,
  // so switching models changed the chip and nothing else -- the next send still went
  // to the old model. (Found live: "switch to a vision model and send again" was
  // refused a second time, naming the model the user had just switched away from.)
  ipcMain.handle('sessions:setModel', async (_e, { id, model }) => {
    const m = String(model || '').trim();
    if (!id || !m) return false;
    const sess = await getLive(id);
    sess.model = m;
    await store.saveSession(userData(), sess);
    return true;
  });
  ipcMain.handle('sessions:reveal', async (_e, id) => {
    const sess = await getLive(id);
    if (sess && sess.workdir) {
      const { shell } = require('electron');
      const path = require('path');
      const d = sess.workdir.trim();
      try { shell.openPath(d); } catch {}
    }
    return true;
  });

  // Sub-agents: list persisted runs + manually trigger one (UI panel)
  ipcMain.handle('subagents:list', async () => {
    try { return await store.listSessions(userData(), 200, { subs: true }); } catch { return []; }
  });
  ipcMain.handle('subagents:spawn', async (_e, { task, model, maxTurns, timeoutMs }) => {
    const s = getSettings(false);
    if (!s.openrouterKey) throw new Error('No OpenRouter API key — open Settings first.');
    if (!task || !String(task).trim()) throw new Error('sub-agent task is required');
    // use the session the renderer is viewing (fallback: any live or the first)
    let sess = null;
    try { const arr = [...live.values()]; sess = arr[0]; } catch {}
    const workdir = (sess && sess.workdir) || s.workingDir || os.homedir();
    const sub = store.createSession({
      workdir,
      model: (model && String(model).trim()) || s.subagentModel || s.openrouterModel,
      title: 'subagent',
      parentId: (sess && sess.id) || null,
    });
    const ctl = new AbortController();
    (async () => {
      try {
        for await (const ev of runAgent({
          session: sub, userText: String(task),
          budgetUsd: Number(s.runBudgetUsd) > 0 ? Number(s.runBudgetUsd) : 1,
          priceIn: modelPrice(sub.model).in, priceOut: modelPrice(sub.model).out, modelVision: modelVision(sub.model), reasoningSpec: modelReasoning(sub.model),
          apiKey: s.openrouterKey, host: s.openrouterHost, model: sub.model,
          reasoningEffort: s.reasoningEffort, access: s.access,
          maxTurns: Number(maxTurns) > 0 ? Number(maxTurns) : (Number(s.subagentMaxTurns) > 0 ? Number(s.subagentMaxTurns) : 25),
          signal: ctl.signal, askPermission: async () => true,
          userData: userData(), live: live,
          contextLimit: s.contextLimit, compactThreshold: s.compactThreshold,
          toolResultMaxChars: s.toolResultMaxChars, hardFraction: s.hardFraction,
          subagentModel: s.subagentModel, subagentMaxTurns: s.subagentMaxTurns, subagentTimeoutMs: s.subagentTimeoutMs, mcpServers: readSettingsFile().mcpServers || {},
          webSearch: { enabled: s.webSearchEnabled, engine: s.webSearchEngine, maxResults: s.webSearchMaxResults },
          isSubAgent: false,
        })) {
          if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled' || ev.type === 'limit_reached' || ev.type === 'budget_reached') break;
        }
      } catch (err) {
        try { store.recordUsage(sub, { prompt_tokens: 0, completion_tokens: 0, total_cost: 0, cost: 0 }); } catch {}
      } finally {
        try { const ru = sub._runUsage; if (ru) { store.recordUsage(sub, ru); delete sub._runUsage; } } catch {}
        try { await store.saveSession(userData(), sub); } catch {}
        const c = chatWebContents(); c && c.send('subagents:changed', { id: sub.id });
      }
    })();
    return { id: sub.id, model: sub.model, workdir: sub.workdir };
  });

  // ---------- incremental session persistence ----------
  // Save in-flight state so a crash / app close mid-run doesn't lose the user
  // message and the tool/assistant turns already produced (pick up where you
  // left off). Debounced: we don't write to disk on EVERY token, just when the
  // message array has actually changed and we've paused briefly.
  const saveTimers = new Map();
  function scheduleSessionSave(sid) {
    if (saveTimers.has(sid)) return;               // already queued
    saveTimers.set(sid, setTimeout(async () => {
      saveTimers.delete(sid);
      try {
        const s2 = await getLive(sid);
        if (s2) await store.saveSession(userData(), s2);
      } catch { /* best-effort */ }
    }, 400));
  }

  // agent run — streams events via 'agent:event' webContents messages
  ipcMain.handle('agent:send', (_e, { sessionId, text, attachments }) => launchRun({ sessionId, text, attachments }));
  // A question the app closed on, answered now: its answer goes into the session and
  // the run carries on from there, as if it had never stopped.
  ipcMain.handle('agent:resume-ask', async (_e, { sessionId, callId, answer, cancelled }) => {
    if ([...controllers.keys()].some((k) => k.startsWith(sessionId + ':'))) throw new Error('This session is already running.');
    const sess = await getLive(sessionId);
    const res = cancelled ? { answer: null, cancelled: true } : { answer: answer == null ? '' : answer, cancelled: false };
    if (!answerPendingAsk(sess, callId, res)) throw new Error('That question has already been answered.');
    await store.saveSession(userData(), sess);
    return launchRun({ sessionId, text: '', attachments: [], resume: true });
  });
  // What a session is waiting on right now, for a window that was reloaded (or a view
  // opened again): its live runs, its open questions and its approval. Each was sent
  // once, as an event, and a reload lost it while the run sat waiting for an answer.
  ipcMain.handle('agent:live', (_e, sessionId) => ({
    runKeys: [...controllers.keys()].filter((k) => k.startsWith(sessionId + ':')),
    inputs: [...pendingInputs.values()].filter((p) => p.sessionId === sessionId).map((p) => ({ runKey: p.runKey, event: p.event })),
    perms: [...pendingPerms.values()].filter((p) => p.msg && p.msg.sessionId === sessionId).map((p) => p.msg),
  }));
  // Sessions with a run going, the ones waiting on the user first.
  ipcMain.handle('agent:live-sessions', () => {
    const waiting = new Set([...pendingInputs.values()].map((p) => p.sessionId).concat([...pendingPerms.values()].map((p) => p.msg && p.msg.sessionId)));
    const ids = [...new Set([...controllers.keys()].map((k) => k.split(':')[0]))];
    return ids.sort((a, b) => (waiting.has(b) ? 1 : 0) - (waiting.has(a) ? 1 : 0));
  });

  async function launchRun({ sessionId, text, attachments, resume = false }) {
    const s = getSettings(false);
    if (!s.openrouterKey) throw new Error('No OpenRouter API key — open Settings and paste one.');
    const sess = await getLive(sessionId);
    if (!resume && (!text || !text.trim())) throw new Error('empty prompt');
    // Refuse up front rather than letting a tool-less model answer in prose forever.
    await assertModelUsable(sess.model || s.openrouterModel, fetchModels, {
      images: (attachments || []).filter((a) => a && (a.type === 'image_url' || a.dataUrl)).length,
    });
    if (!resume && sess.title === 'New session') sess.title = text.slice(0, 60);

    const runKey = `${sessionId}:${Date.now()}`;
    const ctl = new AbortController();
    controllers.set(runKey, ctl);
    const w = win();

    const askPermission = ({ kind, target, note }) => new Promise((resolve) => {
      // whole-session allow (prototype "allow for the whole session"): remember
      // this exact target so future identical requests auto-allow without prompting.
      const key = kind + '\u0000' + String(target || '');
      if (sessionAlwaysAllow.get(sessionId) && sessionAlwaysAllow.get(sessionId).has(key)) { resolve(true); return; }
      const permId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const timer = setTimeout(() => { pendingPerms.delete(permId); resolve(false); }, 120000);
      const msg = { permId, sessionId, kind, target, canAlways: true, note: note || '' };
      pendingPerms.set(permId, {
        msg,
        resolve: (v, always) => {
          clearTimeout(timer);
          if (v && always) {
            if (!sessionAlwaysAllow.has(sessionId)) sessionAlwaysAllow.set(sessionId, new Set());
            sessionAlwaysAllow.get(sessionId).add(key);
          }
          resolve(v);
        },
      });
      const c0 = chatWebContents(); c0 && c0.send('agent:permission', msg);
    });

    const askUserInput = ({ question, options, kind, questions }) => new Promise((resolve) => {
      const inputId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const timer = setTimeout(() => { pendingInputs.delete(inputId); resolve({ answer: null, cancelled: true }); }, 600000);
      const event = { type: 'user_input', inputId, question, options: options || [], kind: kind || 'ask', ...(Array.isArray(questions) ? { questions } : {}) };
      pendingInputs.set(inputId, { sessionId, runKey, event, resolve: (v) => { clearTimeout(timer); resolve(v); } });
      // Through the agent-event channel the thread already draws. It was sent on its own
      // 'agent:user_input' channel that nothing listened to, so the agent's questions
      // never appeared and the run sat waiting ten minutes for an answer. Found in a live run.
      const c1 = chatWebContents();
      c1 && c1.send('agent:event', { sessionId, runKey, event });
    });

    (async () => {
      try {
        for await (const ev of runAgent({
          session: sess, userText: text, resume,
          attachments: attachments || [],
          apiKey: s.openrouterKey, host: s.openrouterHost, model: sess.model || s.openrouterModel,
          reasoningEffort: s.reasoningEffort, access: s.access, planMode: s.planMode,
          signal: ctl.signal, askPermission, userInput: askUserInput,
          compactThreshold: s.compactThreshold, toolResultMaxChars: s.toolResultMaxChars, contextLimit: s.contextLimit, hardFraction: s.hardFraction,
          budgetUsd: Number(s.runBudgetUsd) > 0 ? Number(s.runBudgetUsd) : 1,
          // $/token from the catalogue, used only as a fallback when the provider
          // does not report real cost — otherwise the cap cannot be enforced.
          priceIn: modelPrice(sess.model || s.openrouterModel).in,
          priceOut: modelPrice(sess.model || s.openrouterModel).out,
          // Whether screenshots are handed over as images or described as unseen.
          modelVision: modelVision(sess.model || s.openrouterModel),
          // Which thinking levels this model takes, so the chip's choice means something.
          reasoningSpec: modelReasoning(sess.model || s.openrouterModel),
          subagentModel: s.subagentModel, subagentMaxTurns: s.subagentMaxTurns, subagentTimeoutMs: s.subagentTimeoutMs, mcpServers: readSettingsFile().mcpServers || {},
          webSearch: { enabled: s.webSearchEnabled, engine: s.webSearchEngine, maxResults: s.webSearchMaxResults },
          onLiveEvent: (le) => { const c = chatWebContents(); c && c.send('agent:event', { sessionId, runKey, event: le }); },
          userData: userData(), live,
          onOpenUrl: (url) => { try { atlasOpenUrl(url); } catch {} },
          onAttachAtlas: () => { try { return browserV && browserV.webContents ? browserV.webContents : null; } catch { return null; } },
        })) {
          const c = chatWebContents(); c && c.send('agent:event', { sessionId, runKey, event: ev });
          // Persist in-flight messages incrementally (debounced) so nothing is
          // lost if the app is closed or crashes before the run finishes.
          // A run that stopped at a limit or failed: remember where, so reopening the
          // session shows the same notice instead of "this run ended before it finished".
          if (ev.type === 'budget_reached' || ev.type === 'limit_reached' || ev.type === 'error') {
            try {
              const stops = sess.stops || (sess.stops = []);
              stops.push({ at: sess.messages.length, type: ev.type, turns: ev.turns, spent: ev.spent, budget: ev.budget, message: String(ev.message || '').slice(0, 400), when: new Date().toISOString() });
              if (stops.length > 20) stops.splice(0, stops.length - 20);
              scheduleSessionSave(sessionId);
            } catch {}
          }
          if (ev.type === 'tool_end' || ev.type === 'tool_start' || ev.type === 'permission') {
            scheduleSessionSave(sessionId);
          }
          if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled' || ev.type === 'limit_reached' || ev.type === 'budget_reached') break;
        }
      } catch (err) {
        const c1 = chatWebContents(); c1 && c1.send('agent:event', { sessionId, runKey, event: { type: 'error', message: err.message } });
      } finally {
        controllers.delete(runKey);
        // flush any pending debounced save now (dupe with the final save below is fine)
        if (saveTimers.has(sessionId)) { clearTimeout(saveTimers.get(sessionId)); saveTimers.delete(sessionId); }
        try { if (sess && sess.messages && sess.messages.length) await store.saveSession(userData(), sess); } catch {}
        // Fix 1: persist the run usage ledger (input/output/cache/cost) before saving,
        // then clear the run-scoped accumulator so the next run starts fresh.
        try {
          const ru = sess._runUsage;
          if (ru && (ru.input || ru.output || ru.cost)) store.recordUsage(sess, ru);
          delete sess._runUsage;
        } catch { /* ledger write is best-effort */ }
        try { await store.saveSession(userData(), sess); } catch { /* disk full? surface next time */ }
      }
    })();
    return { runKey };
  }

  ipcMain.handle('agent:cancel', (_e, runKey) => {
    const ctl = controllers.get(runKey);
    if (ctl) { ctl.abort(); controllers.delete(runKey); return true; }
    return false;
  });
  ipcMain.handle('agent:permission', (_e, { permId, allowed, always }) => {
    const p = pendingPerms.get(permId);
    if (p) { pendingPerms.delete(permId); p.resolve(!!allowed, !!always); return true; }
    return false;
  });
  // ask_user / ask_confirm round-trip (model pauses and asks the user)
  ipcMain.handle('agent:user-input-answer', (_e, { inputId, answer, cancelled }) => {
    const p = pendingInputs.get(inputId);
    // Skipping a question is not an answer of "": it says the user chose not to decide.
    if (p) { pendingInputs.delete(inputId); p.resolve(cancelled ? { answer: null, cancelled: true } : { answer: answer || '', cancelled: false }); return true; }
    return false;
  });
  // manual compact (Compass-like button): force-compact the active session now
  ipcMain.handle('agent:compact', async (_e, { sessionId }) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    const sess = await getLive(sessionId);
    const comp = compactSession(sess, { force: true, systemPrompt: 'You are Vox, the coding agent.' });
    try { await store.saveSession(userData(), sess); } catch {}
    const c = chatWebContents();
    if (comp.compacted) c && c.send('agent:event', { sessionId, runKey: 'manual', event: {
      type: 'compacted', dropped: comp.dropped, keptRecent: comp.keptRecent,
      estimatedBefore: comp.estimatedBefore, estimatedAfter: comp.estimatedAfter,
      reason: 'forced', fitsHardLimit: comp.fitsHardLimit
    } });
    const st = getSettings(false);
    c && c.send('agent:event', { sessionId, runKey: 'manual', event: {
      type: 'context', tokens: estimateSessionTokens(sess, ''),
      limit: Number(st.contextLimit) > 0 ? Number(st.contextLimit) : 200000,
      threshold: Number(st.compactThreshold) > 0 ? Number(st.compactThreshold) : 0.8,
    } });
    return { ok: true, compacted: !!comp.compacted };
  });
  // export a session as JSONL to the workdir (or a chosen path)
  ipcMain.handle('sessions:export', async (_e, { id }) => {
    const sess = await getLive(id);
    const dir = path.join((sess.workdir || os.homedir()), '.voxai', 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${sess.id}.jsonl`);
    fs.writeFileSync(out, store.exportSession(sess), 'utf8');
    return { ok: true, path: out, title: sess.title || '' };
  });
  // "Show in folder" on the export message: the file just written, selected.
  ipcMain.handle('sessions:showExport', async (_e, id) => {
    const sess = await getLive(id);
    const out = path.join((sess.workdir || os.homedir()), '.voxai', 'exports', `${sess.id}.jsonl`);
    if (!fs.existsSync(out)) return false;
    require('electron').shell.showItemInFolder(out);
    return true;
  });
  // project memory viewer (facts in .voxai/memory.json)
  ipcMain.handle('memory:list', async (_e, { workdir }) => {
    const mem = require('../backend/tools/memory');
    const facts = await mem.loadMemory(workdir || os.homedir());
    return { ok: true, facts };
  });
  ipcMain.handle('memory:delete', async (_e, { workdir, query, exact, index }) => {
    const mem = require('../backend/tools/memory');
    const facts = await mem.loadMemory(workdir || os.homedir());
    // The Memory page removes one fact: the one at `index`, if it is still that text.
    // Matching the first 40 characters removed every fact that began the same way.
    if (typeof exact === 'string') {
      const i = Number.isInteger(index) && facts[index] && facts[index].text === exact ? index : facts.findIndex((f) => f.text === exact);
      if (i === -1) return { ok: false, error: 'That fact is no longer there.' };
      facts.splice(i, 1);
      await mem.saveMemory(workdir || os.homedir(), facts);
      return { ok: true, removed: 1 };
    }
    const q = String(query || '').toLowerCase();
    if (!q) return { ok: false, error: 'query required' };
    const kept = facts.filter((f) => !f.text.toLowerCase().includes(q));
    if (kept.length !== facts.length) { await mem.saveMemory(workdir || os.homedir(), kept); return { ok: true, removed: facts.length - kept.length }; }
    return { ok: true, removed: 0 };
  });

  // direct OpenRouter (cheap turns + key test)
  ipcMain.handle('llm:chat', async (_e, { messages, model, maxTokens }) => {
    const s = getSettings(false);
    if (!s.openrouterKey) throw new Error('No OpenRouter API key configured.');
    return chatOnce({ apiKey: s.openrouterKey, host: s.openrouterHost, model: model || s.openrouterModel, messages, maxTokens: maxTokens || 1024 });
  });
  ipcMain.handle('llm:testKey', async (_e, { key, model }) => {
    const s = getSettings(false);
    const useKey = key || s.openrouterKey;
    if (!useKey) throw new Error('Paste an OpenRouter key first.');
    return chatOnce({
      apiKey: useKey, host: s.openrouterHost, model: model || s.openrouterModel,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 8,
    });
  });

  // ---- OpenRouter account balance + usage ----
// Standard key:  GET /api/v1/credits  -> { data: { total_credits, total_usage } }
//                GET /api/v1/generation -> paginated usage history (per generation)
// Management/admin key can read more; we surface whatever these endpoints return.
function orHost() { return (getSettings(false).openrouterHost || 'https://openrouter.ai').replace(/\/+$/, ''); }
function orAuth() { const s = getSettings(false); if (!s.openrouterKey && !s.managementKey) return null; return { host: orHost(), key: s.openrouterKey, mgmt: s.managementKey }; }

// Balance (credits) — account data via the MANAGEMENT key (regular keys get 403),
// key-quota via the normal chat key.
ipcMain.handle('openrouter:usage', async () => {
  const auth = orAuth();
  if (!auth) return { ok: false, error: 'no-key' };
  const out = { ok: false };
  try {
    // Try /credits with mgmt key first (account balance), then fall back to the
    // chat key — OpenRouter accepts the account key on /credits in practice too.
    const tries = [];
    if (auth.mgmt) tries.push({ label: 'mgmt', key: auth.mgmt });
    if (auth.key) tries.push({ label: 'chat', key: auth.key });
    let cred = {}, credStatus = 0, credBy = null;
    for (const t of tries) {
      try {
        const r = await fetch(auth.host + '/api/v1/credits', { headers: { Authorization: 'Bearer ' + t.key } });
        if (r.ok) { cred = (await r.json()).data || {}; credStatus = r.status; credBy = t.label; break; }
        credStatus = r.status;
      } catch {}
    }

    // Key info from /auth/key (chat key preferred; mgmt key also answers).
    let key = {}, keyStatus = 0;
    const keyTry = auth.key || auth.mgmt;
    if (keyTry) {
      try {
        const r = await fetch(auth.host + '/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + keyTry } });
        keyStatus = r.status;
        if (r.ok) key = (await r.json()).data || {};
      } catch {}
    }

    const acctTotal = cred.total_credits != null ? cred.total_credits : null;
    const acctUsage = cred.total_usage != null ? cred.total_usage : null;
    const acctLeft = (acctTotal != null && acctUsage != null) ? acctTotal - acctUsage : null;
    const keyUsage = key.usage != null ? key.usage : null;
    const keyLimit = key.limit != null ? key.limit : null;
    const keyLeft = key.limit_remaining != null ? key.limit_remaining : (keyLimit != null && keyUsage != null ? keyLimit - keyUsage : null);

    out.ok = true;
    out.credits = { total: acctTotal, usage: acctUsage, left: acctLeft };
    out.key = { label: key.label || '', usage: keyUsage, limit: keyLimit, left: keyLeft, isFreeTier: !!key.is_free_tier, management: !!key.management, isAdmin: !!key.management };
    out.hasMgmtKey = !!auth.mgmt;
    out.creditsStatus = credStatus;
    out.creditsBy = credBy;       // which key answered /credits (mgmt | chat | null)
    out.keyStatus = keyStatus;
    out.raw = { credits: cred, key };
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---- Test a management key in Settings: prove it is one + can read account data ----
ipcMain.handle('openrouter:testMgmt', async (_e, { key } = {}) => {
  const s = getSettings(false);
  const useKey = key || s.managementKey;
  if (!useKey) return { ok: false, error: 'Paste a management key first.' };
  const host = orHost();
  const out = { ok: false };
  // 1) credits endpoint → account balance
  try {
    const c = await fetch(host + '/api/v1/credits', { headers: { Authorization: 'Bearer ' + useKey } });
    let body = null; try { body = await c.json(); } catch {}
    out.credits = { status: c.status, ok: c.ok, body: body };
  } catch (e) { out.credits = { error: String(e && e.message || e) }; }
  // 2) /auth/key → does it identify as a management/admin key?
  try {
    const k = await fetch(host + '/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + useKey } });
    let kb = null; try { kb = await k.json(); } catch {}
    out.key = { status: k.status, ok: k.ok, body: kb };
  } catch (e) { out.key = { error: String(e && e.message || e) }; }
  // 3) /api/v1/keys → management-only endpoint (proves it's a management key)
  try {
    const ks = await fetch(host + '/api/v1/keys?limit=3', { headers: { Authorization: 'Bearer ' + useKey } });
    let kb = null; try { kb = await ks.json(); } catch {}
    out.listKeys = { status: ks.status, ok: ks.ok, body: kb };
  } catch (e) { out.listKeys = { error: String(e && e.message || e) }; }
  out.ok = true;
  return out;
});

// Usage history — via the analytics API (management key). The older
// /generation endpoint needs a generation id (list call gets 400), so we use
// POST /api/v1/analytics/query which supports account-level spend by model.
ipcMain.handle('openrouter:generations', async (_e, { limit = 40, cursor } = {}) => {
  const auth = orAuth();
  const authKey = auth && (auth.mgmt || auth.key);
  if (!authKey) return { ok: false, error: 'no-key' };
  try {
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const q = {
      dimensions: ['model'],
      metrics: ['request_count', 'total_usage', 'tokens_total'],
      time_range: { start: start.toISOString(), end: end.toISOString() },
      limit: Math.min(limit || 40, 100),
    };
    const res = await fetch(auth.host + '/api/v1/analytics/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(q),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body && body.error && (body.error.message || body.error.code)) || ('HTTP ' + res.status);
      return { ok: false, error: String(msg), status: res.status };
    }
    // The rows are not always a bare array at body.data: that assumption threw
    // "(...).map is not a function" and the usage window showed nothing. Take the first
    // array among the shapes the endpoint uses; say what came back if there is none.
    const d = body && body.data;
    const list = [d, d && d.rows, d && d.data, d && d.results, body && body.rows, body && body.results].find(Array.isArray);
    if (!list) {
      const shape = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 8).join(', ') : typeof o);
      return { ok: false, error: 'unexpected usage response (data: ' + shape(d) + '; top: ' + shape(body) + ')' };
    }
    const rows = list.map((r) => ({
      model: r.model || '?',
      createdAt: null,
      nativeTotal: Number(r.tokens_total || 0),
      requestCount: Number(r.request_count || 0),
      cost: r.total_usage != null ? r.total_usage : null, // dollars
    }));
    // Biggest spend first: in the order it arrived, the model that cost $26 was last.
    rows.sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
    return { ok: true, rows, hasMore: false, total: rows.length, nextCursor: null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// OpenRouter model catalog (for the composer model picker)
  ipcMain.handle('openrouter:models', () => fetchModels());
  async function fetchModels() {
    const s = getSettings(false);
    if (!s.openrouterKey) return { ok: false, error: 'no-key' };
    try {
      const host = (s.openrouterHost || 'https://openrouter.ai').replace(/\/+$/, '');
      const res = await fetch(host + '/api/v1/models', { headers: { Authorization: 'Bearer ' + s.openrouterKey } });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const body = await res.json();
      const list = (body && body.data) || [];
      const models = list.map((m) => {
        const params = new Set(m.supported_parameters || []);
        return {
          id: m.id,
          name: m.name || m.id,
          context: m.context_length || null,
          promptCents: m.pricing && m.pricing.prompt != null ? parseFloat(m.pricing.prompt) * 100 : null,
          completionCents: m.pricing && m.pricing.completion != null ? parseFloat(m.pricing.completion) * 100 : null,
          // A model without native tool support does not error — it just answers in
          // prose forever, which is indistinguishable from a broken agent. Keep the
          // capability flags so the picker can say so up front.
          tools: params.has('tools'),
          structuredOutputs: params.has('structured_outputs') || params.has('response_format'),
          reasoning: params.has('reasoning') || params.has('reasoning_effort'),
          // The levels it accepts and its default, straight from the catalogue. The
          // reasoning menu is built from this, so it needs no list of model names.
          reasoningSpec: m.reasoning && typeof m.reasoning === 'object' ? {
            supported_efforts: Array.isArray(m.reasoning.supported_efforts) ? m.reasoning.supported_efforts : [],
            default_effort: m.reasoning.default_effort || null,
            default_enabled: m.reasoning.default_enabled !== false,
            mandatory: m.reasoning.mandatory === true,
          } : null,
          // Image input is a MODALITY, not a parameter, so supported_parameters never
          // mentions it. null = the catalogue did not say, which is not the same as no.
          vision: m.architecture && Array.isArray(m.architecture.input_modalities)
            ? m.architecture.input_modalities.includes('image') : null,
          maxCompletion: (m.top_provider && m.top_provider.max_completion_tokens) || null,
          // Can it do this job at all? It has to write text and call tools. Image and
          // audio generators (Nano Banana, GPT Image, Lyria...) and models without tool
          // calling were all in the picker; none of them can read or edit a file.
          coding: params.has('tools') && !!(m.architecture && Array.isArray(m.architecture.output_modalities)
            && m.architecture.output_modalities.length === 1 && m.architecture.output_modalities[0] === 'text'),
        };
      });
      // Every model stays known for capability checks (an older session may name one),
      // but the picker is offered only the ones that can code.
      modelCapCache = { at: Date.now(), byId: new Map(models.map((m) => [m.id, m])) };
      return { ok: true, models: models.filter((m) => m.coding) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Workspace context for the status bar: branch + uncommitted diff totals. Read-only
  // git plumbing, never mutating, and it fails soft — a folder that is not a repo is a
  // normal case, not an error.
  ipcMain.handle('workspace:context', async (_e, { workdir }) => {
    // No silent fallback to the global working-dir setting. That substitution is what
    // made a fresh session in one project report another project's branch and diff —
    // the caller asked about nothing and got a confident answer about somewhere else.
    if (!workdir) return { ok: true, cwd: null, repo: false, unknown: true };
    const cwd = workdir;
    const git = (args) => new Promise((resolve) => {
      try {
        require('child_process').execFile('git', args, { cwd, timeout: 2500, windowsHide: true },
          (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
      } catch { resolve(null); }
    });
    // Is this a repo at all? Ask that directly rather than inferring it from a
    // command that also fails for other reasons.
    const inRepo = await git(['rev-parse', '--is-inside-work-tree']);
    if (inRepo !== 'true') return { ok: true, cwd, repo: false };

    // symbolic-ref works on an UNBORN branch (a fresh `git init` with no commits);
    // `rev-parse --abbrev-ref HEAD` just prints the literal string "HEAD" there,
    // which would show up in the UI as a branch called HEAD.
    let branch = await git(['symbolic-ref', '--short', 'HEAD']);
    if (!branch) branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const hasCommits = (await git(['rev-parse', '--verify', 'HEAD'])) !== null;

    // With no commits there is nothing to diff against, so every tracked line is an
    // addition; `--shortstat HEAD` would simply error and report zero changes.
    const stat = hasCommits
      ? await git(['diff', '--shortstat', 'HEAD'])
      : await git(['diff', '--shortstat', '--cached']);
    const porcelain = await git(['status', '--porcelain']);

    let added = 0; let removed = 0;
    if (stat) {
      const a = /(\d+) insertion/.exec(stat); const d = /(\d+) deletion/.exec(stat);
      added = a ? Number(a[1]) : 0; removed = d ? Number(d[1]) : 0;
    }
    const dirty = porcelain ? porcelain.split(String.fromCharCode(10)).map(function (x) { return x.trim(); }).filter(Boolean).length : 0;
    return { ok: true, cwd, repo: true, branch: branch || 'HEAD', hasCommits, added, removed, dirty };
  });

  // Per-file diff for the strip above the composer. The prototype's DIFF REVIEW
  // screen listed path, status and +/- per file; this is that data, surfaced where
  // you are already looking instead of behind a tab.
  ipcMain.handle('workspace:diff', async (_e, { workdir }) => {
    if (!workdir) return { ok: true, repo: false, files: [], unknown: true };
    const cwd = workdir;
    const git = (args) => new Promise((resolve) => {
      try {
        require('child_process').execFile('git', args, { cwd, timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => resolve(err ? null : String(stdout || '')));
      } catch { resolve(null); }
    });
    const inRepo = await git(['rev-parse', '--is-inside-work-tree']);
    if (!inRepo || inRepo.trim() !== 'true') {
      return { ok: true, repo: false, files: [] };
    }
    const hasCommits = (await git(['rev-parse', '--verify', 'HEAD'])) !== null;
    const numstat = hasCommits ? await git(['diff', '--numstat', 'HEAD']) : await git(['diff', '--numstat', '--cached']);
    const status = await git(['status', '--porcelain']);
    const byPath = new Map();
    for (const line of String(numstat || '').split(String.fromCharCode(10))) {
      const t = line.trim(); if (!t) continue;
      const parts = t.split(String.fromCharCode(9));
      if (parts.length < 3) continue;
      byPath.set(parts[2], { path: parts[2], add: Number(parts[0]) || 0, del: Number(parts[1]) || 0, st: 'M' });
    }
    for (const line of String(status || '').split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2).trim();
      const p2 = line.slice(3).trim().replace(/^"|"$/g, '');
      const rec = byPath.get(p2) || { path: p2, add: 0, del: 0 };
      rec.st = code.includes('?') ? 'A' : (code[0] || 'M');
      byPath.set(p2, rec);
    }
    const files = [...byPath.values()].sort((a, b) => (b.add + b.del) - (a.add + a.del));
    const add = files.reduce((n, f) => n + f.add, 0);
    const del = files.reduce((n, f) => n + f.del, 0);
    return { ok: true, repo: true, hasCommits, files: files.slice(0, 200), add, del, total: files.length };
  });

  // misc
  ipcMain.handle('dialog:openDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // shell.openExternal hands the string to the OS, which will honour ANY registered
  // protocol handler -- so a URL picked up from a visited page must not reach it
  // unchecked. Only the three schemes the preview can legitimately be showing.
  ipcMain.handle('shell:openExternal', (_e, url) => {
    const u = String(url || '');
    if (!/^(https?|file):\/\//i.test(u)) return { ok: false, error: 'refused: only http(s) and file URLs open externally' };
    try { shell.openExternal(u); return { ok: true }; }
    catch (e) { return { ok: false, error: e && e.message }; }
  });

  // Open a workspace file in the preview, and optionally remember that this project
  // always wants that.
  ipcMain.handle('preview:openFile', (_e, { url, workdir, always }) => {
    // Resolve against the SESSION's workdir. Falling back to the global setting
    // meant a file in the session's own project was judged against a different
    // folder entirely, failed containment, and the preview opened to nothing —
    // half the window went black with no explanation.
    const root = workdir || getSettings(false).workingDir;
    const ok = previewableUrl(url, root);
    if (!ok) {
      return { ok: false, error: 'refused: ' + url + ' is not inside ' + root };
    }
    if (always && workdir) {
      const raw = readSettingsFile();
      raw.previewAuto = raw.previewAuto && typeof raw.previewAuto === 'object' ? raw.previewAuto : {};
      raw.previewAuto[String(workdir)] = true;
      writeSettingsFile(raw);
    }
    atlasOpenUrl(ok, root);
    return { ok: true, url: ok };
  });
  ipcMain.handle('preview:autoPref', (_e, { workdir }) => {
    const s2 = getSettings(false);
    return { auto: !!(s2.previewAuto && s2.previewAuto[String(workdir)]) };
  });


  try { createWindow(); } catch (e) { try { console.error('createWindow failed:', e && e.message); } catch {} }
  app.on('activate', () => { try { if (BrowserWindow.getAllWindows().length === 0) createWindow(); } catch (e) {} });

  // Updates from CodeRook's feed, signature-checked (see updater.js).
  let updater = null;
  try {
    updater = require('./updater').initUpdater({
      app,
      send: (st) => { const c = chatWebContents(); c && c.send('update:state', st); },
      log: (m) => { try { console.log('[update] ' + m); } catch {} },
    });
  } catch (e) { try { console.error('updater failed to start:', e && e.message); } catch {} }
  app.on('browser-window-focus', () => { try { updater && updater.onFocus(); } catch {} });
  ipcMain.handle('update:state', () => (updater ? updater.state() : { state: 'off', version: app.getVersion() }));
  ipcMain.handle('update:check', () => (updater ? updater.check() : null));
  ipcMain.handle('update:install', () => (updater ? updater.install() : false));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// Servers and watchers the agent left running end with the app, not after it. A
// python http.server started for a preview was still listening once the app was gone.
app.on('will-quit', () => { try { require('../backend/tools/procs').stopAll(); } catch {} });
