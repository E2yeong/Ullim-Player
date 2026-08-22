const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFilesDialog: () => ipcRenderer.invoke('open-files-dialog'),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  sendPlayerState: (state) => ipcRenderer.send('player-state-update', state),
  onRemoteCommand: (callback) => ipcRenderer.on('remote-command', (_event, cmd) => callback(cmd)),
  onOverlayClosed: (callback) => ipcRenderer.on('overlay-closed', () => callback()),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, payload) => callback(payload))
});
