// The corner card's only bridge: say what was clicked, and hear when to fade (main/attention.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notice', {
  act: (a) => ipcRenderer.send('notice:act', String(a || '')),
  onBye: (cb) => ipcRenderer.on('notice:bye', () => cb()),
});
