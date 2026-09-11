// Exposes a narrow, explicit API (window.api) to the main window's renderer.
// contextIsolation means the renderer can't reach ipcRenderer/Node directly —
// everything it can do to the main process has to be listed here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFilesDialog: () => ipcRenderer.invoke('open-files-dialog'),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  sendPlayerState: (state) => ipcRenderer.send('player-state-update', state),
  sendPlayerLevel: (level) => ipcRenderer.send('player-level-update', level),
  onRemoteCommand: (callback) => ipcRenderer.on('remote-command', (_event, cmd) => callback(cmd)),
  onOverlayClosed: (callback) => ipcRenderer.on('overlay-closed', () => callback()),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, payload) => callback(payload)),

  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (data) => ipcRenderer.send('save-settings', data),

  fetchLyrics: (payload) => ipcRenderer.invoke('fetch-lyrics', payload),
  readMetadata: (payload) => ipcRenderer.invoke('read-metadata', payload)
});
