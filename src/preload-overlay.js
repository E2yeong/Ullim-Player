const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  sendCommand: (cmd) => ipcRenderer.send('overlay-command', cmd),
  onState: (callback) => ipcRenderer.on('state-update', (_event, state) => callback(state)),
  onLevel: (callback) => ipcRenderer.on('level-update', (_event, level) => callback(level)),
  close: () => ipcRenderer.send('overlay-close')
});
