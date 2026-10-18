/**
 * Preload — VoxAI standalone backend edition.
 * Renderer gets ONLY this API (contextIsolation + sandbox).
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Only the app's own page gets the bridge. If anything ever loads another page into
// this view (a link once did), that page gets nothing: the bridge can run the agent,
// change settings and answer its own permission prompts.
const IS_APP_PAGE = (() => {
  try { return location.protocol === 'file:' && /\/renderer\/index\.html$/i.test(decodeURIComponent(location.pathname)); } catch { return false; }
})();

if (IS_APP_PAGE) contextBridge.exposeInMainWorld('voxai', {
  // Updates from CodeRook: where it stands, check now, restart into a downloaded one
  updates: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb) => {
      const fn = (_e, st) => cb(st);
      ipcRenderer.on('update:state', fn);
      return () => ipcRenderer.removeListener('update:state', fn);
    },
  },

  // Atlas: in-app resizable browser (chat | browser split)
  preview: {
    // workdir: the session's project, so a local file in it passes containment.
    open: (url, workdir) => ipcRenderer.send('preview:open', workdir ? { url, workdir } : url),
    close: () => ipcRenderer.send('preview:close'),
    setBounds: (frac) => ipcRenderer.send('preview:set-bounds', frac),
    viewport: (rect) => ipcRenderer.send('preview:viewport', rect),
    tab: (sid) => ipcRenderer.send('preview:tab', sid),
    state: () => ipcRenderer.invoke('preview:state'),
    back: () => ipcRenderer.send('preview:back'),
    forward: () => ipcRenderer.send('preview:forward'),
    reload: () => ipcRenderer.send('preview:reload'),
    go: (url, workdir) => ipcRenderer.send('preview:go', workdir ? { url, workdir } : url),
    openFile: (url, workdir, always) => ipcRenderer.invoke('preview:openFile', { url, workdir, always }),
    autoPref: (workdir) => ipcRenderer.invoke('preview:autoPref', { workdir }),
    onState: (cb) => {
      const fn = (_e, st) => cb(st);
      ipcRenderer.on('preview:state', fn);
      return () => ipcRenderer.removeListener('preview:state', fn);
    },
  },

  // In-UI window controls (frameless: the title bar drawn by the renderer owns
  // minimize / maximize / close — mirror of CodeBox's window API + state channel)
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    toggleFullScreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    getState: () => ipcRenderer.invoke('window:get-state'),
    onStateChange: (cb) => {
      const fn = (_e, state) => cb(state);
      ipcRenderer.on('window:state', fn);
      // push the current state immediately so the title-bar icon is right at boot
      ipcRenderer.invoke('window:get-state').then((s) => cb(s)).catch(() => {});
      return () => ipcRenderer.removeListener('window:state', fn);
    },
  },

  // settings (key never exposed in plaintext via `get`)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  keychain: () => ipcRenderer.invoke('settings:keychain'),

  // sessions (our own JSONL store)
  sessionsList: () => ipcRenderer.invoke('sessions:list'),
  sessionsCreate: (opts) => ipcRenderer.invoke('sessions:create', opts || {}),
  sessionsFork: (id, nth, text) => ipcRenderer.invoke('sessions:fork', { id, nth, text }),
  sessionsSetCoder: (id, model) => ipcRenderer.invoke('sessions:setCoder', { id, model }),
  dataShareSet: (workdir, ok) => ipcRenderer.invoke('datashare:set', { workdir, ok: !!ok }),
  sessionsOpen: (id) => ipcRenderer.invoke('sessions:open', id),
  sessionsDelete: (id) => ipcRenderer.invoke('sessions:delete', id),
  sessionsDeleteMany: (ids) => ipcRenderer.invoke('sessions:deleteMany', ids),
  sessionsRename: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  sessionsSetModel: (id, model) => ipcRenderer.invoke('sessions:setModel', { id, model }),
  sessionsReveal: (id) => ipcRenderer.invoke('sessions:reveal', id),

  // agent (own Node loop, streamed events)
  agentSend: (sessionId, text, attachments) => ipcRenderer.invoke('agent:send', { sessionId, text, attachments: attachments || [] }),
  agentCancel: (runKey) => ipcRenderer.invoke('agent:cancel', runKey),
  agentCommand: (sessionId, text) => ipcRenderer.invoke('agent:command', { sessionId, text }),
  onPermDone: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('agent:perm-done', fn); return () => ipcRenderer.removeListener('agent:perm-done', fn); },
  onInputDone: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('agent:input-done', fn); return () => ipcRenderer.removeListener('agent:input-done', fn); },
  // Sessions side by side (main/split.js).
  split: {
    add: (sid, at) => ipcRenderer.invoke('split:add', { sid, at }),
    swap: (at, sid) => ipcRenderer.invoke('split:swap', { at, sid }),
    hold: (on) => ipcRenderer.send('split:hold', !!on),
    // A dialog or menu is open: the preview and panes step aside; resolves to their snapshots.
    overlay: (on) => ipcRenderer.invoke('overlay:hold', !!on),
    setMain: (sid) => ipcRenderer.send('split:main', sid || ''),
    remove: (sid) => ipcRenderer.invoke('split:remove', sid),
    state: () => ipcRenderer.invoke('split:state'),
    focus: (sid) => ipcRenderer.invoke('split:focus', sid),
    setActive: (sid) => ipcRenderer.send('split:active', sid || ''),
    place: (rects) => ipcRenderer.send('split:place', rects),
    onState: (cb) => { const fn = (_e, st) => cb(st); ipcRenderer.on('split:state', fn); return () => ipcRenderer.removeListener('split:state', fn); },
    onFlash: (cb) => { const fn = () => cb(); ipcRenderer.on('split:flash', fn); return () => ipcRenderer.removeListener('split:flash', fn); },
  },
  onOpenSession: (cb) => { const fn = (_e, sid) => cb(sid); ipcRenderer.on('vox:open-session', fn); return () => ipcRenderer.removeListener('vox:open-session', fn); },
  loopGet: (sessionId) => ipcRenderer.invoke('loop:get', sessionId),
  loopStop: (sessionId) => ipcRenderer.invoke('loop:stop', sessionId),
  goalGet: (sessionId) => ipcRenderer.invoke('goal:get', sessionId),
  goalSet: (sessionId, condition) => ipcRenderer.invoke('goal:set', { sessionId, condition }),
  goalClear: (sessionId) => ipcRenderer.invoke('goal:clear', sessionId),
  goalPause: (sessionId) => ipcRenderer.invoke('goal:pause', sessionId),
  agentPermission: (permId, allowed, always) => ipcRenderer.invoke('agent:permission', { permId, allowed, always: !!always }),
  agentAnswer: (inputId, answer, cancelled) => ipcRenderer.invoke('agent:user-input-answer', { inputId, answer, cancelled: !!cancelled }),
  agentLive: (sessionId) => ipcRenderer.invoke('agent:live', sessionId),
  // Review and ship: the session folder's changes, hunk by hunk; commit, push, pull request, checks.
  review: {
    status: (sessionId) => ipcRenderer.invoke('review:status', { sessionId }),
    diff: (sessionId, file, untracked) => ipcRenderer.invoke('review:diff', { sessionId, file, untracked }),
    revertHunk: (sessionId, file, index, header) => ipcRenderer.invoke('review:revertHunk', { sessionId, file, index, header }),
    discard: (sessionId, file, kind) => ipcRenderer.invoke('review:discard', { sessionId, file, kind }),
    commit: (sessionId, files, message) => ipcRenderer.invoke('review:commit', { sessionId, files, message }),
    push: (sessionId) => ipcRenderer.invoke('review:push', { sessionId }),
    pr: (sessionId, title, body) => ipcRenderer.invoke('review:pr', { sessionId, title, body }),
    checks: (sessionId) => ipcRenderer.invoke('review:checks', { sessionId }),
    failedLog: (sessionId, link) => ipcRenderer.invoke('review:failedLog', { sessionId, link }),
    message: (sessionId, files) => ipcRenderer.invoke('review:message', { sessionId, files }),
  },
  // The project's files and folders, for the @ picker in the message box.
  filesList: (workdir) => ipcRenderer.invoke('files:list', workdir),
  // A message sent while a run is going: the live run reads it at its next turn. Returns
  // { ok, live }; live:false means nothing is running, so queue it instead.
  agentSteer: (sessionId, text) => ipcRenderer.invoke('agent:steer', { sessionId, text }),
  // Changed your mind: pull a steered message back before the run reads it.
  agentSteerRecall: (sessionId, text) => ipcRenderer.invoke('agent:steer-recall', { sessionId, text }),
  agentLiveSessions: () => ipcRenderer.invoke('agent:live-sessions'),
  agentResumeAsk: (sessionId, callId, answer, cancelled) => ipcRenderer.invoke('agent:resume-ask', { sessionId, callId, answer, cancelled: !!cancelled }),
  agentCompact: (sessionId) => ipcRenderer.invoke('agent:compact', { sessionId }),
  sessionsExport: (id) => ipcRenderer.invoke('sessions:export', { id }),
  sessionsSearch: (query) => ipcRenderer.invoke('sessions:search', query),
  sessionsShowExport: (id) => ipcRenderer.invoke('sessions:showExport', id),
  skillsList: (workdir) => ipcRenderer.invoke('skills:list', { workdir }),
  skillsOpenFolder: () => ipcRenderer.invoke('skills:openFolder'),
  skillsReveal: (workdir, root) => ipcRenderer.invoke('skills:reveal', { workdir, root }),
  skillsCreate: (name) => ipcRenderer.invoke('skills:create', { name }),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (name, cfg, was) => ipcRenderer.invoke('mcp:save', { name, cfg, was }),
  mcpRemove: (name) => ipcRenderer.invoke('mcp:remove', { name }),
  mcpSwitch: (name, on) => ipcRenderer.invoke('mcp:switch', { name, on: !!on }),
  mcpTest: (name, cfg, workdir) => ipcRenderer.invoke('mcp:test', { name, cfg, workdir }),
  mcpImport: () => ipcRenderer.invoke('mcp:import'),
  memoryList: (workdir) => ipcRenderer.invoke('memory:list', { workdir }),
  memoryDelete: (workdir, query) => ipcRenderer.invoke('memory:delete', { workdir, query }),
  memoryForget: (workdir, exact, index) => ipcRenderer.invoke('memory:delete', { workdir, exact, index }),
  memoryRestore: (workdir, fact, index) => ipcRenderer.invoke('memory:restore', { workdir, fact, index }),
  onAgentEvent: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('agent:event', fn);
    return () => ipcRenderer.removeListener('agent:event', fn);
  },
  onAgentPermission: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('agent:permission', fn);
    return () => ipcRenderer.removeListener('agent:permission', fn);
  },

  // direct OpenRouter chat + key test
  llmChat: (payload) => ipcRenderer.invoke('llm:chat', payload),
  llmTestKey: (key, model) => ipcRenderer.invoke('llm:testKey', { key, model }),

  // OpenRouter account usage / credits
  openrouterUsage: () => ipcRenderer.invoke('openrouter:usage'),
  openrouterKeys: () => ipcRenderer.invoke('openrouter:keys'),   // each key on the account and its spend (no secrets)
  // Models on this PC (main/local-engine.js).
  // Terminal panel: a real shell. `send` is keystrokes into the pty and `onData` is its
  // output -- neither is routed through the model, so a password typed at a sudo prompt
  // never leaves this channel.
  terminal: {
    open: (arg) => ipcRenderer.invoke('term:open', arg || {}),
    write: (id, data) => ipcRenderer.send('term:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    close: (id) => ipcRenderer.send('term:close', { id }),
    list: () => ipcRenderer.invoke('term:list'),
    // A command the agent is running in this panel (see main/interactive.js).
    ready: (m) => ipcRenderer.send('term:ready', m || {}),
    onRunPrepare: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('term:prepare', fn);
      return () => ipcRenderer.removeListener('term:prepare', fn);
    },
    onRunBind: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('term:bind', fn);
      return () => ipcRenderer.removeListener('term:bind', fn);
    },
    onRunDone: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('term:done', fn);
      return () => ipcRenderer.removeListener('term:done', fn);
    },
    onData: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('term:data', fn);
      return () => ipcRenderer.removeListener('term:data', fn);
    },
    onExit: (cb) => {
      const fn = (_e, m) => cb(m);
      ipcRenderer.on('term:exit', fn);
      return () => ipcRenderer.removeListener('term:exit', fn);
    },
  },
  local: {
    state: () => ipcRenderer.invoke('local:state'),
    install: () => ipcRenderer.invoke('local:install'),
    devices: () => ipcRenderer.invoke('local:devices'),
    models: () => ipcRenderer.invoke('local:models'),
    start: (file) => ipcRenderer.invoke('local:start', file),
    stop: () => ipcRenderer.invoke('local:stop'),
    pickDir: () => ipcRenderer.invoke('local:pickDir'),
    removeDir: (dir) => ipcRenderer.invoke('local:removeDir', dir),
    hfSearch: (q) => ipcRenderer.invoke('local:hfSearch', q),
    hfFiles: (repo) => ipcRenderer.invoke('local:hfFiles', repo),
    hfDownload: (repo, key) => ipcRenderer.invoke('local:hfDownload', { repo, key }),
    hfCancel: () => ipcRenderer.invoke('local:hfCancel'),
    hfState: () => ipcRenderer.invoke('local:hfState'),
    onHf: (cb) => { const fn = (_e, st) => cb(st); ipcRenderer.on('local:hf', fn); return () => ipcRenderer.removeListener('local:hf', fn); },
    onState: (cb) => { const fn = (_e, st) => cb(st); ipcRenderer.on('local:state', fn); return () => ipcRenderer.removeListener('local:state', fn); },
    onSlow: (cb) => { const fn = (_e, info) => cb(info); ipcRenderer.on('local:slow', fn); return () => ipcRenderer.removeListener('local:slow', fn); },
  },
  openrouterGenerations: (opts) => ipcRenderer.invoke('openrouter:generations', opts || {}),
  openrouterModels: () => ipcRenderer.invoke('openrouter:models'),
  modelFlex: (id) => ipcRenderer.invoke('models:flex', id),
  modelCostStats: () => ipcRenderer.invoke('models:costStats'),
  setModelFlex: (id, on, price) => ipcRenderer.invoke('models:setFlex', { id, on, price }),
  openrouterTestMgmt: (key) => ipcRenderer.invoke('openrouter:testMgmt', { key }),

  // misc
  workspaceContext: (workdir) => ipcRenderer.invoke('workspace:context', { workdir }),
  workspaceDiff: (workdir) => ipcRenderer.invoke('workspace:diff', { workdir }),
  openDir: () => ipcRenderer.invoke('dialog:openDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // A dropped or pasted file's path on disk, so it can go into the message.
  pathForFile: (file) => { try { return (webUtils && webUtils.getPathForFile(file)) || ''; } catch { return ''; } },
  onMenu: (cb) => {
    const fn = (_e, ch) => cb(ch);
    ipcRenderer.on('vox:menu', fn);
    return () => ipcRenderer.removeListener('vox:menu', fn);
  },
});
