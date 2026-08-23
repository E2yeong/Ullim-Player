// Ullim main process: creates and owns all BrowserWindows (main, overlay,
// splash), the system tray, the settings file, and the electron-updater
// wiring. Renderers never touch Node/Electron APIs directly (contextIsolation
// is on everywhere) — they go through the preload scripts' IPC calls below.
const { app, BrowserWindow, ipcMain, dialog, Menu, screen, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let overlayWindow = null;
let splashWindow = null;
let tray = null;

// Windows we create don't need Node integration, so they all share the same
// locked-down preferences; only `preload` differs per window.
const SECURE_WEB_PREFERENCES = { contextIsolation: true, nodeIntegration: false, sandbox: false };

// Files under build/ and assets/ (icons, the intro video) only exist next to
// the source at dev time. electron-builder does NOT bundle those folders into
// the packaged app by default — they have to be listed under extraResources
// in package.json and read back from process.resourcesPath at runtime, or
// the file silently doesn't exist once installed (this is exactly what broke
// the tray icon: it rendered blank because nativeImage got a path to a file
// that wasn't there in the packaged build).
function getPackagedAsset(filename, devSubdir = '') {
  return app.isPackaged
    ? path.join(process.resourcesPath, filename)
    : path.join(__dirname, '..', devSubdir, filename);
}

// ---------- Persisted player settings (merge-safe: renderer and main both write partial updates) ----------
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'player-settings.json');
}

// The app was renamed from "music-player-pro" to "ullim", which moves userData
// to a new folder. Bring over the old settings file once so nobody loses their
// playlist/EQ on the first launch after updating.
function migrateOldSettingsIfNeeded() {
  const newPath = getSettingsPath();
  if (fs.existsSync(newPath)) return;
  const oldPath = path.join(path.dirname(app.getPath('userData')), 'music-player-pro', 'player-settings.json');
  try {
    if (fs.existsSync(oldPath)) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.copyFileSync(oldPath, newPath);
    }
  } catch {
    // best-effort; a missing old file just means a fresh start
  }
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

function createWindow(startHidden) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#14141a',
    autoHideMenuBar: true,
    show: !startHidden,
    icon: getPackagedAsset('icon.ico', 'build'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), ...SECURE_WEB_PREFERENCES }
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
  // A dedicated, pre-rendered 32x32 PNG is used here instead of build/icon.ico:
  // extracting a frame from the multi-size .ico and resizing it at runtime
  // rendered as a blank/transparent icon in the Windows notification area.
  const iconPath = getPackagedAsset('tray-icon.png', 'build');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Ullim');

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

// ---------- Splash intro video ----------
function getIntroVideoPath() {
  return getPackagedAsset('Ullim_intro.mp4', 'assets');
}

function createSplashWindow(onDone) {
  const videoPath = getIntroVideoPath();
  if (!fs.existsSync(videoPath)) {
    onDone();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const w = Math.min(720, Math.round(display.workAreaSize.width * 0.6));
  const h = Math.round(w * 9 / 16);

  splashWindow = new BrowserWindow({
    width: w,
    height: h,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    icon: getPackagedAsset('icon.ico', 'build'),
    webPreferences: { preload: path.join(__dirname, 'preload-splash.js'), ...SECURE_WEB_PREFERENCES }
  });

  splashWindow.loadFile(path.join(__dirname, 'splash', 'index.html'));

  // safety net in case the video never fires 'ended' (bad codec, huge file, etc.)
  const fallbackTimer = setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  }, 20000);

  splashWindow.on('closed', () => {
    clearTimeout(fallbackTimer);
    splashWindow = null;
    onDone();
  });
}

const OVERLAY_MIN_WIDTH = 260;
const OVERLAY_MIN_HEIGHT = 110;
const OVERLAY_MAX_WIDTH = 640;
const OVERLAY_MAX_HEIGHT = 420;

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
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), ...SECURE_WEB_PREFERENCES }
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
  try {
    return fs.readFileSync(getPackagedAsset('update-token.txt'), 'utf8').trim() || null;
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
  migrateOldSettingsIfNeeded();
  createWindow(true);
  createTray();
  setupAutoUpdater();

  createSplashWindow(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

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

// ---------- IPC: main window ----------
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

// ---------- IPC: overlay window ----------
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

// Main renderer -> overlay (lightweight audio level for the pulsing dot)
ipcMain.on('player-level-update', (_event, level) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('level-update', level);
  }
});

// ---------- IPC: auto update ----------
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

// ---------- IPC: settings ----------
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

// ---------- IPC: splash window ----------
ipcMain.handle('get-intro-video-url', () => {
  const p = getIntroVideoPath();
  const encoded = encodeURI(p.replace(/\\/g, '/'));
  return 'file:///' + encoded.replace(/^\/+/, '');
});

ipcMain.on('splash-done', () => {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
});
