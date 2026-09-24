/**
 * Preload — VoxAI standalone backend edition.
 * Renderer gets ONLY this API (contextIsolation + sandbox).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voxai', {
  // Sub-agents: manual spawn + list + change events
  subagents: {
    list: () => ipcRenderer.invoke('subagents:list'),
    spawn: (task, model, maxTurns, timeoutMs) => ipcRenderer.invoke('subagents:spawn', { task, model, maxTurns, timeoutMs }),
    onChanged: (cb) => {
      const fn = (_e, msg) => cb(msg);
      ipcRenderer.on('subagents:changed', fn);
      return () => ipcRenderer.removeListener('subagents:changed', fn);
    },
  },

  // Atlas: in-app resizable browser (chat | browser split)
  preview: {
    // workdir: the session's project, so a local file in it passes containment.
    open: (url, workdir) => ipcRenderer.send('preview:open', workdir ? { url, workdir } : url),
    close: () => ipcRenderer.send('preview:close'),
    setBounds: (frac) => ipcRenderer.send('preview:set-bounds', frac),
    viewport: (rect) => ipcRenderer.send('preview:viewport', rect),
    state: () => ipcRenderer.invoke('preview:state'),
    back: () => ipcRenderer.send('preview:back'),
    forward: () => ipcRenderer.send('preview:forward'),
    reload: () => ipcRenderer.send('preview:reload'),
    go: (url) => ipcRenderer.send('preview:go', url),
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
  sessionsOpen: (id) => ipcRenderer.invoke('sessions:open', id),
  sessionsDelete: (id) => ipcRenderer.invoke('sessions:delete', id),
  sessionsRename: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  sessionsSetModel: (id, model) => ipcRenderer.invoke('sessions:setModel', { id, model }),
  sessionsReveal: (id) => ipcRenderer.invoke('sessions:reveal', id),

  // agent (own Node loop, streamed events)
  agentSend: (sessionId, text, attachments) => ipcRenderer.invoke('agent:send', { sessionId, text, attachments: attachments || [] }),
  agentCancel: (runKey) => ipcRenderer.invoke('agent:cancel', runKey),
  agentPermission: (permId, allowed) => ipcRenderer.invoke('agent:permission', { permId, allowed }),
  agentAnswer: (inputId, answer) => ipcRenderer.invoke('agent:user-input-answer', { inputId, answer }),
  agentCompact: (sessionId) => ipcRenderer.invoke('agent:compact', { sessionId }),
  sessionsExport: (id) => ipcRenderer.invoke('sessions:export', { id }),
  memoryList: (workdir) => ipcRenderer.invoke('memory:list', { workdir }),
  memoryDelete: (workdir, query) => ipcRenderer.invoke('memory:delete', { workdir, query }),
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
  openrouterGenerations: (opts) => ipcRenderer.invoke('openrouter:generations', opts || {}),
  openrouterModels: () => ipcRenderer.invoke('openrouter:models'),
  openrouterTestMgmt: (key) => ipcRenderer.invoke('openrouter:testMgmt', { key }),

  // misc
  workspaceContext: (workdir) => ipcRenderer.invoke('workspace:context', { workdir }),
  workspaceDiff: (workdir) => ipcRenderer.invoke('workspace:diff', { workdir }),
  openDir: () => ipcRenderer.invoke('dialog:openDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onMenu: (cb) => {
    const fn = (_e, ch) => cb(ch);
    ipcRenderer.on('vox:menu', fn);
    return () => ipcRenderer.removeListener('vox:menu', fn);
  },
});
