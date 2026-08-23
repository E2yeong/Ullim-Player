const { app, BrowserWindow, ipcMain, dialog, Menu, screen, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let overlayWindow = null;
let tray = null;

// ---------- Persisted player settings (merge-safe: renderer and main both write partial updates) ----------
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'player-settings.json');
}

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettingsFile(partial) {
  const merged = { ...readSettingsFile(), ...partial };
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(merged));
  } catch {
    // ignore write failures (e.g. disk full)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#14141a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window minimizes to the tray instead of quitting, so playback
  // (and the overlay) can keep running in the background.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    if (overlayWindow) {
      overlayWindow.close();
      overlayWindow = null;
    }
    mainWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Music Player Pro');

  const sendRemote = (cmd) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-command', cmd);
    }
  };

  const menu = Menu.buildFromTemplate([
    {
      label: '열기',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    { label: '재생 / 일시정지', click: () => sendRemote({ type: 'toggle-play' }) },
    { label: '다음 곡', click: () => sendRemote({ type: 'next' }) },
    { label: '이전 곡', click: () => sendRemote({ type: 'prev' }) },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
    }
  });
}

const OVERLAY_MIN_WIDTH = 260;
const OVERLAY_MIN_HEIGHT = 110;
const OVERLAY_MAX_WIDTH = 640;
const OVERLAY_MAX_HEIGHT = 320;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getOverlayBounds() {
  const display = screen.getPrimaryDisplay();
  const defaultW = 340;
  const defaultH = 128;
  const saved = readSettingsFile().overlayBounds;

  let bounds = {
    width: defaultW,
    height: defaultH,
    x: display.workArea.x + display.workArea.width - defaultW - 24,
    y: display.workArea.y + 24
  };

  if (saved && typeof saved.width === 'number' && typeof saved.height === 'number') {
    bounds = { ...bounds, ...saved };
  }

  bounds.width = clamp(bounds.width, OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH);
  bounds.height = clamp(bounds.height, OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT);
  // keep the window on-screen even if the saved position came from a monitor setup that's no longer connected
  const area = display.workArea;
  bounds.x = clamp(bounds.x, area.x, area.x + area.width - bounds.width);
  bounds.y = clamp(bounds.y, area.y, area.y + area.height - bounds.height);

  return bounds;
}

function createOverlayWindow() {
  const bounds = getOverlayBounds();

  overlayWindow = new BrowserWindow({
    ...bounds,
    minWidth: OVERLAY_MIN_WIDTH,
    minHeight: OVERLAY_MIN_HEIGHT,
    maxWidth: OVERLAY_MAX_WIDTH,
    maxHeight: OVERLAY_MAX_HEIGHT,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'index.html'));

  let boundsSaveTimer = null;
  const scheduleBoundsSave = () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        writeSettingsFile({ overlayBounds: overlayWindow.getBounds() });
      }
    }, 400);
  };
  overlayWindow.on('resize', scheduleBoundsSave);
  overlayWindow.on('move', scheduleBoundsSave);

  overlayWindow.on('closed', () => {
    clearTimeout(boundsSaveTimer);
    overlayWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('overlay-closed');
    }
  });

  return overlayWindow;
}

// ---------- Auto update ----------
function getUpdateToken() {
  const tokenPath = app.isPackaged
    ? path.join(process.resourcesPath, 'update-token.txt')
    : path.join(__dirname, '..', 'update-token.txt');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  const token = getUpdateToken();
  if (token) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'E2yeong',
      repo: 'music-player-pro',
      private: true,
      token
    });
  }

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ status: 'not-available' }));
  autoUpdater.on('error', (err) => sendUpdateStatus({ status: 'error', message: err ? err.message : '알 수 없는 오류' }));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', () => sendUpdateStatus({ status: 'downloaded' }));
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-files-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '음악/영상 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '오디오/비디오 파일', extensions: ['mp3', 'mp4', 'wav', 'ogg', 'm4a', 'flac', 'webm'] },
      { name: '모든 파일', extensions: ['*'] }
    ]
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('toggle-overlay', async () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
    return false;
  }
  createOverlayWindow();
  return true;
});

// Overlay -> main renderer (playback commands)
ipcMain.on('overlay-command', (_event, cmd) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-command', cmd);
  }
});

ipcMain.on('overlay-close', () => {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
});

// Main renderer -> overlay (playback state for display)
ipcMain.on('player-state-update', (_event, state) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('state-update', state);
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('check-for-update', async () => {
  if (!app.isPackaged) {
    return { status: 'dev-mode' };
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ status: 'error', message: err.message });
  }
  return { status: 'ok' };
});

ipcMain.handle('download-update', async () => {
  await autoUpdater.downloadUpdate();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('load-settings', () => {
  const data = readSettingsFile();
  if (Object.keys(data).length === 0) return null;
  if (Array.isArray(data.tracks)) {
    const original = data.tracks;
    const currentPath = original[data.currentIndex] ? original[data.currentIndex].path : null;
    const validTracks = original.filter((t) => t && typeof t.path === 'string' && fs.existsSync(t.path));
    data.tracks = validTracks;
    data.currentIndex = currentPath ? validTracks.findIndex((t) => t.path === currentPath) : -1;
  }
  return data;
});

ipcMain.on('save-settings', (_event, data) => {
  writeSettingsFile(data);
});
