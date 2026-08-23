const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashApi', {
  getVideoUrl: () => ipcRenderer.invoke('get-intro-video-url'),
  done: () => ipcRenderer.send('splash-done')
});
