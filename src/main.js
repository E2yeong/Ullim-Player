// Ullim main process: creates and owns all BrowserWindows (main, overlay,
// splash), the system tray, the settings file, and the electron-updater
// wiring. Renderers never touch Node/Electron APIs directly (contextIsolation
// is on everywhere) — they go through the preload scripts' IPC calls below.
const { app, BrowserWindow, ipcMain, dialog, Menu, screen, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
  // Once the renderer has written the library/playlists shape, drop the
  // pre-migration keys so the shallow merge above stops carrying them.
  if (Array.isArray(merged.library)) {
    delete merged.tracks;
    delete merged.currentIndex;
  }
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(merged));
  } catch {
    // ignore write failures (e.g. disk full)
  }
}

// ---------- Lyrics (LRCLIB + local .lrc, see IPC handler 'fetch-lyrics' below) ----------
// Runs entirely in the main process: the renderer's CSP (default-src 'self')
// can't reach an external host directly, and this also keeps the on-disk
// lyrics cache and local-.lrc lookup (both filesystem access) off the
// sandboxed renderer. Electron 31 bundles Node 20, which has a global
// fetch() in the main process — no extra HTTP dependency needed.
function findLocalLrc(trackPath) {
  const lrcPath = trackPath.replace(/\.[^./\\]+$/, '.lrc');
  try {
    if (fs.existsSync(lrcPath)) return fs.readFileSync(lrcPath, 'utf8');
  } catch {
    // fall through to network lookup
  }
  return null;
}

function getLyricsCacheDir() {
  const dir = path.join(app.getPath('userData'), 'lyricsCache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  return dir;
}

// Keyed by a hash of the full track path rather than the filename, so two
// same-named files in different folders (or a file that gets renamed) don't
// collide or return a stale entry.
function lyricsCachePath(trackPath) {
  const key = crypto.createHash('sha1').update(trackPath).digest('hex');
  return path.join(getLyricsCacheDir(), key + '.json');
}

function readLyricsCache(trackPath) {
  try {
    return JSON.parse(fs.readFileSync(lyricsCachePath(trackPath), 'utf8'));
  } catch {
    return null;
  }
}

function writeLyricsCache(trackPath, data) {
  try {
    fs.writeFileSync(lyricsCachePath(trackPath), JSON.stringify(data));
  } catch {
    // best-effort; a cache miss just means we hit the network again next time
  }
}

// Best-effort split of a "Artist - Title.ext" filename, which is the most
// common convention for downloaded mp3s. Anything else is treated as a
// title-only query — LRCLIB's search endpoint still does reasonably well
// with just the title. Only used as a fallback now: real ID3 tags (read via
// music-metadata, see readTrackMetadata below) are preferred when present.
function parseArtistTitle(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const dashSplit = base.split(/\s-\s/);
  if (dashSplit.length >= 2) {
    return { artist: dashSplit[0].trim(), title: dashSplit.slice(1).join(' - ').trim() };
  }
  return { artist: '', title: base.trim() };
}

async function queryLrclib({ name, artist, title, durationSec }) {
  // Prefer real tags; fill any gap from the filename.
  if (!artist || !title) {
    const parsed = parseArtistTitle(name || '');
    artist = artist || parsed.artist;
    title = title || parsed.title;
  }
  const headers = { 'User-Agent': 'Ullim-Music-Player (personal desktop app, https://github.com/E2yeong/music-player-pro)' };

  // /api/get wants an exact title/artist/duration match and returns the
  // single best hit; try it first since it's the highest-confidence result.
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) params.set('artist_name', artist);
    if (durationSec) params.set('duration', String(Math.round(durationSec)));
    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data && (data.syncedLyrics || data.plainLyrics)) return data;
    }
  } catch {
    // fall through to fuzzy search
  }

  // Fuzzy fallback for filenames that don't line up exactly (missing
  // artist, slightly different title, wrong duration tag, etc.).
  try {
    const params = new URLSearchParams({ track_name: title });
    if (artist) params.set('artist_name', artist);
    const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, { headers });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        return list.find((x) => x.syncedLyrics) || list[0];
      }
    }
  } catch {
    // give up quietly; the renderer shows a "가사를 찾을 수 없어요" state either way
  }
  return null;
}

// ---------- Track metadata (ID3 / MP4 / Vorbis tags, see 'read-metadata' IPC below) ----------
// music-metadata is required lazily so a load failure only breaks this one
// feature instead of the whole app at startup. Text tags (title/artist/album)
// get cached by the renderer inside the settings file; cover art is NOT cached
// there (it would bloat the JSON badly) — it's re-read per track load.
let _mm = null;
function getMusicMetadata() {
  if (!_mm) _mm = require('music-metadata');
  return _mm;
}

// ---------- Dynamic color theme (§4.17) ----------
// Computed here rather than in the renderer: nativeImage.toBitmap() gives
// synchronous, reliable pixel access, whereas the renderer-side equivalent
// (draw to <canvas>, HTMLImageElement.decode()) turned out to hang/fail
// intermittently in this environment's rendering pipeline. Doing the average
// once, server-side, alongside the picture read is also just less work overall.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// Keeps hue but reins in saturation/lightness so a near-black or neon-bright
// cover doesn't produce an ambient wash that's invisible or garish against
// the dark Nocturne background.
function clampThemeColor(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h, Math.min(Math.max(s, 0.35), 0.62), Math.min(Math.max(l, 0.32), 0.5));
}

function extractThemeColor(img) {
  try {
    const { width, height } = img.getSize();
    if (!width || !height) return null;
    // downsample for a fast, cheap average — this doesn't need to be exact
    const small = Math.max(width, height) > 48
      ? (width >= height ? img.resize({ width: 48 }) : img.resize({ height: 48 }))
      : img;
    const bitmap = small.toBitmap(); // BGRA, per Electron's native pixel order
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      b += bitmap[i]; g += bitmap[i + 1]; r += bitmap[i + 2]; n++;
    }
    if (!n) return null;
    return clampThemeColor(r / n, g / n, b / n);
  } catch {
    return null;
  }
}

async function readTrackMetadata(trackPath, wantPicture) {
  const mm = getMusicMetadata();
  const { common, format } = await mm.parseFile(trackPath, {
    duration: true,
    skipCovers: !wantPicture
  });

  let picture = null;
  let themeColor = null;
  if (wantPicture && common.picture && common.picture[0]) {
    try {
      const pic = common.picture[0];
      let img = nativeImage.createFromBuffer(Buffer.from(pic.data));
      if (!img.isEmpty()) {
        themeColor = extractThemeColor(img);
        // cap the longest side so the data URL sent over IPC (and held in the
        // renderer) stays small — 600px is plenty for the stage
        const { width, height } = img.getSize();
        if (Math.max(width, height) > 600) {
          img = width >= height ? img.resize({ width: 600 }) : img.resize({ height: 600 });
        }
        picture = img.toDataURL();
      }
    } catch {
      picture = null; // unreadable embedded image — just skip the art
    }
  }

  return {
    title: common.title || null,
    artist: common.artist || (Array.isArray(common.artists) && common.artists[0]) || null,
    album: common.album || null,
    albumartist: common.albumartist || null,
    year: common.year || null,
    trackNo: (common.track && common.track.no) || null,
    themeColor,
    durationSec: format.duration || null,
    picture
  };
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
  // (and the overlay) can keep running in the background. This is the 설정
  // tab's "닫아도 트레이에 상주" toggle — off means close really quits, so the
  // settings file is read fresh on every close rather than cached at launch.
  mainWindow.on('close', (e) => {
    const trayOnClose = readSettingsFile().trayOnClose !== false;
    if (!app.isQuitting && trayOnClose) {
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
  // 설정 tab's "시작할 때 인트로 영상" toggle — skip the splash window entirely
  // when the user has turned it off.
  const introEnabled = readSettingsFile().introEnabled !== false;
  const videoPath = getIntroVideoPath();
  if (!introEnabled || !fs.existsSync(videoPath)) {
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

  // 설정 tab's "자동 업데이트 확인" toggle — a silent check on launch. Reuses
  // the same autoUpdater events the manual "업데이트 확인" button listens to,
  // so the renderer shows the result the same way either way.
  const autoUpdateCheck = readSettingsFile().autoUpdateCheck !== false;
  if (app.isPackaged && autoUpdateCheck) {
    autoUpdater.checkForUpdates().catch(() => {});
  }

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

  // Migrate the pre-playlists shape { tracks, currentIndex } -> { library,
  // playlists, activePlaylistId, currentPath }.
  if (Array.isArray(data.tracks) && !Array.isArray(data.library)) {
    data.library = data.tracks;
    data.playlists = Array.isArray(data.playlists) ? data.playlists : [];
    data.activePlaylistId = 'library';
    const cur = data.tracks[data.currentIndex];
    data.currentPath = cur && cur.path ? cur.path : null;
    delete data.tracks;
    delete data.currentIndex;
  }

  // Drop the dead pre-migration keys so they don't linger in the file after
  // writeSettingsFile()'s shallow merge.
  delete data.tracks;
  delete data.currentIndex;

  // Drop tracks whose file is gone, then prune those paths out of every
  // playlist and the "currently playing" pointer.
  if (Array.isArray(data.library)) {
    data.library = data.library.filter((t) => t && typeof t.path === 'string' && fs.existsSync(t.path));
    const alive = new Set(data.library.map((t) => t.path));
    if (Array.isArray(data.playlists)) {
      data.playlists = data.playlists
        .filter((p) => p && typeof p.id === 'string')
        .map((p) => ({ ...p, paths: Array.isArray(p.paths) ? p.paths.filter((pp) => alive.has(pp)) : [] }));
    }
    if (data.currentPath && !alive.has(data.currentPath)) data.currentPath = null;
  }
  return data;
});

ipcMain.on('save-settings', (_event, data) => {
  writeSettingsFile(data);
});

// ---------- IPC: lyrics ----------
// Lookup order: a local .lrc next to the media file (highest trust, works
// offline) -> the on-disk cache from a previous lookup -> LRCLIB over the
// network. `synced` tells the renderer whether `lrc` is real LRC (timestamped,
// line-by-line) text it should parse and scroll, vs. `plain` being untimed
// lyrics it can only show as a static block.
ipcMain.handle('fetch-lyrics', async (_event, payload) => {
  const { path: trackPath, name, artist, title, durationSec } = payload || {};
  if (!trackPath || !name) return { source: 'none', synced: false, lrc: null, plain: null };
  const haveTags = !!(artist && title);

  const local = findLocalLrc(trackPath);
  if (local) return { source: 'local', synced: true, lrc: local, plain: null };

  const cached = readLyricsCache(trackPath);
  if (cached) {
    if (cached.notFound) {
      // A previous "not found" that was only a filename guess is worth retrying
      // now that real ID3 tags are available; anything else stays cached.
      if (!(cached.by === 'filename' && haveTags)) {
        return { source: 'cache', synced: false, lrc: null, plain: null };
      }
    } else {
      return {
        source: 'cache',
        synced: !!cached.syncedLyrics,
        lrc: cached.syncedLyrics || null,
        plain: cached.plainLyrics || null
      };
    }
  }

  const result = await queryLrclib({ name, artist, title, durationSec });
  if (result && (result.syncedLyrics || result.plainLyrics)) {
    writeLyricsCache(trackPath, { syncedLyrics: result.syncedLyrics || null, plainLyrics: result.plainLyrics || null });
    return {
      source: 'lrclib',
      synced: !!result.syncedLyrics,
      lrc: result.syncedLyrics || null,
      plain: result.plainLyrics || null
    };
  }

  writeLyricsCache(trackPath, { notFound: true, by: haveTags ? 'id3' : 'filename' });
  return { source: 'none', synced: false, lrc: null, plain: null };
});

// ---------- IPC: track metadata ----------
// `wantPicture` is false for the bulk playlist fill (text tags only, fast) and
// true only for the track being loaded onto the stage (also returns resized
// cover art as a data URL).
ipcMain.handle('read-metadata', async (_event, payload) => {
  const { path: trackPath, wantPicture } = payload || {};
  if (!trackPath) return { error: 'no path' };
  try {
    return await readTrackMetadata(trackPath, !!wantPicture);
  } catch (err) {
    return { error: err && err.message ? err.message : 'metadata read failed' };
  }
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
