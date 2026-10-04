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
const team = require('../backend/team');
const os = require('os');

const { runAgent, pendingAsk, answerPendingAsk } = require('../backend/agent');
const { chatOnce, normalizeReasoning } = require('../backend/providers/openrouter');
const store = require('../backend/sessions');
const goalLib = require('../backend/goal');
const commands = require('../backend/commands');
const checkpoints = require('../backend/tools/checkpoints');
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
// Windows shows a notification only for a known app id: the installer's shortcut carries
// build.appId; a dev copy uses electron.exe's own path.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'ai.vox.coder' : process.execPath);
let attention = null;   // tray, badge, notifications (attention.js), made when the app is ready
app.on('second-instance', (_e, argv) => {
  // A notification's Allow / Deny answers without bringing the window forward; Open does.
  const link = (argv || []).find((a) => /^voxai-coder:\/\//i.test(String(a)));
  if (link && attention && attention.handleLink(link) && !/^voxai-coder:\/\/open/i.test(link)) return;
  const w = win();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

// ---------------------------------------------------------------- settings ---
const SETTINGS_PATH = path.join(app.getPath('userData'), 'voxai-settings.json');

// The file's text, kept until the file changes. Settings were read from disk (and the keys
// decrypted) every second by the tray's tick, and several times more per run; a stat is all
// that is needed to know nothing changed. Each caller still gets its own parsed copy.
let settingsText = null, settingsStamp = '';
function readSettingsFile() {
  try {
    const st = fs.statSync(SETTINGS_PATH);
    const stamp = st.mtimeMs + ':' + st.size;
    if (stamp !== settingsStamp || settingsText === null) { settingsText = fs.readFileSync(SETTINGS_PATH, 'utf8'); settingsStamp = stamp; }
    return JSON.parse(settingsText);
  } catch { /* missing or corrupted → fresh */ }
  return {};
}
function writeSettingsFile(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const text = JSON.stringify(obj, null, 2);
  fs.writeFileSync(SETTINGS_PATH, text);
  try { const st = fs.statSync(SETTINGS_PATH); settingsText = text; settingsStamp = st.mtimeMs + ':' + st.size; } catch { settingsText = null; }
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
const decrypted = new Map();   // enc -> plain: decrypting every second (see readSettingsFile) went through the OS keychain
function decryptSecret(blob) {
  if (!blob || !blob.enc) return '';
  // Not cached while the keychain is not ready yet (before the app is): read that early the key
  // comes out wrong, and kept, every request after it went out with a garbled key ("Cannot
  // convert argument to a ByteString" -- shown as "could not reach OpenRouter").
  if (blob.store === 'keychain' && !safeStorage.isEncryptionAvailable()) return decryptSecretNow(blob);
  const hit = decrypted.get(blob.store + ':' + blob.enc);
  if (hit !== undefined) return hit;
  const plain = decryptSecretNow(blob);
  if (decrypted.size > 8) decrypted.clear();
  decrypted.set(blob.store + ':' + blob.enc, plain);
  return plain;
}
function decryptSecretNow(blob) {
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
    // DeepSeek V4.1 Flash: it can see screenshots, and in the one-shot build test it made a
    // working app for ~$0.25 where V4 Flash (text only) made nothing usable.
    openrouterModel: raw.openrouterModel || 'deepseek/deepseek-v4.1-flash',
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
    // A goal's runs together, in USD (see goalStep). A run that hits its own limit is followed by the next.
    goalBudgetUsd: raw.goalBudgetUsd || '5.00',
    // Looks at screenshots for a model that cannot, and says what it sees. '' = off.
    visionHelperModel: typeof raw.visionHelperModel === 'string' ? raw.visionHelperModel : 'deepseek/deepseek-v4.1-flash',
    // Auto's check of each action: a short yes/no, on a cheap model. '' = the session's own model.
    autoCheckModel: typeof raw.autoCheckModel === 'string' ? raw.autoCheckModel : 'deepseek/deepseek-v4.1-flash',
    // Where the .gguf models for this PC are (local-engine.js), first one first. The engine lives in the
    // first one too (.voxai-engine), on whatever drive you keep your models on, not C:.
    localModelsDirs: Array.isArray(raw.localModelsDirs) ? raw.localModelsDirs.filter((d) => typeof d === 'string' && d.trim())
      : (typeof raw.localModelsDir === 'string' && raw.localModelsDir.trim() ? [raw.localModelsDir] : []),
    // Claude keeps the conversation cached for an hour instead of five minutes (writes cost more).
    claudeCacheHour: raw.claudeCacheHour === true,
    // "Cheaper, slower": models sent on OpenRouter's flex tier (openrouter.js flexRoute), with the
    // flex price seen when it was switched on. id -> { promptCents, completionCents, at }.
    flexModels: raw.flexModels && typeof raw.flexModels === 'object' && !Array.isArray(raw.flexModels) ? raw.flexModels : {},
    splitLayout: raw.splitLayout && typeof raw.splitLayout === 'object' ? raw.splitLayout : null,
    trayHintShown: raw.trayHintShown === true,
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
    // When a session needs you and VoxAI is not in front (attention.js).
    notifyToast: raw.notifyToast !== false,
    notifyTaskbar: raw.notifyTaskbar !== false,
    notifyNative: raw.notifyNative === true,   // Windows' own notification instead of the VoxAI card
    trayOnMinimize: raw.trayOnMinimize === true,
    trayOnClose: raw.trayOnClose === true,
    // Projects you said may be shared with a data-sharing model's maker (backend/team.js): folder key -> { at }.
    dataShareOk: raw.dataShareOk && typeof raw.dataShareOk === 'object' ? raw.dataShareOk : {},
    // Models OpenRouter refused to this app (not the key): id -> { why, at }. The picker greys them.
    refusedModels: raw.refusedModels && typeof raw.refusedModels === 'object' ? raw.refusedModels : {},
    // The Team hint ("let a cheap model code"): times you said Not now, by model. Two and it stops.
    teamHintNo: raw.teamHintNo && typeof raw.teamHintNo === 'object' ? raw.teamHintNo : {},
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
// ------------------------------------------------------------------ steering ---
// A message the user sends while a run is going, for THAT run.
//
// Steering used to be queue-only: the renderer held the message and drainQueue sent it,
// but drainQueue only ever runs when a run ENDS. So a steered message could not reach a
// live run at all -- the queue sat there until you pressed Stop, which is exactly the
// behaviour it was meant to replace. Now the message comes straight here, the run picks it
// up at its next turn, and it is appended to the transcript at the end.
const steerInbox = new Map();  // sessionId → [{ text }]

/**
 * A trace file for steering, so "did it send?" is answerable from the evidence instead of by
 * guessing. It records each hop the note has to make: the renderer's IPC arriving, whether a
 * controller existed at that moment, and whether the agent then READ it at a turn boundary.
 * Without this the note could sit in the queue with no way to tell which hop it died on.
 */
function steerTrace(sessionId, what, extra) {
  try {
    const f = path.join(userData(), 'steer.log');
    const line = `${new Date().toISOString()}  ${what}  session=${sessionId}${extra ? '  ' + extra : ''}\n`;
    fs.appendFileSync(f, line);
    if (fs.statSync(f).size > 64 * 1024) fs.writeFileSync(f, line);
  } catch { /* tracing must never break steering */ }
}

function steerPush(sessionId, text) {
  const t = String(text == null ? '' : text).trim();
  if (!sessionId || !t) return false;
  if (!steerInbox.has(sessionId)) steerInbox.set(sessionId, []);
  steerInbox.get(sessionId).push({ text: t });
  return true;
}

/** Drain everything steered for this session. Called at the top of each agent turn. */
function steerFor(sessionId) {
  return () => {
    const box = steerInbox.get(sessionId);
    if (!box || !box.length) return [];
    const texts = box.splice(0).map((m) => m.text).filter(Boolean);
    if (!box.length) steerInbox.delete(sessionId);
    // The hop that decides everything: the agent asks for steers at the top of a turn. Reaching
    // here means the run really read the note.
    steerTrace(sessionId, 'READ-BY-AGENT', JSON.stringify(texts));
    return texts;
  };
}

/** Nothing is running, so anything steered would never be read: clear it. */
function steerClear(sessionId) {
  const box = steerInbox.get(sessionId);
  if (!box) return [];
  const texts = box.splice(0).map((m) => m.text).filter(Boolean);
  steerInbox.delete(sessionId);
  return texts;
}

/**
 * Take a steered message back, if the run has not read it yet.
 *
 * Steering sends the message into the live run straight away, but the run only reads it at
 * the top of its next turn. In that window the user can still change their mind and queue it
 * behind the run instead. Once the turn has started, the inbox copy is gone and there is
 * nothing to recall, so this says so rather than silently doing nothing.
 */
function steerRecall(sessionId, text) {
  const box = steerInbox.get(sessionId);
  if (!box) return { recalled: false, read: true };
  const i = box.findIndex((m) => m.text === text);
  if (i === -1) return { recalled: false, read: true };
  box.splice(i, 1);
  if (!box.length) steerInbox.delete(sessionId);
  return { recalled: true, read: false };
}
const sessionAlwaysAllow = new Map(); // sessionId -> Set<string> (normalized target) 
const pendingPerms = new Map(); // permId → {msg, runKey, resolve}
const pendingInputs = new Map(); // inputId → {sessionId, runKey, event, resolve}  (ask_user / ask_confirm)
// Esc stops a run while it drives the desktop (Byte's kill switch): registered for all of Windows only
// while desktop control is in use, and released 30 s after its last action or when the run ends.
let escArm = null;   // { runKey, ctl, timer }
function disarmDesktopEsc(runKey) {
  if (!escArm || (runKey && escArm.runKey !== runKey)) return;
  clearTimeout(escArm.timer);
  try { require('electron').globalShortcut.unregister('Escape'); } catch { /* not registered */ }
  escArm = null;
}
// Held while a desktop action runs, and a few seconds after it ends -- not 30 s from its start, which
// took Esc from every app for half a minute. Longer than an action, shorter than a pause to think:
// after that, moving the mouse or Stop still stops the run.
const ESC_AFTER_MS = 6000, ESC_DURING_MS = 60000;
function armDesktopEsc(runKey, ctl, phase) {
  if (!escArm || escArm.runKey !== runKey) {
    disarmDesktopEsc();
    let ok = false;
    try { ok = require('electron').globalShortcut.register('Escape', () => { const a = escArm; disarmDesktopEsc(); if (a) { try { a.ctl.abort(); } catch { /* ended */ } } }); } catch { ok = false; }
    escArm = { runKey, ctl, timer: null, ok };
  }
  clearTimeout(escArm.timer);
  escArm.timer = setTimeout(() => disarmDesktopEsc(runKey), phase === 'end' ? ESC_AFTER_MS : ESC_DURING_MS);
}
// The agent's own Esc (closing a menu) must reach the app and must not end its run.
try {
  require('../backend/cu/desktop').setEscHooks({
    suspend: () => { if (escArm) { try { require('electron').globalShortcut.unregister('Escape'); } catch { /* not registered */ } } },
    resume: () => {
      const a = escArm;
      if (!a) return;
      try { require('electron').globalShortcut.register('Escape', () => { const x = escArm; disarmDesktopEsc(); if (x) { try { x.ctl.abort(); } catch { /* ended */ } } }); } catch { /* taken */ }
    },
  });
} catch { /* no desktop control on this platform */ }
/**
 * A picture of this app's own window for desktop control, drawn by Electron: the chat
 * view, with the preview pasted into its slot when it is open. Windows could only copy
 * the screen here (PrintWindow waits on this very thread), so whatever covered the window
 * was in the picture. x/y/w/h are the content area on screen, in physical pixels, so a
 * point in the picture still maps to a click. Null when it is not our window or cannot be drawn.
 */
async function captureOwnWindow(hwnd) {
  const w = win();
  if (!w || w.isDestroyed() || w.isMinimized() || !chatV) return null;
  const h = w.getNativeWindowHandle();
  const mine = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
  if (Number(hwnd) !== mine) return null;
  const { screen, nativeImage } = require('electron');
  const cb = w.getContentBounds();
  const sf = screen.getDisplayMatching(cb).scaleFactor || 1;
  const base = await chatV.webContents.capturePage();
  if (!base || base.isEmpty()) return null;
  const size = base.getSize(sf);
  const W = size.width, H = size.height;
  let bmp = Buffer.from(base.toBitmap({ scaleFactor: sf }));
  if (bmp.length !== W * H * 4) return null;
  if (atlasOpen && browserV && browserV.getVisible && browserV.getVisible()) {
    try {
      const b = browserV.getBounds();
      const img = await browserV.webContents.capturePage();
      if (img && !img.isEmpty()) {
        const os2 = img.getSize(sf), ob = img.toBitmap({ scaleFactor: sf });
        const k = W / Math.max(1, cb.width);
        const ox = Math.round(b.x * k), oy = Math.round(b.y * k);
        for (let y = 0; y < os2.height && oy + y < H; y++) {
          const n = Math.min(os2.width, W - ox);
          if (n > 0 && oy + y >= 0) ob.copy(bmp, ((oy + y) * W + ox) * 4, y * os2.width * 4, (y * os2.width + n) * 4);
        }
      }
    } catch { /* the chat alone still shows the app */ }
  }
  const out = nativeImage.createFromBitmap(bmp, { width: W, height: H, scaleFactor: 1 });
  const r = screen.dipToScreenRect(w, cb);
  return { dataUrl: 'data:image/png;base64,' + out.toPNG().toString('base64'), x: r.x, y: r.y, w: r.width, h: r.height };
}
try { require('../backend/cu/desktop').setOwnCapture(captureOwnWindow); } catch { /* no desktop control on this platform */ }
/** Sessions with a question or an approval open right now. */
function waitingIds() {
  return new Set([...pendingInputs.values()].map((p) => p.sessionId)
    .concat([...pendingPerms.values()].map((p) => p.msg && p.msg.sessionId)).filter(Boolean));
}

function userData() { return app.getPath('userData'); }
async function getLive(id) {
  if (live.get(id)) return live.get(id);
  const s = await store.loadSession(userData(), id);
  live.set(id, s);
  return s;
}
// The app's own window. Not "the first window": a sign-in pop-up from the preview is a
// window too, and could be listed first.
let mainWindow = null;
function win() { return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : BrowserWindow.getAllWindows()[0]; }
// With Atlas split the window content is a root View; the chat lives in
// chatV.webContents. `win()` still returns the BrowserWindow (for geometry),
// but message sends must target chatV.webContents.
function chatWebContents() {
  return (chatV && chatV.webContents) || (win() && win().webContents);
}
// The sessions on screen -- the main pane's and any side by side -- so the next start puts
// them back (renderer: restoreLayout). Written only when it changes.
let splitSaved = '';
function saveSplitLayout() {
  if (!split) return;
  const layout = { main: split.mainSession() || '', panes: split.sids() };
  const key = JSON.stringify(layout);
  if (key === splitSaved) return;
  splitSaved = key;
  try { const raw = readSettingsFile(); raw.splitLayout = layout; writeSettingsFile(raw); } catch { /* next change tries again */ }
}
// What happens in a session goes to every page that may show it: the window's own and
// each split pane (split.js). Each keeps its sessions up to date; the one showing it draws it.
let split = null;
function allRenderers() {
  const list = [chatWebContents(), ...(split ? split.contents() : [])].filter((c) => c && !c.isDestroyed());
  return { send: (ch, data) => { for (const c of list) { try { c.send(ch, data); } catch { /* closing */ } } } };
}

// ---------------------------------------------------------------- terminal ---
// A real shell docked beside the chat (from the Linux edition): a pty per panel, so a command
// that asks something can be answered there. node-pty ships prebuilt for Windows; if it cannot
// load, the panel says why and nothing else changes.
const terminalAvail = require('./terminal').available();
const { TerminalManager } = require('./terminal');
const interactive = require('./interactive');
const terminals = new TerminalManager({
  onData: (id, chunk) => {
    // A command the agent runs in the panel: this is where its exit code comes from.
    try { interactive.noteChunk(id, chunk); } catch { /* never break output */ }
    // Every page that shows the chat (the chat is a WebContentsView, not the window's own page).
    try { allRenderers().send('term:data', { id, data: chunk }); } catch { /* closing */ }
  },
  onExit: (id, info) => {
    try { interactive.noteExit(id, info); } catch { /* never break exit */ }
    try { allRenderers().send('term:exit', { id, ...info }); } catch { /* closing */ }
  },
});
// A shell must not outlive the app.
app.on('before-quit', () => { try { terminals.closeAll(); } catch { /* nothing open */ } });

// File menu -> the window (New Session, Open Folder). It lived inside the startup
// function, out of reach of the menu built in createWindow, so the menu items and
// their shortcuts (Ctrl+N, Ctrl+O) threw and did nothing. Found in a live test.
function relay(ch) { const c = chatWebContents(); if (c) c.send('vox:menu', ch); }

// ------------------------------------------------------------------- window ---
function createWindow() {
  const w = mainWindow = new BrowserWindow({
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
  // The parked browsers' windows go with the app's, or the app would never quit.
  w.on('closed', () => { for (const v of [defaultBrowser, ...sessionBrowsers.values()]) unpark(v); });
  if (attention) attention.wireWindow(w);
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

// Models on this PC (local-engine.js): llama-server, started on demand. Its address goes to the
// model code, which sends "local/..." model ids there instead of to OpenRouter.
const localEngineMod = require('./local-engine');
const localModelDirs = () => getSettings(false).localModelsDirs || [];
const localEngine = localEngineMod.createLocalEngine({
  // Beside your models (the first folder), not on C: -- that drive was nearly full. Nowhere else to go: app data.
  baseDir: () => (localModelDirs()[0] ? path.join(localModelDirs()[0], '.voxai-engine') : path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'voxai-coder-engine')),
  log: (m) => { try { console.log('[local] ' + m); } catch {} },
  onState: (st) => { try { const c = allRenderers(); c && c.send('local:state', st); } catch {} },
});
require('../backend/providers/openrouter').localEndpoint.url = () => localEngine.url();
// Flex only where it was switched on, and only once a flex endpoint was seen for that model:
// ":floor" on a model without one just sorts its providers by price, which is not what was asked.
require('../backend/providers/openrouter').flexRoute.use = (model) => { const f = getSettings(true).flexModels; return !!(f && f[model]); };
// What "slow" is measured against, and where a slow request is said: a toast in every window
// (a Team coder's own warnings are not shown in the chat).
require('../backend/providers/openrouter').localEndpoint.expected = () => { const s = localEngine.state(); return { tps: s.tps, pps: s.pps }; };
require('../backend/providers/openrouter').localEndpoint.onSlow = (info) => { try { const c = allRenderers(); c && c.send('local:slow', info); } catch {} };
/** Catalogue entries for the models in the local folder: free, tool-calling, no image input. */
// The engine is llama.cpp's Windows (Vulkan) build, unpacked with Windows tar, sized with PowerShell: on
// Linux (the AppImage) every step of it can only fail, so models on this PC are offered on Windows only.
const LOCAL_SUPPORTED = process.platform === 'win32';
function localCatalog() {
  const dirs = localModelDirs();
  if (!dirs.length || !LOCAL_SUPPORTED) return [];
  const st = localEngine.state();
  return localEngine.models(dirs).map((m) => ({
    id: m.id, name: 'This PC: ' + m.name, context: st.model === m.file && st.ctx ? st.ctx : localEngineMod.WANT_CTX,
    promptCents: 0, completionCents: 0, cacheReadCents: 0, cacheWriteCents: 0,
    tools: true, structuredOutputs: false, reasoning: false, reasoningSpec: null, vision: false,
    maxCompletion: 8192, sharesData: null, coding: true, local: true, bytes: m.bytes, sidecar: !!m.sidecar, tps: m.tps || 0,
  }));
}
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
/**
 * How long an answer a model may write, from its catalogue entry: every request asked for 16,384
 * tokens, more than some providers allow a model -- a refusal before anything ran. (A local
 * model's entry says 8,192.) 16,384 stays the most asked for; VOX_MAX_TOKENS still wins.
 */
function modelMaxTokens(modelId) {
  if (Number(process.env.VOX_MAX_TOKENS) > 0) return Number(process.env.VOX_MAX_TOKENS);
  const cap = modelCapCache.byId.get(modelId);
  const mc = Number(cap && cap.maxCompletion);
  return mc >= 1024 ? Math.min(16384, mc) : 16384;
}
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
// The app's own page, exactly. Any file named renderer/index.html (one in a project) passed the
// old pattern, and would have been handed the whole bridge had this view ever gone to it.
const APP_PAGE = path.resolve(__dirname, '..', 'renderer', 'index.html').replace(/\\/g, '/').toLowerCase();
function isAppPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    return require('url').fileURLToPath(u).replace(/\\/g, '/').toLowerCase() === APP_PAGE;
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
    // Sandboxed like every other view: the preload needs nothing but electron's own modules.
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  };
  // UNTRUSTED surface: the Atlas view loads arbitrary https:// pages (browser_open,
  // preview:go, agent-driven navigation). It must NOT receive the preload — any page
  // holding `window.voxai` could call saveSettings({access:'full'}) and then
  // agentSend(), i.e. drive a shell-capable agent from a web page. No preload, no
  // node, sandboxed.
  const browserPrefs = {
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false,
    // Each session's browser keeps running while it sits under the chat: without this a game's
    // requestAnimationFrame loop never fires there and the agent sees a frozen page.
    backgroundThrottling: false,
  };
  rootV = new View();
  chatV = new WebContentsView({ webPreferences: chatPrefs });
  BROWSER_PREFS = browserPrefs;
  browserV = defaultBrowser = makeBrowserView();
  rootV.addChildView(chatV, 0);
  rootV.addChildView(browserV, 1);
  browserV._onTop = true;
  w.setContentView(rootV);
  // Split panes: more copies of this page, one session each, over the preview (which shuts).
  split = require('./split').createSplit({
    rootV, WebContentsView, prefs: chatPrefs, guard: guardTrustedView, first: () => chatWebContents(),
    pageFile: path.join(__dirname, '..', 'renderer', 'index.html'),
    onChange: () => { if (split.active() && atlasOpen) atlasClose(); else layoutAtlas(); saveSplitLayout(); },
  });

  chatV.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  guardTrustedView(chatV.webContents);
  // Renderer-side steer trace: '[steer] ...' console lines are copied into steer.log next to
  // main's hops, so a click that never reaches agent:steer shows up instead of looking like silence.
  chatV.webContents.on('console-message', (e, _lvl, msg) => {
    const m = String((e && e.message) || msg || '');
    if (m.startsWith('[steer]')) steerTrace('renderer', m.slice(8));
  });

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
  w.on('minimize', relayout);        // parks the browser on show, so it keeps drawing
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
  return { open: atlasOpen, chatFraction: atlasFrac, url, tabs: previewTabs() };
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

/*
 * One browser per session. There was one for the whole app, and two agents testing their own
 * games side by side kept navigating it -- each saw the other's page (the user stopped both).
 * The preview shows the browser of the session in the main pane (shownSid); the others keep
 * their pages, laid out under the window's own page where they still draw, so the agent's
 * browser tools and screenshots work on them unseen. browserV is always the one on show.
 */
let BROWSER_PREFS = null;
let overlayHeld = false, dragHeld = false;   // a dialog is open in the page / a session is being dragged
let defaultBrowser = null;              // before any session has its own
const sessionBrowsers = new Map();      // session id -> WebContentsView
let shownSid = '';
function makeBrowserView() {
  const v = new WebContentsView({ webPreferences: BROWSER_PREFS });
  const wc = v.webContents;
  wc.loadURL('about:blank');
  try {
    // Keep the preview's address bar and tabs honest as the page navigates (links, redirects).
    const told = () => { if (v === browserV) broadcastPreviewState(); else broadcastTabs(); };
    wc.on('did-navigate', told);
    wc.on('did-navigate', () => wakeParked(v));
    wc.on('did-navigate-in-page', told);
    wc.on('page-title-updated', () => broadcastTabs());
    // The preview sits inside the app's own chrome, so its scrollbars have to look like the
    // app's. Injected CSS dies with the document, so this runs for every navigation.
    wc.on('dom-ready', () => { try { wc.insertCSS(PREVIEW_SCROLLBAR_CSS); } catch {} });
    // A link meant for a new tab opens here, in the same browser. A sign-in window (a
    // window.open with a size: "Sign in with GitHub" and the like) opens as a real window
    // over the app, so the page that opened it gets its answer.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^https?:\/\//i.test(String(url || '')) && url !== 'about:blank') return { action: 'deny' };
      if (disposition !== 'new-window') { try { wc.loadURL(url); } catch {} return { action: 'deny' }; }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win(), width: 520, height: 720, autoHideMenuBar: true, backgroundColor: '#ffffff',
          icon: path.join(__dirname, '..', '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
        },
      };
    });
    wc.on('did-create-window', (child) => {
      try { child.setMenuBarVisibility(false); } catch {}
      // The pop-up's own links stay in the pop-up; it does not spawn more windows.
      try { child.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(String(url || ''))) { try { child.webContents.loadURL(url); } catch {} } return { action: 'deny' }; }); } catch {}
    });
  } catch {}
  v.setVisible(false);
  return v;
}
/** The session's own browser, made the first time it needs one. */
function browserFor(sid) {
  if (!sid || !rootV) return browserV;
  let v = sessionBrowsers.get(sid);
  if (!v) {
    v = makeBrowserView();
    v._onTop = null;            // parked (below) until it is the one on show
    v._sid = sid;
    sessionBrowsers.set(sid, v);
    stackBrowser(v, false);
    // The session on show got its browser only now, mid-run: the preview has to switch to it.
    // It stayed on the empty default one, and opening the preview showed a blank page while its
    // tab strip listed the agent's page. Found in a live test.
    if (sid === shownSid) showBrowserOf(sid);
  }
  return v;
}
const hasPage = (v) => { try { const u = v.webContents.getURL(); return !!u && u !== 'about:blank'; } catch { return false; } };
/**
 * Where a browser not on show waits: a window of its own, off every screen. Under the chat it
 * would be covered, and Chromium neither calls a covered page visible nor draws it more than
 * about once a second -- a game the agent is testing there never gets requestAnimationFrame
 * and looks frozen. Off screen it is drawn for real, and screenshots of it still work. One
 * window each, so no browser covers another. A parked view is never hidden: once a view in an
 * off-screen window is hidden it does not draw again when shown, so it is shown before it goes
 * in and a fresh window is made each time it is parked.
 */
// Far off every screen, but not at -32000: that is where Windows puts a minimized window, and
// Chromium then calls the page hidden again.
const PARK_AT = -20000;
let parkSize = { width: 720, height: 900 };
let lastLayout = null;   // the window's content size when last not minimised
function parkWindow(v) {
  if (v._park && !v._park.isDestroyed()) return v._park;
  const { BaseWindow } = require('electron');
  const p = new BaseWindow({ x: PARK_AT, y: PARK_AT, width: parkSize.width, height: parkSize.height, show: false, frame: false, skipTaskbar: true, focusable: false, resizable: false });
  try { p.showInactive(); } catch {}
  v._park = p;
  return p;
}
/** Above the window's page (on show in the preview) or parked off screen (drawing, unseen). */
function stackBrowser(v, onTop) {
  if (!rootV || !v || v._onTop === onTop) return;
  try {
    if (v._onTop === false && v._park && !v._park.isDestroyed()) { v._park.contentView.removeChildView(v); unpark(v); }
    else if (v._onTop === true) rootV.removeChildView(v);
    if (onTop) rootV.addChildView(v, Math.max(0, (rootV.children || []).indexOf(chatV)) + 1);
    else {
      v.setVisible(true);
      v.setBounds({ x: 0, y: 0, width: parkSize.width, height: parkSize.height });
      parkWindow(v).contentView.addChildView(v);
    }
    v._onTop = onTop;
    if (!onTop) wakeParked(v);
  } catch { /* stays where it was */ }
}
/**
 * A page loaded into a parked browser starts out hidden (nothing tells it the off-screen window
 * is showing it), and a hidden page draws no frames. Taking the view out of its window and
 * putting it back tells it.
 */
function wakeParked(v) {
  if (!v || v._onTop !== false || !v._park || v._park.isDestroyed()) return;
  try { const c = v._park.contentView; c.removeChildView(v); c.addChildView(v); } catch {}
}
/** Is a run going in this session (or, for the browser no session owns, in any)? */
function browserInUse(v) {
  const sid = v && v._sid;
  for (const k of controllers.keys()) if (!sid || k.startsWith(sid + ':')) return true;
  return false;
}
/**
 * A parked browser with nobody using it sleeps: hidden and throttled, so a game left running in
 * it stops using the CPU once the run is over. It wakes when a run starts in its session or
 * when it is shown. A view hidden in an off-screen window does not draw again on its own when
 * shown, so waking puts it back in its window as well (wakeParked).
 */
function napBrowser(v, asleep) {
  if (!v || v._asleep === asleep) return;
  v._asleep = asleep;
  try { v.webContents.setBackgroundThrottling(asleep); } catch {}
  try { v.setVisible(!asleep); } catch {}
  if (!asleep) wakeParked(v);
}
/** Runs started or ended: wake the browsers that are needed, put the rest to sleep. */
function napBrowsers() { layoutAtlas(); }
function unpark(v) { try { if (v && v._park && !v._park.isDestroyed()) v._park.destroy(); } catch {} if (v) v._park = null; }
/** The main pane now shows this session: the preview shows its browser. */
function showBrowserOf(sid) {
  shownSid = String(sid || '');
  const v = (shownSid && sessionBrowsers.get(shownSid)) || defaultBrowser;
  if (!v || v === browserV) return;
  browserV = v;
  layoutAtlas();
  broadcastPreviewState();
}
/** A deleted session's browser goes with it. */
function dropBrowser(sid) {
  const v = sessionBrowsers.get(sid);
  if (!v) return;
  sessionBrowsers.delete(sid);
  if (browserV === v) browserV = defaultBrowser;
  try { if (v._onTop) rootV.removeChildView(v); } catch {}
  unpark(v);
  try { v.webContents.close(); } catch {}
  layoutAtlas(); broadcastPreviewState();
}
/** The preview's tabs: every session browser with a page in it, and which one is on show. */
function previewTabs() {
  const out = [];
  for (const [sid, v] of sessionBrowsers) {
    if (!hasPage(v)) continue;
    let url = '', title = '';
    try { url = v.webContents.getURL(); title = v.webContents.getTitle(); } catch {}
    const sess = live.get(sid);
    out.push({ sid, url, title, session: (sess && sess.title) || '', on: v === browserV });
  }
  return out;
}
function broadcastTabs() { const c = chatWebContents(); if (c) { try { c.send('preview:state', previewState()); } catch {} } }

function layoutAtlas() {
  try {
    if (!rootV || !chatV) return;
    let cb = null, minimised = false;
    try { const w0 = win(); minimised = !!(w0 && w0.isMinimized()); cb = w0 && w0.getContentBounds(); } catch { cb = null; }
    // Minimised, the window draws nothing, so the browser on show would stop too: the 30B's
    // Breakout run got "window is minimised" for every screenshot. Every browser is parked
    // instead, which keeps drawing, at the size it last had (a minimised window's own is tiny).
    if (minimised) cb = lastLayout;
    else if (cb && cb.width > 50 && cb.height > 50) lastLayout = { width: cb.width, height: cb.height };
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

    const sideBySide = !!(split && split.active());
    const showing = !minimised && !sideBySide && atlasOpen && previewRect && previewRect.width > 20 && previewRect.height > 20;
    // Out of sight but drawing: a hidden view captures blank, and one under the window's page
    // is barely drawn. So the browsers not on show are parked in windows off screen, the size
    // a preview would be (see parkWindow).
    const under = { x: 0, y: 0, width: Math.max(320, Math.round(W / 2)), height: H };
    parkSize = { width: under.width, height: under.height };
    for (const v of [defaultBrowser, ...sessionBrowsers.values()]) {
      if (!v) continue;
      if (v === browserV && showing) {
        const r = previewRect;
        stackBrowser(v, true);
        napBrowser(v, false);
        if (overlayHeld) { v.setVisible(false); continue; }
        v.setBounds({ x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.max(20, Math.round(r.width)), height: Math.max(20, Math.round(r.height)) });
        try { if (typeof v.setBorderRadius === 'function') v.setBorderRadius(6); } catch {}
        v.setVisible(true);
      } else {
        stackBrowser(v, false);
        try { const p = v._park; if (p && !p.isDestroyed()) { const b = p.getContentBounds(); if (b.width !== under.width || b.height !== under.height) p.setContentBounds({ x: PARK_AT, y: PARK_AT, width: under.width, height: under.height }); } } catch {}
        v.setBounds(under);
        napBrowser(v, !browserInUse(v));
      }
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

function atlasOpenUrl(url, workdir, sid) {
  const ok = previewableUrl(url, workdir || getSettings(false).workingDir);
  const v = sid ? browserFor(sid) : browserV;
  if (ok) { try { v.webContents.loadURL(ok); } catch {} }
  // Side by side, or a session not in the main pane: the page loads where the agent's browser
  // tools can use it (and shows as a tab), but nothing opens over what you are looking at.
  if ((split && split.active()) || v !== browserV) { layoutAtlas(); broadcastTabs(); return; }
  atlasOpen = true;
  atlasFrac = 0.5;
  layoutAtlas();
  broadcastPreviewState();
}

function atlasClose() {
  atlasOpen = false;
  atlasFrac = 0.5;                 // forget a dragged split, or the next open is lopsided
  // A session's page stays (its agent may still be using it; it is a tab); the loose one clears.
  if (browserV === defaultBrowser) browserV.webContents.loadURL('about:blank');
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

  // Terminal: a real pty per panel. Nothing typed here reaches the agent loop: keystrokes go
  // straight to the pty and its output comes back, so a password stays between you and the shell.
  ipcMain.handle('term:open', (_e, arg) => {
    const a = arg || {};
    return terminals.open({ cwd: typeof a.cwd === 'string' && a.cwd ? a.cwd : undefined, cols: a.cols, rows: a.rows });
  });
  ipcMain.on('term:write', (_e, arg) => { if (arg && typeof arg.id === 'string') terminals.write(arg.id, String(arg.data == null ? '' : arg.data)); });
  ipcMain.on('term:resize', (_e, arg) => { if (arg && typeof arg.id === 'string') terminals.resize(arg.id, arg.cols, arg.rows); });
  ipcMain.on('term:close', (_e, arg) => { if (arg && typeof arg.id === 'string') terminals.close(arg.id); });
  // Review and ship (backend/review.js): the session folder's changes, hunk by hunk, then
  // commit, push, pull request and its checks. Every one is a button the user pressed.
  const review = require('../backend/review');
  const reviewDir = async (sessionId) => { const sess = await getLive(String(sessionId || '')); if (!sess || !sess.workdir) throw new Error('This session has no folder.'); return sess.workdir; };
  const reviewCall = (fn) => async (_e, a = {}) => { try { return await fn(await reviewDir(a.sessionId), a); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } };
  ipcMain.handle('review:status', reviewCall((cwd) => review.status(cwd)));
  ipcMain.handle('review:diff', reviewCall((cwd, a) => review.fileDiff(cwd, String(a.file || ''), { untracked: !!a.untracked })));
  ipcMain.handle('review:revertHunk', reviewCall((cwd, a) => review.revertHunk(cwd, String(a.file || ''), Number(a.index) || 0, String(a.header || ''))));
  ipcMain.handle('review:discard', reviewCall(async (cwd, a) => {
    const r = await review.discardFile(cwd, String(a.file || ''), String(a.kind || ''));
    // A file new since the last commit goes to the Recycle Bin, not away for good.
    if (r.ok && r.trash) { try { await shell.trashItem(r.trash); } catch (e) { return { ok: false, error: 'Could not move it to the Recycle Bin: ' + e.message }; } }
    return r;
  }));
  ipcMain.handle('review:commit', reviewCall((cwd, a) => review.commit(cwd, a.files, a.message)));
  ipcMain.handle('review:push', reviewCall((cwd) => review.push(cwd)));
  ipcMain.handle('review:pr', reviewCall((cwd, a) => review.createPr(cwd, a.title, a.body)));
  ipcMain.handle('review:checks', reviewCall((cwd) => review.prChecks(cwd)));
  ipcMain.handle('review:failedLog', reviewCall((cwd, a) => review.failedLog(cwd, a.link)));
  // A commit message for the picked files, written by a cheap model (or the session's own model on this PC).
  ipcMain.handle('review:message', reviewCall(async (cwd, a) => {
    const s = getSettings(false);
    const sess = await getLive(String(a.sessionId || ''));
    const model = localEngineMod.isLocalModel(sess && sess.model) ? sess.model : (s.autoCheckModel || 'deepseek/deepseek-v4.1-flash');
    if (!localEngineMod.isLocalModel(model) && !s.openrouterKey) return { ok: false, error: 'Add your OpenRouter key in Settings to have the message written.' };
    const diff = await review.diffForMessage(cwd, a.files);
    if (!diff.trim()) return { ok: false, error: 'There is nothing to describe in the picked files.' };
    const r = await chatOnce({ apiKey: s.openrouterKey, host: s.openrouterHost, model, maxTokens: 300, messages: [
      { role: 'system', content: 'You write git commit messages. Reply with the message only: a short imperative subject line (at most 72 characters), a blank line, then 1-4 short "- " lines on what changed and why. No code fences, no quotes.' },
      { role: 'user', content: diff },
    ] });
    const text = String((r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '').replace(/^```\w*\n?|```$/g, '').trim();
    return text ? { ok: true, message: text, model } : { ok: false, error: 'The model returned nothing.' };
  }));
  // The @ picker's list: the project's files and folders (git's list when it is a repository).
  ipcMain.handle('files:list', async (_e, workdir) => {
    try { return { ok: true, files: await require('../backend/mentions').projectFiles(String(workdir || '')) }; }
    catch (e) { return { ok: false, files: [], error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('term:list', () => ({ ok: true, terminals: terminals.list(), ...terminalAvail }));

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
  // Split panes (split.js). The window's own page lays them out; a pane can close itself.
  ipcMain.handle('split:add', (_e, a) => (split ? split.add(a && typeof a === 'object' ? a.sid : a, a && a.at) : { ok: false, error: 'not ready' }));
  ipcMain.handle('split:swap', (_e, { at, sid } = {}) => (split ? split.swap(at, sid) : { ok: false, error: 'not ready' }));
  ipcMain.on('split:hold', (e, on) => { if (split && e.sender === chatWebContents()) { dragHeld = !!on; split.hold(dragHeld || overlayHeld); } });
  // A dialog or menu is open in the window's page. The preview and the split panes are views laid
  // over the page, so they covered its dialogs ("New session" cut in half by the preview). They
  // step aside while it is open, and the page shows a snapshot of each in its place, under the
  // dialog's dimming, so nothing seems to vanish.
  ipcMain.handle('overlay:hold', async (e, on) => {
    if (e.sender !== chatWebContents()) return [];
    on = !!on;
    if (on === overlayHeld) return [];
    if (!on) { overlayHeld = false; if (split) split.hold(dragHeld); layoutAtlas(); return []; }
    const views = [];
    if (browserV && browserV._onTop && atlasOpen) { try { if (browserV.getVisible()) views.push({ view: browserV, rect: browserV.getBounds() }); } catch {} }
    if (split && split.active()) views.push(...split.shown());
    const shots = [];
    for (const { view, rect } of views) {
      try { const img = await view.webContents.capturePage(); shots.push({ rect, url: img.toDataURL() }); } catch {}
    }
    overlayHeld = true;
    if (split) split.hold(true);
    layoutAtlas();
    return shots;
  });
  ipcMain.on('split:main', (e, sid) => { if (split && e.sender === chatWebContents()) { split.setMain(sid); saveSplitLayout(); showBrowserOf(sid); } });
  // A tab in the preview: show that session's page (the main pane stays where it is).
  ipcMain.on('preview:tab', (e, sid) => {
    if (e.sender !== chatWebContents()) return;
    const v = sessionBrowsers.get(String(sid || ''));
    if (!v || v === browserV) return;
    browserV = v; atlasOpen = true; layoutAtlas(); broadcastPreviewState();
  });
  ipcMain.handle('split:remove', (e, sid) => !!(split && split.remove(sid || split.paneOf(e.sender))));
  ipcMain.handle('split:state', () => (split ? split.state() : { panes: [], max: 4 }));
  ipcMain.handle('split:focus', (_e, sid) => !!(split && split.focus(sid)));
  ipcMain.on('split:place', (e, rects) => { if (split && e.sender === chatWebContents()) split.place(rects); });
  ipcMain.on('preview:back', () => { try { browserV && browserV.webContents.goBack(); } catch {} });
  ipcMain.on('preview:forward', () => { try { browserV && browserV.webContents.goForward(); } catch {} });
  // Reload means the files as they are now, not the cached copy (the page is usually one being built).
  ipcMain.on('preview:reload', () => { try { browserV && browserV.webContents.reloadIgnoringCache(); } catch {} });
  // The address bar. A file in the project is judged against the session's folder,
  // like the preview's other ways in (see preview:open).
  ipcMain.on('preview:go', (_e, arg) => {
    try {
      const url = arg && typeof arg === 'object' ? arg.url : arg;
      const wd = (arg && typeof arg === 'object' && arg.workdir) || getSettings(false).workingDir;
      if (split && split.active()) return;
      atlasOpen = true; setTimeout(broadcastPreviewState, 0);
      const ok = previewableUrl(url, wd);
      if (ok) browserV.webContents.loadURL(ok);
      layoutAtlas();
    } catch {}
  });

  // settings
  ipcMain.handle('settings:get', () => getSettings(true));
  ipcMain.handle('settings:save', (_e, patch) => saveSettings(patch));
  ipcMain.handle('settings:keychain', () => ({ available: safeStorage.isEncryptionAvailable() }));

  // sessions
  // `waiting`: it needs you -- a question or approval open in a run, or a question the
  // app closed on (store's `asking`) with no run going. The sidebar marks these.
  ipcMain.handle('sessions:list', async () => {
    const items = await store.listSessions(userData());
    const running = new Set([...controllers.keys()].map((k) => k.split(':')[0]));
    const open = waitingIds();
    // The title in memory: a run names its session from the first message before the
    // file is next saved, and the row said "New session" meanwhile.
    return items.map((s) => ({ ...s, ...(live.get(s.id) && live.get(s.id).title ? { title: live.get(s.id).title } : {}), waiting: open.has(s.id) || (!!s.asking && !running.has(s.id)) }));
  });
  // Settings > Skills: every skill the agent can load, and your own folder for more.
  ipcMain.handle('skills:list', async (_e, arg) => {
    const workdir = arg && typeof arg === 'object' ? arg.workdir : '';
    const found = await require('../backend/tools/skills').findSkills({ workdir: workdir || '', userData: userData() });
    return { mine: path.join(userData(), 'skills'), skills: found.map((s) => ({ name: s.name, description: s.description, source: s.source, root: s.root })) };
  });
  ipcMain.handle('skills:openFolder', async () => {
    const d = path.join(userData(), 'skills');
    try { await fs.promises.mkdir(d, { recursive: true }); } catch {}
    const err = await require('electron').shell.openPath(d);
    return { ok: !err, path: d, error: err || '' };
  });
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
    return { id: sess.id, title: sess.title, workdir: sess.workdir, model: sess.model, coderModel: sess.coderModel || '', messages: sess.messages, todos: sess.todos, usage: sess.usage, stats: sess.stats, stops: sess.stops || [], runLog: sess.runLog || [], context, pendingAsk: ask };
  });
  // To the Recycle Bin, not erased: one misclick on Delete lost a whole conversation
  // for good. If the bin refuses, nothing is deleted and the user is told why.
  /**
   * Delete a session: to the Recycle Bin, with everything that was only its own. A run still going is
   * stopped first -- it used to carry on (spending, even driving the desktop) and, when it ended, save
   * the session back into the list. Its sub-agents' sessions and its snapshots go too. If the Recycle
   * Bin refuses the session, nothing is deleted and nothing is stopped.
   */
  async function deleteSessionFully(id) {
    id = path.basename(String(id || ''));
    if (!id) return { ok: false, error: 'no session' };
    const trash = (p) => require('electron').shell.trashItem(p);
    store.markDeleted(id);   // no save can put it back from here on
    try {
      await trash(path.join(store.sessionsDir(userData()), `${id}.jsonl`));
    } catch (e) {
      store.loadSession(userData(), id).catch(() => {});   // still there: its saves count again
      return { ok: false, error: 'Could not move it to the Recycle Bin: ' + String((e && e.message) || e) };
    }
    // Stop what it is doing: its runs, and any question or approval waiting on the user.
    let stopped = 0;
    for (const [k, c] of controllers) if (k.startsWith(id + ':')) { try { c.abort(); stopped++; } catch {} }
    for (const [k, p] of pendingInputs) if (p.sessionId === id) { pendingInputs.delete(k); try { p.resolve({ answer: null, cancelled: true }); } catch {} }
    for (const [k, p] of pendingPerms) if (p.msg && p.msg.sessionId === id) { pendingPerms.delete(k); try { p.resolve(false, false); } catch {} }
    live.delete(id);
    if (split) split.remove(id);
    dropBrowser(id);
    try { require('../backend/cu/desktop').forget(id); } catch { /* no desktop control here */ }
    // Its sub-agents' sessions go with it: they stayed behind, unlisted, for good.
    let subs = 0;
    try {
      for (const s of (await store.listSessions(userData(), 10000, { subs: true })).filter((x) => x.parentId === id)) {
        try { await trash(path.join(store.sessionsDir(userData()), `${path.basename(s.id)}.jsonl`)); subs++; } catch {}
      }
    } catch {}
    // And its snapshots, as one item.
    let snapshots = 0;
    try {
      const g = await require('../backend/tools/snapshot').gatherSessionSnapshots(userData(), id);
      if (g) { await trash(g.folder); snapshots = g.snapshots; }
    } catch { /* they stay in the snapshots folder */ }
    return { ok: true, id, stopped, subs, snapshots };
  }
  ipcMain.handle('sessions:delete', (_e, id) => deleteSessionFully(id));
  // Several at once (a selection, or every session of a project): one after another, each reported.
  ipcMain.handle('sessions:deleteMany', async (_e, ids) => {
    const results = [];
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 5000)) results.push(await deleteSessionFully(id));
    return { ok: results.every((r) => r.ok), results };
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
  // Team: who writes the code under this session's model ('' = off).
  ipcMain.handle('sessions:setCoder', async (_e, { id, model }) => {
    if (!id) return false;
    const sess = await getLive(id);
    sess.coderModel = String(model || '').trim();
    await store.saveSession(userData(), sess);
    return true;
  });
  // You agreed that this project may be shared with a data-sharing model's maker (or took it back).
  /**
   * A model OpenRouter will not run for this app ("only available on agentic harnesses", a 403 that
   * is not about the key): remembered for a week, so the picker can say so before it is picked
   * again. A later run on it that works clears it.
   */
  function noteRefusedModel(model, why) {
    const id = String(model || '').trim();
    if (!id) return;
    const raw = readSettingsFile();
    const all = raw.refusedModels && typeof raw.refusedModels === 'object' ? raw.refusedModels : {};
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    for (const k of Object.keys(all)) if (!(Date.parse(all[k] && all[k].at) > weekAgo)) delete all[k];
    if (why) all[id] = { why: String(why).slice(0, 300), at: new Date().toISOString() };
    else if (all[id]) delete all[id];
    else return;
    raw.refusedModels = all;
    writeSettingsFile(raw);
  }
  ipcMain.handle('datashare:set', (_e, { workdir, ok }) => {
    const key = team.projectKey(workdir);
    if (!key) return false;
    const raw = readSettingsFile();
    raw.dataShareOk = raw.dataShareOk && typeof raw.dataShareOk === 'object' ? raw.dataShareOk : {};
    if (ok) raw.dataShareOk[key] = { at: new Date().toISOString() }; else delete raw.dataShareOk[key];
    writeSettingsFile(raw);
    return true;
  });
  ipcMain.handle('sessions:setModel', async (_e, { id, model }) => {
    const m = String(model || '').trim();
    if (!id || !m) return false;
    const sess = await getLive(id);
    sess.model = m;
    await store.saveSession(userData(), sess);
    return true;
  });
  ipcMain.handle('sessions:reveal', async (_e, id) => {
    // No session yet: the folder a new one starts in (the header shows it).
    if (!id) { const d = String(getSettings(false).workingDir || '').trim(); if (d && fs.existsSync(d)) { try { await shell.openPath(d); } catch {} } return true; }
    const sess = await getLive(id);
    if (sess && sess.workdir) {
      const { shell } = require('electron');
      const path = require('path');
      const d = sess.workdir.trim();
      try { shell.openPath(d); } catch {}
    }
    return true;
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
  // A message the user sends while a run is going. It goes to the live run and is read at
  // the start of its next turn; `live` is false when nothing is running, which is the
  // renderer's signal to queue it instead (there would be nothing to read it).
  ipcMain.handle('agent:steer', (_e, { sessionId, text } = {}) => {
    const live = [...controllers.keys()].some((k) => k.startsWith(sessionId + ':'));
    steerTrace(sessionId, live ? 'ipc-arrived-controller-exists' : 'ipc-arrived-NO-CONTROLLER', JSON.stringify(String(text || '').slice(0, 60)));
    if (!live) return { ok: false, live: false };
    const pushed = steerPush(sessionId, text);
    steerTrace(sessionId, 'inbox-push', 'ok=' + pushed);
    return { ok: pushed, live: true };
  });
  // Changed your mind: take the steered message back before the run reads it.
  ipcMain.handle('agent:steer-recall', (_e, { sessionId, text } = {}) => steerRecall(sessionId, text));
  // Sessions with a run going, the ones waiting on the user first.
  ipcMain.handle('agent:live-sessions', () => {
    const waiting = waitingIds();
    const ids = [...new Set([...controllers.keys()].map((k) => k.split(':')[0]))];
    return ids.sort((a, b) => (waiting.has(b) ? 1 : 0) - (waiting.has(a) ? 1 : 0));
  });

  /**
   * Ask the user about an action, in the session's approval box: for a run, and for a
   * worker started from the Sub-agents panel. It waits until answered, or until the run
   * with this runKey ends (its finally answers no).
   */
  function askPermissionFor(sessionId, runKey) {
    return ({ kind, target, note, alwaysKey, alwaysLabel, noAlways }) => new Promise((resolve) => {
      // whole-session allow (prototype "allow for the whole session"): remember
      // this exact target so future identical requests auto-allow without prompting.
      // An action on a website is remembered by its site (alwaysKey), not word for word.
      const key = kind + '\u0000' + String(alwaysKey || target || '');
      // 'always': allowed without a prompt (truthy, like yes). The desktop's mouse check needs to know
      // nobody just moved the mouse to answer one.
      if (!noAlways && sessionAlwaysAllow.get(sessionId) && sessionAlwaysAllow.get(sessionId).has(key)) { resolve('always'); return; }
      const permId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      // It waits until you answer or the run ends (see launchRun's finally). It used to
      // count as "no" after two minutes, so stepping away turned approvals into refusals.
      const msg = { permId, sessionId, kind, target, canAlways: !noAlways, note: note || '', ...(alwaysLabel ? { alwaysLabel } : {}) };
      pendingPerms.set(permId, {
        msg, runKey,
        resolve: (v, always) => {
          if (v && always && !noAlways) {
            if (!sessionAlwaysAllow.has(sessionId)) sessionAlwaysAllow.set(sessionId, new Set());
            sessionAlwaysAllow.get(sessionId).add(key);
          }
          resolve(v);
        },
      });
      const c0 = allRenderers(); c0 && c0.send('agent:permission', msg);
    });
  }

  async function launchRun({ sessionId, text, attachments, resume = false, goalContinue = false, readOnly = false }) {
    const s = getSettings(false);
    // A steered message goes to THIS run -- the live one -- not to the queue behind it.
    const steerTake = steerFor(sessionId);
    if (!s.openrouterKey) throw new Error('No OpenRouter API key — open Settings and paste one.');
    const sess = await getLive(sessionId);
    if (!resume && (!text || !text.trim())) throw new Error('empty prompt');
    // Refuse up front rather than letting a tool-less model answer in prose forever.
    await assertModelUsable(sess.model || s.openrouterModel, fetchModels, {
      images: (attachments || []).filter((a) => a && (a.type === 'image_url' || a.dataUrl)).length,
    });
    // A model that shares what it is sent with its maker runs only in a project you agreed to share.
    // The consent is in the app, not hidden in a model's name (backend/team.js).
    for (const m of [sess.model || s.openrouterModel, sess.coderModel || '']) {
      const sh = team.sharesData(m, modelCapCache.byId.get(m));
      if (sh && !s.dataShareOk[team.projectKey(sess.workdir)]) {
        throw new Error(`DATA_SHARE_CONSENT: ${m} shares your coding data with ${sh.who}. Choose it again in the model picker and agree for this project, or pick another model.`);
      }
    }
    // A model on this PC (as the model or as Team's coder) is loaded before the run starts. One at a time.
    const locals = [sess.model || s.openrouterModel, sess.coderModel || ''].filter(localEngineMod.isLocalModel);
    if (locals.length && !LOCAL_SUPPORTED) throw new Error('Models on this PC run on Windows only for now. Pick a cloud model for this session.');
    if (locals.length && new Set(locals).size > 1) throw new Error('Only one model on this PC can run at a time, and this session uses two. Pick a cloud model for one of them.');
    if (locals.length && !(s.localModelsDirs || []).length) throw new Error('Choose the folder your local models are in: Settings → Local models.');
    // The run is registered BEFORE a local model loads, which can take minutes (install, tune).
    // Registered after, Stop found nothing to stop, and the queue's watchdog took the session
    // for idle and started a second run -- and a second engine load beside the first.
    const runKey = `${sessionId}:${Date.now()}`;
    const runT0 = Date.now();   // for "Worked for ..." when it ends
    const ctl = new AbortController();
    controllers.set(runKey, ctl);
    let localCtx = 0;
    if (locals.length) {
      const c1 = allRenderers(); c1 && c1.send('agent:event', { sessionId, runKey: 'local', event: { type: 'warning', code: 'local-loading', message: 'Loading ' + localEngineMod.labelOf(localEngineMod.fileOf(locals[0])) + ' on this PC…' } });
      try { localCtx = Number((await localEngine.start(s.localModelsDirs, localEngineMod.fileOf(locals[0]))).ctx) || 0; }
      catch (e) { controllers.delete(runKey); throw e; }
      if (ctl.signal.aborted) { controllers.delete(runKey); throw new Error('Stopped while the model on this PC was loading.'); }
    }
    if (!resume && sess.title === 'New session') sess.title = text.slice(0, 60);
    // @-mentioned files and folders go with the message (backend/mentions.js), read now.
    let mentionText = '';
    if (!resume && text && text.includes('@')) {
      try {
        const mm = await require('../backend/mentions').expandMentions(text, sess.workdir);
        mentionText = mm.text;
        if (mm.used.length) { const c2 = allRenderers(); c2 && c2.send('agent:event', { sessionId, runKey, event: { type: 'mentioned', files: mm.used } }); }
      } catch { /* sent without them; the agent can still read the paths */ }
    }
    // A message from you while a goal is paused picks it back up ("continue" works).
    if (!goalContinue && sess.goal && sess.goal.status === 'active') { sess.goal.paused = false; sess.goal.pausedReason = ''; sess.goal.idle = 0; }
    let runEnd = 'error', runTools = 0, runCost = 0, runTokens = 0, runParts = null;   // for the goal loop (goalStep) and the run's summary

    napBrowsers();   // this session's browser wakes for the run
    const w = win();

    const askPermission = askPermissionFor(sessionId, runKey);

    const askUserInput = ({ question, options, kind, questions }) => new Promise((resolve) => {
      const inputId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      // No time limit: it used to count as skipped after ten minutes, and the run went
      // ahead deciding for you. It waits until you answer or the run ends.
      const event = { type: 'user_input', inputId, question, options: options || [], kind: kind || 'ask', ...(Array.isArray(questions) ? { questions } : {}) };
      pendingInputs.set(inputId, { sessionId, runKey, event, resolve });
      // Through the agent-event channel the thread already draws. It was sent on its own
      // 'agent:user_input' channel that nothing listened to, so the agent's questions
      // never appeared and the run sat waiting ten minutes for an answer. Found in a live run.
      const c1 = allRenderers();
      c1 && c1.send('agent:event', { sessionId, runKey, event });
    });

    (async () => {
      try {
        for await (const ev of runAgent({
          session: sess, userText: text, resume,
          attachments: attachments || [],
          apiKey: s.openrouterKey, host: s.openrouterHost, model: sess.model || s.openrouterModel,
          // /review: looking only. Ask-first, and no tool that writes (a shell command that is only
          // looking, like git diff, still runs without asking).
          reasoningEffort: s.reasoningEffort, access: readOnly ? 'ask' : s.access, planMode: s.planMode,
          ...(readOnly ? { allowTools: require('../backend/tools/spawn').READ_TOOLS.concat(['shell']) } : {}),
          signal: ctl.signal, askPermission, userInput: askUserInput,
          checkSteer: steerTake,
          mentions: mentionText,
          // A command that has to ask something (an ssh login, npm login) runs in the terminal
          // panel, where the user answers it; what they type never reaches the model. Approval is
          // the terminal_run tool's own (the same gate as shell), so it is asked once, not twice.
          interactive: terminalAvail.ok ? async (command, o) => {
            return interactive.runInteractive(command, {
              cwd: (o && o.cwd) || sess.workdir,
              timeoutSecs: o && o.timeoutSecs,
              terminals,
              send: (ch, data) => allRenderers().send(ch, data),
            });
          } : null,
          compactThreshold: s.compactThreshold, toolResultMaxChars: s.toolResultMaxChars, hardFraction: s.hardFraction,
          // A model on this PC has the context it was loaded with, not a cloud model's 200k.
          contextLimit: localCtx && localEngineMod.isLocalModel(sess.model || s.openrouterModel) ? localCtx : s.contextLimit,
          localContext: localCtx,
          budgetUsd: Number(s.runBudgetUsd) > 0 ? Number(s.runBudgetUsd) : 1,
          // $/token from the catalogue, used only as a fallback when the provider
          // does not report real cost — otherwise the cap cannot be enforced.
          priceIn: modelPrice(sess.model || s.openrouterModel).in,
          priceOut: modelPrice(sess.model || s.openrouterModel).out,
          // Whether screenshots are handed over as images or described as unseen.
          modelVision: modelVision(sess.model || s.openrouterModel),
          maxTokens: modelMaxTokens(sess.model || s.openrouterModel), maxTokensOf: (id) => modelMaxTokens(id),
          visionOf: (id) => modelVision(id),   // a worker on another model (Team's coder) is asked about its own eyes
          visionHelper: s.visionHelperModel || '',
          // Auto's yes/no on each action, on a cheap model (Settings > Permissions).
          checkModel: s.autoCheckModel || '',
          checkReasoningSpec: s.autoCheckModel ? modelReasoning(s.autoCheckModel) : undefined,
          cacheTtl: s.claudeCacheHour ? '1h' : '',
          // Team: the cheap model that writes the code under this one (backend/team.js).
          coderModel: sess.coderModel && sess.coderModel !== (sess.model || s.openrouterModel) ? sess.coderModel : '',
          coderVision: sess.coderModel ? modelVision(sess.coderModel) : null,
          // Which thinking levels this model takes, so the chip's choice means something.
          reasoningSpec: modelReasoning(sess.model || s.openrouterModel),
          subagentModel: s.subagentModel, subagentMaxTurns: s.subagentMaxTurns, subagentTimeoutMs: s.subagentTimeoutMs, mcpServers: readSettingsFile().mcpServers || {},
          webSearch: { enabled: s.webSearchEnabled, engine: s.webSearchEngine, maxResults: s.webSearchMaxResults },
          onLiveEvent: (le) => { const c = allRenderers(); c && c.send('agent:event', { sessionId, runKey, event: le }); },
          userData: userData(), live,
          onOpenUrl: (url) => { try { atlasOpenUrl(url, sess.workdir, sessionId); } catch {} },
          // Only while the preview is open: closed, it is hidden and blank, and a
          // screenshot of it waited ten seconds for a frame that never came.
          // The session's own browser: once it has a page, or while it is the preview on show.
          onAttachAtlas: () => { try { const bv = browserFor(sessionId); return bv && (hasPage(bv) || (bv === browserV && atlasOpen) || (split && split.active())) ? bv.webContents : null; } catch { return null; } },
        })) {
          const c = allRenderers(); c && c.send('agent:event', { sessionId, runKey, event: ev });
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
            if (ev.type === 'error' && /^OpenRouter refused this request/.test(String(ev.message || ''))) { try { noteRefusedModel(sess.model || s.openrouterModel, ev.message); } catch {} }
          }
          if (ev.type === 'done') { try { const m = sess.model || s.openrouterModel; if (s.refusedModels && s.refusedModels[m]) noteRefusedModel(m, ''); } catch {} }
          if (ev.type === 'tool_end' || ev.type === 'tool_start' || ev.type === 'permission') {
            scheduleSessionSave(sessionId);
          }
          if (ev.type === 'desktop_control') armDesktopEsc(runKey, ctl, ev.phase);
          if (ev.type === 'tool_start') runTools++;
          if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled' || ev.type === 'limit_reached' || ev.type === 'budget_reached') { runEnd = ev.type; break; }
        }
      } catch (err) {
        const said = team.explainProviderError(err.message, sess.model || s.openrouterModel) || (sess.coderModel && team.explainProviderError(err.message, sess.coderModel)) || err.message;
        const c1 = allRenderers(); c1 && c1.send('agent:event', { sessionId, runKey, event: { type: 'error', message: said } });
      } finally {
        controllers.delete(runKey);
        // A run that ended (Stop, an error) takes its open questions and approvals with
        // it: nothing is left waiting for an answer that can no longer go anywhere.
        for (const [k, p] of pendingInputs) if (p.runKey === runKey) { pendingInputs.delete(k); try { p.resolve({ answer: null, cancelled: true }); } catch {} }
        for (const [k, p] of pendingPerms) if (p.runKey === runKey) { pendingPerms.delete(k); try { p.resolve(false, false); } catch {} }
        // A steer the run never got to read must not linger for the NEXT run: the renderer still
        // has that message in its queue and sends it at the drain, so leaving it here would
        // deliver it twice.
        if (![...controllers.keys()].some((k) => k.startsWith(sessionId + ':'))) {
          const left = steerClear(sessionId);
          if (left.length) steerTrace(sessionId, 'run-ended-unread', JSON.stringify(left));
        }
        napBrowsers();   // and sleeps again once nothing is using it
        disarmDesktopEsc(runKey);   // Esc goes back to the apps
        // flush any pending debounced save now (dupe with the final save below is fine)
        if (saveTimers.has(sessionId)) { clearTimeout(saveTimers.get(sessionId)); saveTimers.delete(sessionId); }
        try { if (sess && sess.messages && sess.messages.length) await store.saveSession(userData(), sess); } catch {}
        // Fix 1: persist the run usage ledger (input/output/cache/cost) before saving,
        // then clear the run-scoped accumulator so the next run starts fresh.
        try {
          const ru = sess._runUsage;
          runCost = (ru && Number(ru.cost)) || 0;
          runTokens = ru ? (Number(ru.input) || 0) + (Number(ru.output) || 0) : 0;
          // Where it went: fresh input, cached, cache writes, output, and the extras (costs.js).
          if (ru && runCost > 0) { const mid = sess.model || getSettings(false).openrouterModel; runParts = require('../backend/costs').breakdown(ru, require('../backend/costs').pricesOf(modelCapCache.byId.get(mid), mid, { hour: getSettings(false).claudeCacheHour })); }
          if (ru && (ru.input || ru.output || ru.cost)) store.recordUsage(sess, ru);
          delete sess._runUsage;
        } catch { /* ledger write is best-effort */ }
        // How long it took and what it cost, under the answer -- a finished build said nothing of
        // either (the user: "no end recorded time lapsed"). Kept, so a reopened session shows it too.
        if (!store.isDeleted(sess)) {
          const took = { at: sess.messages.length, ms: Date.now() - runT0, cost: runCost, tokens: runTokens, end: runEnd, ...(runParts ? { parts: runParts.parts, extras: runParts.extras } : {}) };
          const log = sess.runLog || (sess.runLog = []);
          log.push(took); if (log.length > 300) log.splice(0, log.length - 300);
          const c3 = allRenderers(); c3 && c3.send('agent:event', { sessionId, runKey, event: { type: 'run_summary', ...took } });
        }
        try { await store.saveSession(userData(), sess); } catch { /* disk full? surface next time */ }
        if (sess.goal && sess.goal.status === 'active' && !store.isDeleted(sess)) goalStep(sessionId, runEnd, { tools: runTools, cost: runCost }).catch(() => {});
      }
    })();
    return { runKey };
  }

  // ---- /goal: keep going until a separate check says the goal is met (goal.js) ----
  const goalChecks = new Map();   // sessionId -> AbortController of a check in progress
  const goalView = (g) => (g ? { condition: g.condition, status: g.status, paused: !!g.paused, pausedReason: g.pausedReason || '',
    runs: g.runs, spent: g.spent, last: g.checks && g.checks.length ? g.checks[g.checks.length - 1] : null } : null);
  const goalEvent = (sessionId, g, event) => {
    const c = allRenderers();
    c && c.send('agent:event', { sessionId, runKey: 'goal', event: { type: 'goal', ...event, goal: goalView(g) } });
  };
  async function goalStep(sessionId, end, run) {
    const sess = live.get(sessionId);
    const g = sess && sess.goal;
    if (!g || g.status !== 'active' || store.isDeleted(sess)) return;
    const s = getSettings(false);
    let step = goalLib.afterRun(g, end, run, Number(s.goalBudgetUsd) > 0 ? Number(s.goalBudgetUsd) : 5);
    let reason = '';
    if (step.next === 'check') {
      goalEvent(sessionId, g, { phase: 'checking' });
      const ctl = new AbortController();
      goalChecks.set(sessionId, ctl);
      const check = await goalLib.evaluateGoal({ apiKey: s.openrouterKey, host: s.openrouterHost,
        model: sess.model || s.openrouterModel, goal: g, messages: sess.messages, signal: ctl.signal });
      goalChecks.delete(sessionId);
      if (check.cost > 0) { try { store.recordUsage(sess, { cost: check.cost }); } catch {} }
      reason = check.reason;
      step = (g.paused || sess.goal !== g || g.status !== 'active') ? { next: 'pause', reason: 'you stopped it' } : goalLib.applyCheck(g, check);
    }
    if (step.next === 'pause') { g.paused = true; g.pausedReason = step.reason; goalEvent(sessionId, g, { phase: 'paused', reason: step.reason }); }
    else if (step.next === 'end') goalEvent(sessionId, g, { phase: g.status, reason });
    try { await store.saveSession(userData(), sess); } catch {}
    if (step.next !== 'continue') return;
    // You sent something meanwhile (a queued message): that run is the next step; its end is checked in turn.
    if ([...controllers.keys()].some((k) => k.startsWith(sessionId + ':'))) return;
    try {
      const r = await launchRun({ sessionId, text: step.message, goalContinue: true });
      goalEvent(sessionId, g, { phase: 'continue', reason, limit: !reason, runKey: r.runKey });
    } catch (e) {
      g.paused = true; g.pausedReason = String((e && e.message) || e).slice(0, 200);
      goalEvent(sessionId, g, { phase: 'paused', reason: g.pausedReason });
      try { await store.saveSession(userData(), sess); } catch {}
    }
  }
  ipcMain.handle('goal:get', async (_e, sessionId) => goalView((await getLive(sessionId)).goal));
  ipcMain.handle('goal:set', async (_e, { sessionId, condition }) => {
    const sess = await getLive(sessionId);
    const c = String(condition || '').trim();
    if (!c) throw new Error('A goal needs a condition, like /goal all tests pass');
    sess.goal = goalLib.newGoal(c, sess.messages.length);
    await store.saveSession(userData(), sess);
    return goalView(sess.goal);
  });
  ipcMain.handle('goal:clear', async (_e, sessionId) => {
    const sess = await getLive(sessionId);
    const ctl = goalChecks.get(sessionId); if (ctl) { try { ctl.abort(); } catch {} }
    if (sess.goal && sess.goal.status === 'active') sess.goal.status = 'cleared';
    await store.saveSession(userData(), sess);
    return goalView(sess.goal);
  });
  // ---- slash commands: /review /init /rewind /loop (backend/commands.js) ----
  const runningFor = (sessionId) => [...controllers.keys()].some((k) => k.startsWith(sessionId + ':'));
  const loops = new Map();   // sessionId -> { task, ms, runs, timer, nextAt, fails }
  const loopView = (l) => (l ? { task: l.task, ms: l.ms, every: commands.every(l.ms), runs: l.runs, nextAt: l.nextAt } : null);
  const loopEvent = (sessionId, event) => {
    const c = allRenderers();
    c && c.send('agent:event', { sessionId, runKey: 'loop', event: { type: 'loop', ...event, loop: loopView(loops.get(sessionId)) } });
  };
  function stopLoop(sessionId, why) {
    const l = loops.get(sessionId);
    if (!l) return false;
    clearInterval(l.timer);
    loops.delete(sessionId);
    loopEvent(sessionId, { phase: 'stopped', reason: why || '' });
    return true;
  }
  async function loopTick(sessionId) {
    const l = loops.get(sessionId);
    if (!l) return;
    l.nextAt = Date.now() + l.ms;
    const sess = live.get(sessionId);
    if (!sess || store.isDeleted(sess)) { stopLoop(sessionId, 'the session is gone'); return; }
    // Busy (a run going, or a question waiting on you): this turn is skipped, not queued.
    const waiting = [...pendingPerms.values()].some((x) => x.msg && x.msg.sessionId === sessionId)
      || [...pendingInputs.values()].some((x) => x.sessionId === sessionId);
    if (runningFor(sessionId) || waiting) { loopEvent(sessionId, { phase: 'skipped', reason: 'still busy from before' }); return; }
    l.runs += 1;
    try {
      const r = await launchRun({ sessionId, text: commands.loopPrompt(l.task, l.runs) });
      l.fails = 0;
      loopEvent(sessionId, { phase: 'run', runKey: r.runKey });
    } catch (e) {
      l.fails = (l.fails || 0) + 1;
      if (l.fails >= 3) stopLoop(sessionId, 'three runs in a row could not start: ' + String((e && e.message) || e).slice(0, 160));
      else loopEvent(sessionId, { phase: 'skipped', reason: String((e && e.message) || e).slice(0, 160) });
    }
  }
  ipcMain.handle('agent:command', async (_e, { sessionId, text }) => {
    const cmd = commands.parseCommand(text);
    if (!cmd) throw new Error('not a command');
    const sess = await getLive(sessionId);
    if (cmd.name === 'loop') {
      const lp = commands.parseLoop(cmd.rest);
      if (lp.stop) return { kind: 'loop', stopped: stopLoop(sessionId, 'you stopped it') };
      if (!lp.task) throw new Error('Say what to repeat, for example: /loop 10m check the build still passes');
      if (runningFor(sessionId)) throw new Error('A run is going: stop it or wait for it, then start the loop.');
      stopLoop(sessionId, 'replaced by a new loop');
      const l = { task: lp.task.slice(0, 1000), ms: lp.ms, runs: 1, fails: 0, nextAt: Date.now() + lp.ms, timer: null };
      loops.set(sessionId, l);
      l.timer = setInterval(() => { loopTick(sessionId).catch(() => {}); }, lp.ms);
      const r = await launchRun({ sessionId, text: commands.loopPrompt(l.task, 1) });
      loopEvent(sessionId, { phase: 'set' });
      return { kind: 'run', runKey: r.runKey, loop: loopView(l) };
    }
    if (runningFor(sessionId)) throw new Error('A run is going: stop it or wait for it first.');
    if (cmd.name === 'rewind') {
      const trash = (f) => require('electron').shell.trashItem(f);
      const r = await checkpoints.rewind(userData(), sessionId, trash);
      if (r.ok && (r.restored.length || r.removed.length)) {
        // The agent must know its last changes are gone, or it builds on files that are not there.
        sess.messages.push({ role: 'user', content: '[VOX REWIND] The user rewound the file changes of your last run. '
          + (r.restored.length ? 'Put back as they were before it: ' + r.restored.join(', ') + '. ' : '')
          + (r.removed.length ? 'Removed (they did not exist before it): ' + r.removed.join(', ') + '. ' : '')
          + 'Anything a shell command changed was not undone.' });
        try { await store.saveSession(userData(), sess); } catch {}
      }
      return { kind: 'rewind', ...r };
    }
    const r = await launchRun(cmd.name === 'review'
      ? { sessionId, text: commands.reviewPrompt(cmd.rest), readOnly: true }
      : { sessionId, text: commands.initPrompt() });
    return { kind: 'run', runKey: r.runKey };
  });
  ipcMain.handle('loop:get', async (_e, sessionId) => loopView(loops.get(sessionId)));
  ipcMain.handle('loop:stop', async (_e, sessionId) => stopLoop(sessionId, 'you stopped it'));

  // Stop: the run ends, and the goal waits for you instead of starting the next one.
  ipcMain.handle('goal:pause', async (_e, sessionId) => {
    const sess = live.get(sessionId);
    const g = sess && sess.goal;
    const ctl = goalChecks.get(sessionId); if (ctl) { try { ctl.abort(); } catch {} }
    if (g && g.status === 'active' && !g.paused) { g.paused = true; g.pausedReason = 'you stopped it'; goalEvent(sessionId, g, { phase: 'paused', reason: g.pausedReason }); }
    return goalView(g);
  });

  ipcMain.handle('agent:cancel', (_e, runKey) => {
    const ctl = controllers.get(runKey);
    // Abort only. The run's own finally removes it once it has really ended; removed here, the
    // session read as idle while the stopped run was still writing its last messages, and a
    // new run could start on the same session underneath it.
    if (ctl) { ctl.abort(); return true; }
    return false;
  });
  ipcMain.handle('agent:permission', (_e, { permId, allowed, always }) => {
    const p = pendingPerms.get(permId);
    if (p) { pendingPerms.delete(permId); p.resolve(!!allowed, !!always); allRenderers().send('agent:perm-done', { permId, allowed: !!allowed }); return true; }
    return false;
  });
  // ask_user / ask_confirm round-trip (model pauses and asks the user)
  ipcMain.handle('agent:user-input-answer', (_e, { inputId, answer, cancelled }) => {
    const p = pendingInputs.get(inputId);
    // Skipping a question is not an answer of "": it says the user chose not to decide.
    if (p) { pendingInputs.delete(inputId); p.resolve(cancelled ? { answer: null, cancelled: true } : { answer: answer || '', cancelled: false }); allRenderers().send('agent:input-done', { inputId }); return true; }
    return false;
  });
  // manual compact (Compass-like button): force-compact the active session now
  ipcMain.handle('agent:compact', async (_e, { sessionId }) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    const sess = await getLive(sessionId);
    const comp = compactSession(sess, { force: true, systemPrompt: 'You are Vox, the coding agent.' });
    try { await store.saveSession(userData(), sess); } catch {}
    const c = allRenderers();
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
// Today's requests to free models (providers/openrouter.js counts them), kept across restarts.
const freeUse = require('../backend/providers/openrouter').freeUse;
{
  const file = () => path.join(userData(), 'free-usage.json');
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); if (j && j.day) { freeUse.day = String(j.day); freeUse.n = Number(j.n) || 0; } } catch {}
  freeUse.onChange = (v) => { try { fs.writeFileSync(file(), JSON.stringify(v)); } catch {} };
}
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
    // OpenRouter's free allowance: 50 requests a day, 1,000 once $10 of credit has been bought.
    const today = new Date().toISOString().slice(0, 10);
    out.free = { used: freeUse.day === today ? freeUse.n : 0,
      cap: acctTotal != null ? (acctTotal >= 10 ? 1000 : 50) : (key.is_free_tier ? 50 : null) };
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

// Every key on the account and what each has spent (management key; read-only). Spending that
// VoxAI's own numbers did not account for came from another key on the same account, and
// nothing showed which one. OpenRouter lists names and masked labels, never the keys themselves.
// ---- models on this PC (local-engine.js) ----
ipcMain.handle('local:state', () => ({ ...localEngine.state(), supported: LOCAL_SUPPORTED }));
ipcMain.handle('local:install', () => (LOCAL_SUPPORTED ? localEngine.install() : false));
ipcMain.handle('local:devices', () => localEngine.devices());
ipcMain.handle('local:models', () => {
  const dirs = localModelDirs();
  return { dirs, engineDir: localEngine.engineDir(), models: localEngine.models(dirs).map((m) => ({ id: m.id, file: m.file, folder: m.folder, name: m.name, bytes: m.bytes, sidecar: !!m.sidecar })) };
});
ipcMain.handle('local:start', async (_e, file) => {
  const dirs = localModelDirs();
  if (!LOCAL_SUPPORTED) return { ok: false, error: 'Models on this PC run on Windows only for now.' };
  if (!dirs.length) return { ok: false, error: 'Add the folder your models are in first.' };
  try { return { ok: true, state: await localEngine.start(dirs, String(file || '')) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('local:stop', async () => { await localEngine.stop(); return localEngine.state(); });
ipcMain.handle('local:pickDir', async () => {
  const r = await require('electron').dialog.showOpenDialog(win(), { title: 'Folder with your .gguf models', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dirs = localModelDirs();
  if (!dirs.some((d) => d.toLowerCase() === r.filePaths[0].toLowerCase())) saveSettings({ localModelsDirs: [...dirs, r.filePaths[0]] });
  modelCapCache.at = 0;   // the picker should see the new folder's models
  return r.filePaths[0];
});
// Out of the list (the files stay where they are). The first folder also holds the engine.
ipcMain.handle('local:removeDir', (_e, dir) => {
  saveSettings({ localModelsDirs: localModelDirs().filter((d) => d !== dir) });
  modelCapCache.at = 0;
  return localModelDirs();
});

ipcMain.handle('openrouter:keys', async () => {
  const auth = orAuth();
  if (!auth || !auth.mgmt) return { ok: false, error: 'no-management-key' };
  try {
    const r = await fetch(auth.host + '/api/v1/keys', { headers: { Authorization: 'Bearer ' + auth.mgmt } });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const list = ((await r.json()) || {}).data || [];
    let mine = '';
    if (auth.key) {
      try { const k = await fetch(auth.host + '/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + auth.key } }); if (k.ok) mine = String((((await k.json()) || {}).data || {}).label || ''); } catch {}
    }
    const num = (x) => (x == null || x === '' ? null : Number(x));
    return { ok: true, keys: list.map((k) => ({
      name: String(k.name || ''), label: String(k.label || ''), disabled: !!k.disabled,
      usage: num(k.usage), daily: num(k.usage_daily), weekly: num(k.usage_weekly), monthly: num(k.usage_monthly),
      limit: num(k.limit), created: k.created_at || '', updated: k.updated_at || '',
      voxai: !!mine && String(k.label || '') === mine,
    })) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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
  // Does this model have a flex tier, and at what price? Read from its endpoint list (public,
  // no credits). Six hours is plenty: tiers come and go over weeks, not minutes.
  const flexSeen = new Map();
  ipcMain.handle('models:flex', async (_e, id) => {
    const base = String(id || '').replace(/:batch$/, '');
    if (!/^[\w.-]+\/[\w.:-]+$/.test(base) || /^local\//.test(base)) return { ok: true, flex: false };
    const hit = flexSeen.get(base);
    if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.r;
    try {
      const host = (getSettings(true).openrouterHost || 'https://openrouter.ai').replace(/\/+$/, '');
      const [a, b] = base.split('/');
      const res = await fetch(host + '/api/v1/models/' + encodeURIComponent(a) + '/' + encodeURIComponent(b) + '/endpoints');
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const eps = ((await res.json()).data || {}).endpoints || [];
      const cents = (v) => (v != null && v !== '' ? parseFloat(v) * 100 : null);
      // Flex endpoints are tagged "<provider>/flex" (openai/flex, google-vertex/global/flex).
      const flex = eps.filter((e) => /\/flex$/.test(String(e.tag || '')) && e.pricing && (e.supported_parameters || []).includes('tools'))
        .map((e) => ({ promptCents: cents(e.pricing.prompt), completionCents: cents(e.pricing.completion) }))
        .sort((x, y) => (x.promptCents + x.completionCents) - (y.promptCents + y.completionCents));
      const r = flex.length ? { ok: true, flex: true, ...flex[0] } : { ok: true, flex: false };
      flexSeen.set(base, { at: Date.now(), r });
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // Switch the cheaper tier on or off for one model. On only after a flex endpoint was seen.
  ipcMain.handle('models:setFlex', async (_e, { id, on, price }) => {
    const base = String(id || '').replace(/:batch$/, '');
    const f = { ...(getSettings(true).flexModels || {}) };
    if (on && price && price.flex) f[base] = { promptCents: price.promptCents, completionCents: price.completionCents, at: new Date().toISOString() };
    else delete f[base];
    return saveSettings({ flexModels: f });
  });
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
          // What reading from and writing to the prompt cache cost (the run's breakdown, the cache warning).
          cacheReadCents: m.pricing && m.pricing.input_cache_read != null ? parseFloat(m.pricing.input_cache_read) * 100 : null,
          cacheWriteCents: m.pricing && m.pricing.input_cache_write != null ? parseFloat(m.pricing.input_cache_write) * 100 : null,
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
          // Shares what it is sent with its maker (contributor tiers, free models): backend/team.js.
          sharesData: team.sharesData(m.id, m.pricing),
          coding: params.has('tools') && !!(m.architecture && Array.isArray(m.architecture.output_modalities)
            && m.architecture.output_modalities.length === 1 && m.architecture.output_modalities[0] === 'text'),
        };
      });
      // "(batch)" entries run only through OpenRouter's Batch API (answers within 24 hours), so
      // they are never offered; the model they belong to says it has a cheaper tier to look for.
      const batched = new Set(models.filter((m) => /:batch$/.test(m.id)).map((m) => m.id.replace(/:batch$/, '')));
      for (const m of models) { if (batched.has(m.id)) m.batch = true; if (/:batch$/.test(m.id)) m.coding = false; }
      // Every model stays known for capability checks (an older session may name one),
      // but the picker is offered only the ones that can code.
      // The models on this PC join the list, free.
      try { models.push(...localCatalog()); } catch { /* no folder, or unreadable */ }
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
    // A file: URL is opened by Windows with whatever handles it -- a .bat or .exe RUNS. Only a
    // page goes to the browser; any other file is shown in its folder instead.
    if (/^file:/i.test(u)) {
      try {
        const p = require('url').fileURLToPath(u);
        if (!/\.html?$/i.test(p)) { shell.showItemInFolder(p); return { ok: true, shown: true }; }
      } catch (e) { return { ok: false, error: 'refused: not a file path' }; }
    }
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
    if (split && split.active()) return { ok: false, error: 'the preview is off while sessions are side by side' };
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


  try {
    attention = require('./attention').createAttention({
      app, getWindow: () => win(), getSettings: () => getSettings(false), saveSetting: (k, v) => saveSettings({ [k]: v }), pendingPerms, pendingInputs, live,
      renderer: () => chatWebContents(),
      // Answered from a notification: the same as the box's Allow / Deny, and the box is told.
      answerPerm: (permId, allowed, always) => {
        const p = pendingPerms.get(permId);
        if (!p) return;
        pendingPerms.delete(permId); p.resolve(!!allowed, !!always);
        const c = allRenderers(); c && c.send('agent:perm-done', { permId, allowed: !!allowed });
      },
      // A question answered on the card (Yes / No, or one of up to three choices).
      answerInput: (inputId, answer, label) => {
        const p = pendingInputs.get(inputId);
        if (!p) return;
        pendingInputs.delete(inputId); p.resolve({ answer: answer || '', cancelled: false });
        allRenderers().send('agent:input-done', { inputId, via: 'card', label: String(label || '') });
      },
      openSession: (sid) => { const c = chatWebContents(); c && c.send('vox:open-session', sid); },
    });
    attention.registerProtocol();
  } catch (e) { try { console.error('attention failed:', e && e.message); } catch {} }
  try { createWindow(); } catch (e) { try { console.error('createWindow failed:', e && e.message); } catch {} }
  app.on('activate', () => { try { if (BrowserWindow.getAllWindows().length === 0) createWindow(); } catch (e) {} });

  // Updates from CodeRook's feed, signature-checked (see updater.js).
  let updater = null;
  try {
    updater = require('./updater').initUpdater({
      app,
      send: (st) => { const c = chatWebContents(); c && c.send('update:state', st); },
      // Kept in a file too: a Restart that did not install (0.2.74, once) left nothing to look at,
      // because the installed app's console goes nowhere. Cut back to its last half when it passes 200 KB.
      log: (m) => {
        try { console.log('[update] ' + m); } catch {}
        try {
          const f = path.join(userData(), 'update.log');
          fs.appendFileSync(f, `${new Date().toISOString()} ${m}\n`);
          if (fs.statSync(f).size > 200 * 1024) { const s = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, s.slice(s.length >> 1)); }
        } catch { /* logging must never break updating */ }
      },
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
app.on('will-quit', () => { try { require('../backend/tools/procs').stopAll(); } catch {} try { localEngine.stop(); } catch {} });
