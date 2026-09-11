// Main window renderer: playback, playlist, the 8-band EQ/reverb graph, the
// waveform visualizer, settings persistence, and the auto-update UI. Talks to
// the overlay window and the main process only through window.api (see
// preload.js) — never directly, since contextIsolation is on.
//
// Layout ("정석안" — see PROJECT_SPEC.md §4.12): a left icon rail switches
// between two destinations, 홈 (재생목록 + 스테이지 + EQ, all on one screen)
// and 설정. Everything playback-related lives together on 홈 at a relaxed
// density, matching the UI mockup this was built from — it is deliberately
// NOT split into separate list/now-playing/EQ tabs.
(() => {
  'use strict';

  // ---------- State ----------
  // Library + playlists model:
  //  - library  : every imported track object { path, name, durationSec, meta? }
  //  - playlists : user lists [{ id, name, paths: [libraryPath, ...] }]
  //  - activePlaylistId : 'library' or a playlist id — the list shown AND the
  //    one next/prev traverse
  //  - tracks   : DERIVED — the resolved active list (rebuildActiveList()).
  //    Kept as a real array so the rest of the player code can keep indexing it.
  //  - currentPath : stable identity of the loaded track (survives switching
  //    playlists); currentIndex is its position within `tracks`, recomputed.
  const state = {
    library: [],
    playlists: [],
    activePlaylistId: 'library',
    currentPath: null,
    filterQuery: '',   // session-only (not persisted); filters the current view's rows
    tracks: [],
    currentIndex: -1,
    repeatMode: 'off',  // off -> all -> one
    shuffle: false,
    eqEnabled: true,
    waveformEnabled: true,
    lyricsEnabled: false,
    currentPreset: null, // EQ_PRESETS key, or null once the user hand-tweaks a slider
    trayOnClose: true,   // read directly by main.js's close handler via the settings file
    introEnabled: true,  // read directly by main.js before creating the splash window
    autoUpdateCheck: true, // read directly by main.js for the silent startup check
    seeking: false
  };

  // ---------- Elements ----------
  const mediaEl = document.getElementById('mediaEl');
  const coverArt = document.getElementById('coverArt');
  const albumArtEl = document.getElementById('albumArt');
  const albumArtBgEl = document.getElementById('albumArtBg');
  const playlistEl = document.getElementById('playlist');
  const playlistTabsEl = document.getElementById('playlistTabs');
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  const listTitleEl = document.getElementById('listTitle');
  const trackCountEl = document.getElementById('trackCount');
  const trackTitle = document.getElementById('trackTitle');
  const trackSub = document.getElementById('trackSub');
  const seekBar = document.getElementById('seekBar');
  const curTimeEl = document.getElementById('curTime');
  const durTimeEl = document.getElementById('durTime');
  const volumeBar = document.getElementById('volumeBar');

  const btnPlay = document.getElementById('btnPlay');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnRepeat = document.getElementById('btnRepeat');
  const btnShuffle = document.getElementById('btnShuffle');
  const btnOverlay = document.getElementById('btnOverlay');
  const btnAddFiles = document.getElementById('btnAddFiles');
  const btnClearList = document.getElementById('btnClearList');
  const btnEqToggle = document.getElementById('btnEqToggle');
  const btnWaveToggle = document.getElementById('btnWaveToggle');
  const btnLyricsToggle = document.getElementById('btnLyricsToggle');
  const lyricsViewEl = document.getElementById('lyricsView');
  const lyricsScrollEl = document.getElementById('lyricsScroll');
  const presetLabelEl = document.getElementById('presetLabel');

  const appVersionEl = document.getElementById('appVersion');
  const btnCheckUpdate = document.getElementById('btnCheckUpdate');
  const updateStatusEl = document.getElementById('updateStatus');

  const toggleTray = document.getElementById('toggleTray');
  const toggleIntro = document.getElementById('toggleIntro');
  const toggleWave = document.getElementById('toggleWave');
  const toggleLyrics = document.getElementById('toggleLyrics');
  const toggleAutoUpdate = document.getElementById('toggleAutoUpdate');

  const eqBandsEl = document.getElementById('eqBands');
  const reverbSlider = document.getElementById('reverbSlider');
  const valReverb = document.getElementById('valReverb');

  const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv']);

  // ---------- Rail + pages ----------
  // Only 홈/설정 are real destinations — the overlay rail button is an action,
  // not a page switch, so it has no data-page attribute and is excluded here.
  const railBtns = document.querySelectorAll('.rail-btn[data-page]');
  const pages = {
    main: document.getElementById('pageMain'),
    settings: document.getElementById('pageSettings')
  };

  function switchPage(name) {
    if (!pages[name]) return;
    Object.entries(pages).forEach(([key, el]) => el.classList.toggle('active', key === name));
    railBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.page === name));
    // the waveform canvas measures its container's rendered size, which is 0
    // while its page isn't the active one — re-measure now that it's shown.
    if (name === 'main') resizeRippleCanvas();
  }

  railBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // ---------- Play/pause icon ----------
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

  // ---------- 8-band graphic EQ config ----------
  const EQ_BANDS = [
    { freq: 60, type: 'lowshelf', label: '60' },
    { freq: 150, type: 'peaking', label: '150' },
    { freq: 400, type: 'peaking', label: '400' },
    { freq: 1000, type: 'peaking', label: '1K' },
    { freq: 2500, type: 'peaking', label: '2.5K' },
    { freq: 6000, type: 'peaking', label: '6K' },
    { freq: 12000, type: 'peaking', label: '12K' },
    { freq: 16000, type: 'highshelf', label: '16K' }
  ];
  const EQ_MIN = -36;
  const EQ_MAX = 36;

  // Each band is a real, fully native <input type="range"> rotated with CSS
  // (see .eq-slider-wrap in style.css) — same circular thumb and --fill
  // gradient as every other slider, just vertical. applyEqBand() below calls
  // updateRangeFill() (defined further down, used by seek/volume/reverb too)
  // so all of them stay pixel-consistent.
  const eqSliderEls = [];
  const eqValEls = [];
  EQ_BANDS.forEach((band, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'eq-band';

    const val = document.createElement('span');
    val.className = 'eq-val';
    val.textContent = '0';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'eq-slider-wrap';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(EQ_MIN);
    input.max = String(EQ_MAX);
    input.step = '1';
    input.value = '0';
    input.id = `eqSlider${i}`;

    sliderWrap.appendChild(input);

    const freq = document.createElement('span');
    freq.className = 'eq-freq';
    freq.textContent = band.label;

    wrap.appendChild(val);
    wrap.appendChild(sliderWrap);
    wrap.appendChild(freq);
    eqBandsEl.appendChild(wrap);

    eqSliderEls.push(input);
    eqValEls.push(val);
  });

  // ---------- Web Audio EQ chain ----------
  let audioCtx = null;
  let sourceNode = null;
  let eqFilters = [];
  let dryGain, wetGain, convolver, masterGain, limiter, analyser;
  let analyserData = null; // frequency-domain samples, for the overall level
  let waveformData = null; // time-domain samples, for the waveform shape

  function buildImpulseResponse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function initAudioGraph() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    sourceNode = audioCtx.createMediaElementSource(mediaEl);

    eqFilters = EQ_BANDS.map((band) => {
      const filter = audioCtx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.freq;
      if (band.type === 'peaking') filter.Q.value = 1.1;
      return filter;
    });

    convolver = audioCtx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = buildImpulseResponse(audioCtx, 1.4, 2.8);

    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    wetGain.gain.value = 0;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;

    // a soft limiter so stacking multiple +24dB band boosts doesn't clip harshly
    limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 4;
    limiter.ratio.value = 20; // near-brickwall: EQ boosts now go up to +/-36dB and reverb to 100% wet
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    // source -> [8 eq bands in series] -> [dry + convolver->wet] -> master -> limiter -> destination
    let node = sourceNode;
    for (const filter of eqFilters) {
      node.connect(filter);
      node = filter;
    }
    const lastFilter = node;

    lastFilter.connect(dryGain);
    lastFilter.connect(convolver);
    convolver.connect(wetGain);

    dryGain.connect(masterGain);
    wetGain.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(audioCtx.destination);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    waveformData = new Uint8Array(analyser.fftSize);
    masterGain.connect(analyser); // tap for visualization only, not in the audible path

    applyEqValues();
  }

  function applyEqValues() {
    if (!audioCtx) return;
    const enabled = state.eqEnabled;
    eqFilters.forEach((filter, i) => {
      filter.gain.value = enabled ? Number(eqSliderEls[i].value) : 0;
    });
    const wet = enabled ? Number(reverbSlider.value) / 100 : 0;
    wetGain.gain.value = wet;
    dryGain.gain.value = 0.92; // small constant headroom so wet doesn't clip; independent of reverb amount
  }

  // Sets one EQ band's slider + label + the actual filter gain. Shared by direct
  // slider drags, presets, saved-settings restore, and overlay remote commands
  // so all four stay in sync instead of duplicating the same four lines each.
  function applyEqBand(index, value) {
    const slider = eqSliderEls[index];
    if (!slider) return;
    slider.value = value;
    eqValEls[index].textContent = value;
    updateRangeFill(slider);
    applyEqValues();
  }

  // Same idea as applyEqBand, but for the single reverb slider.
  function applyReverb(value) {
    reverbSlider.value = value;
    updateRangeFill(reverbSlider);
    valReverb.textContent = value + ' %';
    applyEqValues();
  }

  // ---------- EQ presets ----------
  // Band order: 60, 150, 400, 1K, 2.5K, 6K, 12K, 16K
  const EQ_PRESETS = {
    flat: { bands: [0, 0, 0, 0, 0, 0, 0, 0], reverb: 0 },
    bassBoost: { bands: [26, 18, 5, 0, 0, 0, 0, 0], reverb: 10 },
    vocal: { bands: [-8, -4, -2, 4, 8, 5, 1, 0], reverb: 12 },
    hall: { bands: [2, 0, 0, 0, 0, 3, 5, 4], reverb: 90 }
  };

  // Reflects state.currentPreset onto the preset buttons' active styling and
  // the small "현재 프리셋" label under the EQ panel.
  function updatePresetButtons() {
    document.querySelectorAll('.preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.currentPreset);
    });
    const presetBtn = state.currentPreset
      ? document.querySelector(`.preset-btn[data-preset="${state.currentPreset}"]`)
      : null;
    presetLabelEl.textContent = presetBtn ? presetBtn.textContent : '사용자 설정';
  }

  // Manually dragging a band or the reverb slider means the sound no longer
  // matches any preset exactly.
  function clearPreset() {
    if (state.currentPreset === null) return;
    state.currentPreset = null;
    updatePresetButtons();
  }

  // ---------- Waveform visualizer ----------
  // A persistent horizontal waveform (not transient ripples) drawn from the
  // analyser's time-domain data. Each of WAVE_POINTS buckets holds an
  // "envelope" value that jumps up instantly on a loud sample but decays
  // slowly (WAVE_DECAY per frame), so peaks linger and the shape reads as a
  // smooth, sustained wave instead of a flickery one.
  const rippleCanvas = document.getElementById('rippleCanvas');
  const rippleCtx = rippleCanvas.getContext('2d');
  const coverNoteEl = document.querySelector('.cover-note');
  const WAVE_POINTS = 48;
  const WAVE_DECAY = 0.93;
  let waveEnvelope = new Array(WAVE_POINTS).fill(0);
  let rippleRafId = null;
  let lastLevelBroadcast = 0;

  function resizeRippleCanvas() {
    const rect = coverArt.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    rippleCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    rippleCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    rippleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getOverallLevel() {
    if (!analyser || !analyserData) return 0;
    analyser.getByteFrequencyData(analyserData);
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
    return sum / analyserData.length / 255;
  }

  function broadcastLevel(level) {
    if (!window.api.sendPlayerLevel) return;
    const now = performance.now();
    if (now - lastLevelBroadcast < 100) return;
    lastLevelBroadcast = now;
    window.api.sendPlayerLevel(level);
  }

  // Draws a smooth curve through `points` using quadratic curves through
  // successive midpoints, which avoids the jagged look of straight segments.
  function tracePath(ctx, points) {
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  function updateWaveEnvelope() {
    if (!analyser || !waveformData) return;
    analyser.getByteTimeDomainData(waveformData);
    const bucketSize = waveformData.length / WAVE_POINTS;
    for (let i = 0; i < WAVE_POINTS; i++) {
      let maxDeviation = 0;
      const start = Math.floor(i * bucketSize);
      const end = Math.floor((i + 1) * bucketSize);
      for (let j = start; j < end; j++) {
        const deviation = Math.abs(waveformData[j] - 128) / 128; // 0..1
        if (deviation > maxDeviation) maxDeviation = deviation;
      }
      waveEnvelope[i] = Math.max(maxDeviation, waveEnvelope[i] * WAVE_DECAY);
    }
  }

  // A single waveform rising from the bottom edge (not the old mirrored-
  // top-and-bottom ribbon, which read as two separate traces) — one curve,
  // filled down to the baseline, with a bright stroke along just the top edge.
  function drawWaveform(w, h) {
    const baseline = h;
    const stepX = w / (WAVE_POINTS - 1);
    const amplitude = h * 0.85;

    const topPoints = waveEnvelope.map((v, i) => ({ x: i * stepX, y: baseline - v * amplitude }));

    rippleCtx.clearRect(0, 0, w, h);

    rippleCtx.beginPath();
    tracePath(rippleCtx, topPoints);
    rippleCtx.lineTo(w, baseline);
    rippleCtx.lineTo(0, baseline);
    rippleCtx.closePath();

    const gradient = rippleCtx.createLinearGradient(0, 0, 0, baseline);
    gradient.addColorStop(0, 'rgba(210, 206, 253, 0.6)');
    gradient.addColorStop(1, 'rgba(145, 132, 217, 0.05)');
    rippleCtx.fillStyle = gradient;
    rippleCtx.shadowColor = 'rgba(145, 132, 217, 0.5)';
    rippleCtx.shadowBlur = 16;
    rippleCtx.fill();

    rippleCtx.shadowBlur = 0;
    rippleCtx.lineWidth = 1.8;
    rippleCtx.strokeStyle = 'rgba(233, 233, 237, 0.5)';
    rippleCtx.beginPath();
    tracePath(rippleCtx, topPoints);
    rippleCtx.stroke();
  }

  function rippleTick() {
    rippleRafId = requestAnimationFrame(rippleTick);

    const overall = getOverallLevel();
    broadcastLevel(overall);

    if (coverArt.classList.contains('hidden')) return;

    const rect = coverArt.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w === 0 || h === 0) return; // also covers 홈 not being the active page

    updateWaveEnvelope();
    drawWaveform(w, h);
  }

  function startRippleLoop() {
    if (rippleRafId || !state.waveformEnabled) return;
    waveEnvelope = new Array(WAVE_POINTS).fill(0);
    resizeRippleCanvas();
    if (coverNoteEl) coverNoteEl.classList.add('faded');
    rippleRafId = requestAnimationFrame(rippleTick);
  }

  function stopRippleLoop() {
    if (rippleRafId) {
      cancelAnimationFrame(rippleRafId);
      rippleRafId = null;
    }
    if (rippleCtx) rippleCtx.clearRect(0, 0, rippleCanvas.width, rippleCanvas.height);
    if (coverNoteEl) coverNoteEl.classList.remove('faded');
  }

  // Shared by the on-stage waveform-toggle button and the 설정 page's toggle
  // switch so both controls (and the saved settings file) always agree.
  function setWaveformEnabled(enabled) {
    state.waveformEnabled = enabled;
    btnWaveToggle.classList.toggle('off', !enabled);
    toggleWave.classList.toggle('on', enabled);
    updateCoverVisibility(false); // may reveal/hide the waveform over an mp4's own picture
    if (enabled) {
      if (!mediaEl.paused) startRippleLoop();
    } else {
      stopRippleLoop();
    }
    scheduleSave();
  }

  window.addEventListener('resize', () => {
    if (pages.main.classList.contains('active') && !coverArt.classList.contains('hidden')) resizeRippleCanvas();
  });

  // ---------- Lyrics (LRCLIB + local .lrc) ----------
  // The network/filesystem lookup itself runs in the main process (see
  // main.js's 'fetch-lyrics' handler — the renderer's CSP can't reach an
  // external host directly). This half just: parses LRC text into a
  // sorted [{time, text}] list, tracks which line is "active" against
  // mediaEl.currentTime, and renders/scrolls the overlay.
  let currentLyrics = [];       // [{time, text}], synced case only
  let lastActiveLyricsIndex = -1;
  let lyricsLoadedPath = null;  // track path currentLyrics/lyricsView reflects, so a track change re-fetches
  let lyricsRequestToken = 0;   // bumped on every new fetch so a slow stale response can't clobber a newer one
  let lyricsResolved = false;   // true once a fetch produced actual lyrics (synced or plain) — gates the ID3-arrival retry

  const LRC_TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  function parseLRC(text) {
    const lines = text.split(/\r?\n/);
    const result = [];
    for (const line of lines) {
      LRC_TIME_TAG.lastIndex = 0;
      const tags = [];
      let m;
      while ((m = LRC_TIME_TAG.exec(line))) tags.push(m);
      if (!tags.length) continue; // metadata lines ([ar:...], [ti:...], etc.) have no time tag
      const content = line.replace(LRC_TIME_TAG, '').trim();
      if (!content) continue;
      for (const t of tags) {
        const min = parseInt(t[1], 10);
        const sec = parseInt(t[2], 10);
        const frac = t[3] ? parseInt(t[3].padEnd(3, '0').slice(0, 3), 10) : 0;
        result.push({ time: min * 60 + sec + frac / 1000, text: content });
      }
    }
    result.sort((a, b) => a.time - b.time);
    return result;
  }

  // Renders currentLyrics as one <div class="lyrics-line"> per line. Called
  // once per fetch (or state change) — the per-frame highlight update in
  // updateActiveLyricsLine() just toggles .active on the existing divs
  // rather than re-rendering.
  function renderLyricsLines(message) {
    lyricsScrollEl.innerHTML = '';
    lastActiveLyricsIndex = -1;
    if (!currentLyrics.length) {
      const empty = document.createElement('div');
      empty.className = 'lyrics-empty';
      empty.textContent = message || '가사를 찾을 수 없어요';
      lyricsScrollEl.appendChild(empty);
      return;
    }
    currentLyrics.forEach((line) => {
      const div = document.createElement('div');
      div.className = 'lyrics-line';
      div.textContent = line.text;
      lyricsScrollEl.appendChild(div);
    });
  }

  // Untimed lyrics (LRCLIB has no syncedLyrics for this track, only
  // plainLyrics): shown as a single static block, no highlight/scroll.
  function renderPlainLyrics(text) {
    lyricsScrollEl.innerHTML = '';
    lastActiveLyricsIndex = -1;
    const pre = document.createElement('div');
    pre.className = 'lyrics-plain';
    pre.textContent = text;
    lyricsScrollEl.appendChild(pre);
  }

  // Called from the timeupdate handler. Cheap when nothing changed (one
  // comparison), so it's fine to call every tick even though it only does
  // real DOM work when the active line actually advances.
  function updateActiveLyricsLine() {
    if (!state.lyricsEnabled || !currentLyrics.length) return;
    const t = mediaEl.currentTime;
    let idx = -1;
    for (let i = 0; i < currentLyrics.length; i++) {
      if (currentLyrics[i].time <= t) idx = i; else break;
    }
    if (idx === lastActiveLyricsIndex) return;
    lastActiveLyricsIndex = idx;
    const children = lyricsScrollEl.children;
    for (let i = 0; i < children.length; i++) {
      children[i].classList.toggle('active', i === idx);
    }
    if (idx >= 0 && children[idx]) {
      children[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  async function loadLyricsForTrack(track) {
    const token = ++lyricsRequestToken;
    currentLyrics = [];
    renderLyricsLines('가사를 불러오는 중...');
    let result = null;
    try {
      result = await window.api.fetchLyrics({
        path: track.path,
        name: track.name,
        artist: (track.meta && track.meta.artist) || undefined,
        title: (track.meta && track.meta.title) || undefined,
        durationSec: track.durationSec || mediaEl.duration || 0
      });
    } catch {
      result = null;
    }
    if (token !== lyricsRequestToken) return; // a newer track/fetch has since started

    if (result && result.synced && result.lrc) {
      currentLyrics = parseLRC(result.lrc);
    }
    if (currentLyrics.length) {
      renderLyricsLines();
      lyricsResolved = true;
    } else if (result && result.plain) {
      renderPlainLyrics(result.plain);
      lyricsResolved = true;
    } else {
      renderLyricsLines('가사를 찾을 수 없어요');
      lyricsResolved = false;
    }
  }

  // Fetches (or re-shows already-fetched) lyrics for the current track, but
  // only while the lyrics view is actually visible — so tracks are never
  // looked up over the network just because they happened to play while the
  // lyrics panel was off. `force` re-fetches even for the same track (used
  // when ID3 tags arrive after the first, filename-only attempt).
  function ensureLyricsLoaded(force) {
    if (!state.lyricsEnabled || state.currentIndex < 0) return;
    const track = state.tracks[state.currentIndex];
    if (!force && lyricsLoadedPath === track.path) return;
    lyricsLoadedPath = track.path;
    loadLyricsForTrack(track);
  }

  function resetLyricsView() {
    currentLyrics = [];
    lastActiveLyricsIndex = -1;
    lyricsLoadedPath = null;
    lyricsResolved = false;
    lyricsRequestToken++; // invalidate any in-flight fetch for the old track
    if (state.lyricsEnabled) renderLyricsLines();
  }

  function setLyricsEnabled(enabled) {
    state.lyricsEnabled = enabled;
    btnLyricsToggle.classList.toggle('off', !enabled);
    lyricsViewEl.classList.toggle('hidden', !enabled);
    setToggleUI(toggleLyrics, enabled);
    if (enabled) ensureLyricsLoaded();
    scheduleSave();
  }

  btnLyricsToggle.addEventListener('click', () => setLyricsEnabled(!state.lyricsEnabled));
  toggleLyrics.addEventListener('click', () => setLyricsEnabled(!state.lyricsEnabled));

  // ---------- Playlist helpers ----------
  function extOf(p) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(p);
    return m ? m[1].toLowerCase() : '';
  }

  function baseName(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  // Loads a throwaway <video> just far enough to read its duration, so the
  // playlist can show a length without ever having to play the file. Works
  // for audio-only files too — Chromium is happy to read metadata off a
  // <video> element regardless of whether there's a picture. Never attached
  // to the DOM, so a Set holds a strong reference until it settles —
  // otherwise it'd be eligible for GC mid-load with nothing else pointing to it.
  const pendingProbes = new Set();
  function probeDuration(track) {
    const encoded = encodeURI(track.path.replace(/\\/g, '/'));
    const url = 'file:///' + encoded.replace(/^\/+/, '');
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    pendingProbes.add(probe);
    const cleanup = () => pendingProbes.delete(probe);
    probe.addEventListener('loadedmetadata', () => {
      track.durationSec = probe.duration;
      renderPlaylist();
      cleanup();
    }, { once: true });
    probe.addEventListener('error', cleanup, { once: true });
    probe.src = url;
  }

  // ---------- Track metadata (ID3 / MP4 / Vorbis tags) ----------
  // Read in the main process (music-metadata) — see preload's readMetadata.
  // Text tags are cached on the track object and persisted in the settings
  // file so a big library isn't re-parsed on every launch; cover art is not
  // persisted (too heavy for JSON) and is re-read on each track load.

  // What to show as a track's primary line / secondary line — real tags when
  // we have them, the filename otherwise.
  function displayTitle(track) {
    return (track.meta && track.meta.title) ? track.meta.title : track.name;
  }
  function displaySubtitle(track) {
    if (!track.meta) return null;
    const { artist, album } = track.meta;
    if (!artist) return null;
    return album ? `${artist} · ${album}` : artist;
  }

  function updateNowPlaying(track) {
    trackTitle.textContent = displayTitle(track);
    trackTitle.title = track.path;
    const sub = displaySubtitle(track);
    trackSub.textContent = sub || `트랙 ${state.currentIndex + 1} / ${state.tracks.length}`;
  }

  const pendingMetaLoads = new Set(); // track paths currently being parsed
  let artLoadToken = 0;               // bumped per track load so a slow art read can't paint over a newer track

  // Applies freshly-read text tags to a track and refreshes anything showing it.
  function applyMeta(track, m) {
    if (!m || m.error) return;
    track.meta = { title: m.title || null, artist: m.artist || null, album: m.album || null, year: m.year || null };
    if (!track.durationSec && m.durationSec) track.durationSec = m.durationSec;
    renderPlaylist();
    if (state.currentIndex >= 0 && state.tracks[state.currentIndex] === track) {
      updateNowPlaying(track);
      broadcastState();
      if (!lyricsResolved) ensureLyricsLoaded(true); // real artist/title may now find lyrics the filename couldn't
    }
    scheduleSave();
  }

  // Text tags only (skipCovers) — used to fill the playlist in the background.
  async function loadMetaForTrack(track) {
    if (track.meta || pendingMetaLoads.has(track.path)) return;
    pendingMetaLoads.add(track.path);
    try {
      const m = await window.api.readMetadata({ path: track.path, wantPicture: false });
      applyMeta(track, m);
    } catch {
      // leave track.meta undefined; the UI falls back to the filename
    } finally {
      pendingMetaLoads.delete(track.path);
    }
  }

  // Gate the first-launch parse storm: after a library is imported (or an
  // older save without cached tags is loaded), every track wants its tags at
  // once. Cap how many parse in parallel; once read, tags are cached in the
  // settings file so this only bites on the first run.
  const metaQueue = [];
  let metaActive = 0;
  function pumpMetaQueue() {
    while (metaActive < 4 && metaQueue.length) {
      const t = metaQueue.shift();
      metaActive++;
      loadMetaForTrack(t).finally(() => { metaActive--; pumpMetaQueue(); });
    }
  }
  function queueMetaLoad(track) {
    if (track.meta) return;
    metaQueue.push(track);
    pumpMetaQueue();
  }

  // Text tags + resized cover art — used for the track being put on the stage.
  async function loadArtForTrack(track) {
    const token = ++artLoadToken;
    clearAlbumArt();
    let m = null;
    try {
      m = await window.api.readMetadata({ path: track.path, wantPicture: true });
    } catch {
      m = null;
    }
    if (token !== artLoadToken) return; // a newer track has since loaded
    if (m && !m.error && !track.meta) applyMeta(track, m);
    if (m && m.picture) {
      albumArtEl.src = m.picture;
      albumArtBgEl.src = m.picture;
      albumArtEl.classList.remove('hidden');
      albumArtBgEl.classList.remove('hidden');
    }
  }

  function clearAlbumArt() {
    albumArtEl.classList.add('hidden');
    albumArtBgEl.classList.add('hidden');
    albumArtEl.removeAttribute('src');
    albumArtBgEl.removeAttribute('src');
  }

  // ---------- Library / playlists ----------
  const LIBRARY_ID = 'library';

  function genPlaylistId() {
    return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function activePlaylist() {
    return state.activePlaylistId === LIBRARY_ID
      ? null
      : state.playlists.find((p) => p.id === state.activePlaylistId) || null;
  }

  // Rebuilds state.tracks (the resolved active list) and re-derives
  // currentIndex from currentPath. Call after any change to library,
  // playlists, or activePlaylistId.
  function rebuildActiveList() {
    const pl = activePlaylist();
    if (!pl) {
      state.tracks = state.library.slice();
    } else {
      const byPath = new Map(state.library.map((t) => [t.path, t]));
      state.tracks = pl.paths.map((p) => byPath.get(p)).filter(Boolean);
    }
    state.currentIndex = state.currentPath
      ? state.tracks.findIndex((t) => t.path === state.currentPath)
      : -1;
  }

  function addFiles(paths) {
    const known = new Set(state.library.map((t) => t.path));
    const pl = activePlaylist();
    let firstNew = null;
    for (const p of paths) {
      if (!p) continue;
      if (!known.has(p)) {
        const track = { path: p, name: baseName(p), durationSec: null };
        state.library.push(track);
        known.add(p);
        probeDuration(track);
        queueMetaLoad(track);
        if (!firstNew) firstNew = p;
      }
      // when viewing a playlist, dropping files also files them into it
      if (pl && !pl.paths.includes(p)) pl.paths.push(p);
    }
    rebuildActiveList();
    renderPlaylist();
    renderPlaylistTabs();
    if (state.currentIndex === -1 && state.tracks.length) {
      const idx = firstNew ? state.tracks.findIndex((t) => t.path === firstNew) : 0;
      loadTrack(idx >= 0 ? idx : 0, false);
    }
    scheduleSave();
  }

  function switchPlaylist(id) {
    if (id !== LIBRARY_ID && !state.playlists.some((p) => p.id === id)) return;
    state.activePlaylistId = id;
    rebuildActiveList();
    renderPlaylistTabs();
    renderPlaylist();
    scheduleSave();
  }

  function createPlaylist(name) {
    const pl = { id: genPlaylistId(), name: name || '새 재생목록', paths: [] };
    state.playlists.push(pl);
    switchPlaylist(pl.id);
    return pl;
  }

  function renamePlaylist(id, name) {
    const pl = state.playlists.find((p) => p.id === id);
    if (!pl) return;
    pl.name = name.trim() || pl.name;
    renderPlaylistTabs();
    if (state.activePlaylistId === id) renderPlaylist(); // refresh the list header
    scheduleSave();
  }

  function deletePlaylist(id) {
    const i = state.playlists.findIndex((p) => p.id === id);
    if (i === -1) return;
    state.playlists.splice(i, 1);
    if (state.activePlaylistId === id) {
      switchPlaylist(LIBRARY_ID);
    } else {
      renderPlaylistTabs();
      scheduleSave();
    }
  }

  function addPathToPlaylist(path, playlistId) {
    const pl = state.playlists.find((p) => p.id === playlistId);
    if (!pl || pl.paths.includes(path)) return;
    pl.paths.push(path);
    if (state.activePlaylistId === playlistId) { rebuildActiveList(); renderPlaylist(); }
    renderPlaylistTabs();
    scheduleSave();
  }

  function renderPlaylistTabs() {
    playlistTabsEl.innerHTML = '';
    const mkTab = (id, name, deletable) => {
      const tab = document.createElement('button');
      tab.className = 'pl-tab' + (state.activePlaylistId === id ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'pl-tab-name';
      label.textContent = name;
      tab.appendChild(label);
      tab.addEventListener('click', () => switchPlaylist(id));
      if (deletable) {
        tab.addEventListener('dblclick', (e) => { e.stopPropagation(); beginTabRename(tab, id); });
        const del = document.createElement('span');
        del.className = 'pl-tab-del';
        del.textContent = '✕';
        del.title = '재생목록 삭제';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          const pl = state.playlists.find((p) => p.id === id);
          if (pl && (pl.paths.length === 0 || confirm(`재생목록 "${pl.name}"을(를) 삭제할까요? (곡은 라이브러리에 남습니다)`))) {
            deletePlaylist(id);
          }
        });
        tab.appendChild(del);
      }
      playlistTabsEl.appendChild(tab);
    };

    mkTab(LIBRARY_ID, '전체 곡', false);
    state.playlists.forEach((pl) => mkTab(pl.id, pl.name, true));

    const add = document.createElement('button');
    add.className = 'pl-tab add-tab';
    add.textContent = '+';
    add.title = '새 재생목록';
    add.addEventListener('click', () => {
      const pl = createPlaylist('새 재생목록');
      const tab = playlistTabsEl.querySelector('.pl-tab.active');
      if (tab) beginTabRename(tab, pl.id);
    });
    playlistTabsEl.appendChild(add);
  }

  // Turns a tab into an inline text input for (re)naming.
  function beginTabRename(tab, id) {
    const pl = state.playlists.find((p) => p.id === id);
    if (!pl) return;
    const input = document.createElement('input');
    input.className = 'pl-tab-edit';
    input.value = pl.name;
    tab.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => { if (done) return; done = true; renamePlaylist(id, input.value); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { done = true; renderPlaylistTabs(); }
    });
    input.addEventListener('blur', commit);
  }

  // The little "add to playlist" popup for a library-view row.
  let openRowMenu = null;
  function closeRowMenu() {
    if (openRowMenu) { openRowMenu.remove(); openRowMenu = null; }
    document.querySelectorAll('.playlist li.menu-open').forEach((li) => li.classList.remove('menu-open'));
  }
  function openAddToPlaylistMenu(anchorEl, li, path) {
    closeRowMenu();
    li.classList.add('menu-open');
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    state.playlists.forEach((pl) => {
      const b = document.createElement('button');
      b.textContent = pl.paths.includes(path) ? `✓ ${pl.name}` : pl.name;
      b.addEventListener('click', () => { addPathToPlaylist(path, pl.id); closeRowMenu(); });
      menu.appendChild(b);
    });
    if (state.playlists.length) {
      const sep = document.createElement('div');
      sep.className = 'row-menu-sep';
      menu.appendChild(sep);
    }
    const nw = document.createElement('button');
    nw.className = 'row-menu-new';
    nw.textContent = '+ 새 재생목록';
    nw.addEventListener('click', () => {
      const pl = createPlaylist('새 재생목록');
      pl.paths.push(path);
      closeRowMenu();
      switchPlaylist(pl.id);
      const tab = playlistTabsEl.querySelector('.pl-tab.active');
      if (tab) beginTabRename(tab, pl.id);
    });
    menu.appendChild(nw);

    document.body.appendChild(menu);
    const r = anchorEl.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + 'px';
    openRowMenu = menu;
  }
  document.addEventListener('click', (e) => {
    if (openRowMenu && !openRowMenu.contains(e.target)) closeRowMenu();
  });

  // Quick filter over the currently-viewed list (library or a playlist) —
  // matches the same title/artist you'd see in the row, so it works whether
  // or not a track has ID3 tags. Purely a view filter: it doesn't touch
  // state.tracks, playback, or what next/prev traverse.
  function trackMatchesQuery(track, q) {
    const haystack = [track.name, track.meta && track.meta.title, track.meta && track.meta.artist, track.meta && track.meta.album]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function renderPlaylist() {
    const pl = activePlaylist();
    listTitleEl.textContent = pl ? pl.name : '전체 곡';
    btnClearList.textContent = pl ? '목록 비우기' : '전체 삭제';

    const q = state.filterQuery.trim().toLowerCase();
    const visible = q ? state.tracks.filter((t) => trackMatchesQuery(t, q)) : state.tracks;
    trackCountEl.textContent = q ? `${visible.length} / ${state.tracks.length}곡` : `${state.tracks.length}곡`;

    playlistEl.innerHTML = '';
    visible.forEach((track) => {
      const i = state.tracks.indexOf(track); // real index — for loadTrack/removeTrack, which don't know about the filter
      const li = document.createElement('li');
      if (i === state.currentIndex) li.classList.add('active');
      li.dataset.path = track.path;

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const text = document.createElement('span');
      text.className = 'track-text';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = displayTitle(track);
      name.title = track.path;
      text.appendChild(name);
      const subtitle = displaySubtitle(track);
      if (subtitle) {
        const artist = document.createElement('span');
        artist.className = 'artist';
        artist.textContent = subtitle;
        text.appendChild(artist);
      }

      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = track.durationSec ? fmtTime(track.durationSec) : '';

      // library view: "＋" to file into a playlist; playlist view: no add button
      if (!pl) {
        const add = document.createElement('span');
        add.className = 'row-btn add';
        add.textContent = '＋';
        add.title = '재생목록에 추가';
        add.addEventListener('click', (e) => {
          e.stopPropagation();
          openAddToPlaylistMenu(add, li, track.path);
        });
        li.appendChild(add);
      }

      const remove = document.createElement('span');
      remove.className = 'row-btn remove';
      remove.textContent = '✕';
      remove.title = pl ? '이 재생목록에서 제거' : '라이브러리에서 삭제';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(i);
      });

      li.appendChild(idx);
      li.appendChild(text);
      li.appendChild(dur);
      li.appendChild(remove);
      li.addEventListener('click', () => loadTrack(i, true));

      // drag to reorder — only inside a user playlist, and only with no
      // filter active (reordering a filtered-down view would be confusing:
      // rows adjacent on screen aren't necessarily adjacent underneath)
      if (pl && !q) {
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          li.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', track.path);
        });
        li.addEventListener('dragend', () => {
          li.classList.remove('dragging');
          playlistEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
        });
        li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          li.classList.remove('drag-over');
          reorderInPlaylist(e.dataTransfer.getData('text/plain'), track.path);
        });
      }

      playlistEl.appendChild(li);
    });
  }

  function reorderInPlaylist(fromPath, toPath) {
    const pl = activePlaylist();
    if (!pl || fromPath === toPath) return;
    const from = pl.paths.indexOf(fromPath);
    let to = pl.paths.indexOf(toPath);
    if (from === -1 || to === -1) return;
    pl.paths.splice(from, 1);
    to = pl.paths.indexOf(toPath); // recompute after removal
    pl.paths.splice(to, 0, fromPath);
    rebuildActiveList();
    renderPlaylist();
    scheduleSave();
  }

  function stopAndClearStage() {
    mediaEl.pause();
    mediaEl.removeAttribute('src');
    state.currentPath = null;
    state.currentIndex = -1;
    trackTitle.textContent = '재생할 파일을 선택하세요';
    trackTitle.removeAttribute('title');
    trackSub.textContent = ' ';
    updateCoverVisibility(true);
    clearAlbumArt();
    resetLyricsView();
    setPlayIcon(false);
    broadcastState();
  }

  function removeTrack(i) {
    const track = state.tracks[i];
    if (!track) return;
    const wasCurrent = i === state.currentIndex;
    const pl = activePlaylist();

    if (pl) {
      // remove from this playlist only; the track stays in the library
      const p = pl.paths.indexOf(track.path);
      if (p !== -1) pl.paths.splice(p, 1);
    } else {
      // library removal — also drop it from every playlist
      const li = state.library.findIndex((t) => t.path === track.path);
      if (li !== -1) state.library.splice(li, 1);
      state.playlists.forEach((p) => {
        const j = p.paths.indexOf(track.path);
        if (j !== -1) p.paths.splice(j, 1);
      });
    }

    rebuildActiveList();

    if (wasCurrent) {
      if (state.tracks.length === 0) {
        stopAndClearStage();
      } else {
        loadTrack(Math.min(i, state.tracks.length - 1), !mediaEl.paused);
      }
    }
    renderPlaylist();
    renderPlaylistTabs();
    scheduleSave();
  }

  function clearPlaylist() {
    const pl = activePlaylist();
    if (pl) {
      if (pl.paths.length && !confirm(`"${pl.name}" 재생목록을 비울까요? (곡은 라이브러리에 남습니다)`)) return;
      pl.paths = [];
    } else {
      if (state.library.length && !confirm('라이브러리의 모든 곡과 재생목록을 삭제할까요?')) return;
      state.library = [];
      state.playlists = [];
      state.activePlaylistId = LIBRARY_ID;
    }
    rebuildActiveList();
    if (state.currentIndex === -1) stopAndClearStage();
    renderPlaylist();
    renderPlaylistTabs();
    scheduleSave();
  }

  // Video defaults to showing its own picture, same as always — a saved
  // waveformEnabled:true from a previous session (the default) shouldn't
  // silently hide video the next time an mp4 is opened. But once the user
  // actually clicks the waveform toggle during this run, that's a clear
  // "I want the waveform, even over video" signal, so it wins from then on
  // for any track, until they toggle it back off.
  let userToggledWaveform = false;

  function updateCoverVisibility(forceCover) {
    const ext = state.currentIndex >= 0 ? extOf(state.tracks[state.currentIndex].path) : '';
    const isVideo = VIDEO_EXT.has(ext) && mediaEl.videoWidth > 0;
    const videoWantsWaveform = userToggledWaveform && state.waveformEnabled;
    const showCover = forceCover || !isVideo || videoWantsWaveform;
    if (showCover) {
      coverArt.classList.remove('hidden');
      resizeRippleCanvas();
    } else {
      coverArt.classList.add('hidden');
    }
  }

  function loadTrack(index, autoplay) {
    if (index < 0 || index >= state.tracks.length) return;
    state.currentIndex = index;
    const track = state.tracks[index];
    state.currentPath = track.path;

    const encoded = encodeURI(track.path.replace(/\\/g, '/'));
    mediaEl.src = 'file:///' + encoded.replace(/^\/+/, '');

    updateNowPlaying(track);
    updateCoverVisibility(true);
    loadArtForTrack(track); // also backfills track.meta if it wasn't read yet
    renderPlaylist();
    resetLyricsView();
    ensureLyricsLoaded();

    initAudioGraph();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    if (autoplay) {
      mediaEl.play().catch(() => {});
    }
    broadcastState();
    scheduleSave();
  }

  function setPlayIcon(playing) {
    btnPlay.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  }

  function togglePlay() {
    // Nothing loaded yet (or the loaded track isn't in the list being viewed
    // and playback is stopped) — start the active list from the top.
    if (!mediaEl.currentSrc && !mediaEl.src) {
      if (state.tracks.length) loadTrack(state.currentIndex >= 0 ? state.currentIndex : 0, true);
      return;
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (mediaEl.paused) {
      mediaEl.play().catch(() => {});
    } else {
      mediaEl.pause();
    }
  }

  // Returns the track index to play next/previous, or -1 if playback should
  // stop (end of list with repeat off). `forward` is ignored in shuffle mode
  // since "previous" doesn't really mean anything for a random order.
  function pickNextIndex(forward) {
    const n = state.tracks.length;
    if (n === 0) return -1;
    if (state.shuffle) {
      if (n === 1) return 0;
      let r;
      do { r = Math.floor(Math.random() * n); } while (r === state.currentIndex);
      return r;
    }
    if (forward) {
      const idx = state.currentIndex + 1;
      return idx >= n ? (state.repeatMode === 'all' ? 0 : -1) : idx;
    }
    const idx = state.currentIndex - 1;
    return idx < 0 ? (state.repeatMode === 'all' ? n - 1 : -1) : idx;
  }

  function playNext(auto) {
    if (state.tracks.length === 0) return;
    if (auto && state.repeatMode === 'one') {
      mediaEl.currentTime = 0;
      mediaEl.play().catch(() => {});
      return;
    }
    const next = pickNextIndex(true);
    if (next === -1) {
      mediaEl.pause();
      setPlayIcon(false);
      return;
    }
    loadTrack(next, true);
  }

  function playPrev() {
    if (state.tracks.length === 0) return;
    if (mediaEl.currentTime > 3) {
      mediaEl.currentTime = 0;
      return;
    }
    const prev = pickNextIndex(false);
    if (prev === -1) {
      loadTrack(0, true);
      return;
    }
    loadTrack(prev, true);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function updateRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const val = Number(input.value);
    const pct = ((val - min) / (max - min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  function updateRepeatButton() {
    btnRepeat.classList.toggle('active', state.repeatMode !== 'off');
    btnRepeat.classList.toggle('repeat-one', state.repeatMode === 'one');
    btnRepeat.title =
      state.repeatMode === 'off' ? '반복 없음' :
      state.repeatMode === 'all' ? '전체 반복' : '한 곡 반복';
  }

  // ---------- Overlay sync ----------
  function broadcastState() {
    if (!window.api.sendPlayerState) return;
    const cur = state.currentIndex >= 0 ? state.tracks[state.currentIndex] : null;
    window.api.sendPlayerState({
      title: cur ? displayTitle(cur) : '',
      artist: cur && cur.meta ? (cur.meta.artist || '') : '',
      playing: !mediaEl.paused && state.currentIndex >= 0,
      index: state.currentIndex,
      total: state.tracks.length,
      volume: mediaEl.volume,
      currentTime: mediaEl.currentTime || 0,
      duration: mediaEl.duration || 0,
      eq: {
        bands: eqSliderEls.map((s) => Number(s.value)),
        reverb: Number(reverbSlider.value)
      }
    });
  }

  window.api.onRemoteCommand((cmd) => {
    switch (cmd.type) {
      case 'toggle-play':
        togglePlay();
        break;
      case 'next':
        playNext(false);
        break;
      case 'prev':
        playPrev();
        break;
      case 'volume':
        mediaEl.volume = cmd.value;
        volumeBar.value = String(Math.round(cmd.value * 100));
        updateRangeFill(volumeBar);
        scheduleSave();
        break;
      case 'seek':
        if (mediaEl.duration) {
          mediaEl.currentTime = cmd.fraction * mediaEl.duration;
        }
        break;
      case 'eq-band':
        applyEqBand(cmd.index, cmd.value);
        clearPreset();
        scheduleSave();
        break;
      case 'eq-reverb':
        applyReverb(cmd.value);
        clearPreset();
        scheduleSave();
        break;
    }
  });

  window.api.onOverlayClosed(() => {
    btnOverlay.classList.remove('active');
  });

  btnOverlay.addEventListener('click', async () => {
    const isOpen = await window.api.toggleOverlay();
    btnOverlay.classList.toggle('active', isOpen);
    if (isOpen) broadcastState();
  });

  // ---------- Persisted settings ----------
  // readyToSave stays false until restoreSettings() finishes applying the
  // saved file to the UI. Without this guard, the default (empty) state set
  // during page init would trigger a save and overwrite the real saved file
  // before it's even been read back.
  let readyToSave = false;
  let saveTimer = null;

  function gatherSettings() {
    return {
      library: state.library,
      playlists: state.playlists,
      activePlaylistId: state.activePlaylistId,
      currentPath: state.currentPath,
      repeatMode: state.repeatMode,
      shuffle: state.shuffle,
      eqEnabled: state.eqEnabled,
      waveformEnabled: state.waveformEnabled,
      lyricsEnabled: state.lyricsEnabled,
      currentPreset: state.currentPreset,
      trayOnClose: state.trayOnClose,
      introEnabled: state.introEnabled,
      autoUpdateCheck: state.autoUpdateCheck,
      volume: mediaEl.volume,
      eq: {
        bands: eqSliderEls.map((s) => Number(s.value)),
        reverb: Number(reverbSlider.value)
      }
    };
  }

  function scheduleSave() {
    if (!readyToSave) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.api.saveSettings(gatherSettings());
    }, 400);
  }

  window.addEventListener('beforeunload', () => {
    if (!readyToSave) return;
    clearTimeout(saveTimer);
    window.api.saveSettings(gatherSettings());
  });

  async function restoreSettings() {
    let data = null;
    try {
      data = await window.api.loadSettings();
    } catch {
      data = null;
    }

    if (data) {
      if (data.eq) {
        if (Array.isArray(data.eq.bands)) {
          data.eq.bands.forEach((value, i) => applyEqBand(i, value ?? 0));
        }
        applyReverb(data.eq.reverb ?? 0);
      }
      if (typeof data.currentPreset === 'string' && EQ_PRESETS[data.currentPreset]) {
        state.currentPreset = data.currentPreset;
      }
      updatePresetButtons();
      if (typeof data.eqEnabled === 'boolean') {
        state.eqEnabled = data.eqEnabled;
        btnEqToggle.classList.toggle('on', state.eqEnabled);
        btnEqToggle.textContent = state.eqEnabled ? 'EQ ON' : 'EQ OFF';
      }
      setWaveformEnabled(typeof data.waveformEnabled === 'boolean' ? data.waveformEnabled : true);
      setLyricsEnabled(typeof data.lyricsEnabled === 'boolean' ? data.lyricsEnabled : false);
      state.trayOnClose = data.trayOnClose !== false;
      setToggleUI(toggleTray, state.trayOnClose);
      state.introEnabled = data.introEnabled !== false;
      setToggleUI(toggleIntro, state.introEnabled);
      state.autoUpdateCheck = data.autoUpdateCheck !== false;
      setToggleUI(toggleAutoUpdate, state.autoUpdateCheck);
      if (data.repeatMode) {
        state.repeatMode = data.repeatMode;
        updateRepeatButton();
      }
      if (typeof data.shuffle === 'boolean') {
        state.shuffle = data.shuffle;
        btnShuffle.classList.toggle('active', state.shuffle);
      }
      if (typeof data.volume === 'number') {
        mediaEl.volume = data.volume;
        volumeBar.value = String(Math.round(data.volume * 100));
      }
      updateRangeFill(volumeBar); // reverbSlider's fill was already set by applyReverb() above

      // Library + playlists. main.js migrates the old {tracks,currentIndex}
      // shape to {library,playlists,currentPath} and prunes dead paths, so by
      // here we only ever see the new shape.
      if (Array.isArray(data.library)) {
        state.library = data.library;
        state.playlists = Array.isArray(data.playlists)
          ? data.playlists.filter((p) => p && typeof p.id === 'string').map((p) => ({
              id: p.id, name: String(p.name || '재생목록'), paths: Array.isArray(p.paths) ? p.paths.slice() : []
            }))
          : [];
        state.activePlaylistId =
          data.activePlaylistId === LIBRARY_ID || state.playlists.some((p) => p.id === data.activePlaylistId)
            ? data.activePlaylistId : LIBRARY_ID;
        state.currentPath = typeof data.currentPath === 'string' ? data.currentPath : null;

        state.library.forEach((t) => {
          if (!t.durationSec) probeDuration(t);
          queueMetaLoad(t);
        });
        rebuildActiveList();
        renderPlaylistTabs();
        renderPlaylist();
        if (state.currentIndex >= 0) loadTrack(state.currentIndex, false);
      }
    }

    if (!state.library.length) { renderPlaylistTabs(); renderPlaylist(); }
    readyToSave = true;
  }

  // ---------- Auto update ----------
  let updateState = 'idle'; // idle | checking | available | downloading | downloaded

  function setUpdateStatus(text, kind) {
    updateStatusEl.textContent = text || '';
    updateStatusEl.className = 'update-status' + (kind ? ` ${kind}` : '');
  }

  window.api.getAppVersion().then((v) => {
    appVersionEl.textContent = `v${v}`;
  });

  window.api.onUpdateStatus((payload) => {
    switch (payload.status) {
      case 'checking':
        updateState = 'checking';
        btnCheckUpdate.disabled = true;
        btnCheckUpdate.textContent = '확인 중...';
        setUpdateStatus('');
        break;
      case 'not-available':
        updateState = 'idle';
        btnCheckUpdate.disabled = false;
        btnCheckUpdate.textContent = '업데이트 확인';
        setUpdateStatus('최신 버전입니다.');
        break;
      case 'available':
        updateState = 'available';
        btnCheckUpdate.disabled = false;
        btnCheckUpdate.textContent = `v${payload.version} 다운로드`;
        setUpdateStatus(`새 버전 v${payload.version}이 있습니다.`, 'ready');
        break;
      case 'downloading':
        updateState = 'downloading';
        btnCheckUpdate.disabled = true;
        btnCheckUpdate.textContent = `다운로드 중... ${payload.percent}%`;
        setUpdateStatus(`다운로드 중... ${payload.percent}%`);
        break;
      case 'downloaded':
        updateState = 'downloaded';
        btnCheckUpdate.disabled = false;
        btnCheckUpdate.textContent = '재시작 후 설치';
        setUpdateStatus('다운로드 완료. 재시작하면 설치됩니다.', 'ready');
        break;
      case 'error':
        updateState = 'idle';
        btnCheckUpdate.disabled = false;
        btnCheckUpdate.textContent = '업데이트 확인';
        setUpdateStatus(payload.message || '업데이트 확인 중 오류가 발생했습니다.', 'error');
        break;
    }
  });

  btnCheckUpdate.addEventListener('click', async () => {
    if (updateState === 'available') {
      await window.api.downloadUpdate();
      return;
    }
    if (updateState === 'downloaded') {
      await window.api.installUpdate();
      return;
    }
    const result = await window.api.checkForUpdate();
    if (result && result.status === 'dev-mode') {
      setUpdateStatus('개발 모드에서는 업데이트 확인을 지원하지 않습니다.');
    }
  });

  // ---------- 설정 page toggles ----------
  // trayOnClose / introEnabled / autoUpdateCheck have no other renderer-side
  // effect — they're only persisted here and read directly by main.js out of
  // the settings file (close handler, splash-window creation, startup check).
  function setToggleUI(btn, on) {
    btn.classList.toggle('on', on);
  }

  toggleTray.addEventListener('click', () => {
    state.trayOnClose = !state.trayOnClose;
    setToggleUI(toggleTray, state.trayOnClose);
    scheduleSave();
  });
  toggleIntro.addEventListener('click', () => {
    state.introEnabled = !state.introEnabled;
    setToggleUI(toggleIntro, state.introEnabled);
    scheduleSave();
  });
  toggleAutoUpdate.addEventListener('click', () => {
    state.autoUpdateCheck = !state.autoUpdateCheck;
    setToggleUI(toggleAutoUpdate, state.autoUpdateCheck);
    scheduleSave();
  });
  toggleWave.addEventListener('click', () => { userToggledWaveform = true; setWaveformEnabled(!state.waveformEnabled); });

  // ---------- Event wiring ----------
  btnAddFiles.addEventListener('click', async () => {
    const paths = await window.api.openFilesDialog();
    if (paths && paths.length) addFiles(paths);
  });

  btnClearList.addEventListener('click', clearPlaylist);

  searchInput.addEventListener('input', () => {
    state.filterQuery = searchInput.value;
    searchClear.hidden = !searchInput.value;
    renderPlaylist();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.stopPropagation(); searchClear.click(); }
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.filterQuery = '';
    searchClear.hidden = true;
    renderPlaylist();
    searchInput.focus();
  });

  btnPlay.addEventListener('click', togglePlay);
  btnNext.addEventListener('click', () => playNext(false));
  btnPrev.addEventListener('click', playPrev);

  btnRepeat.addEventListener('click', () => {
    state.repeatMode = state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off';
    updateRepeatButton();
    scheduleSave();
  });

  btnShuffle.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    btnShuffle.classList.toggle('active', state.shuffle);
    scheduleSave();
  });

  btnEqToggle.addEventListener('click', () => {
    state.eqEnabled = !state.eqEnabled;
    btnEqToggle.classList.toggle('on', state.eqEnabled);
    btnEqToggle.textContent = state.eqEnabled ? 'EQ ON' : 'EQ OFF';
    applyEqValues();
    scheduleSave();
  });

  btnWaveToggle.addEventListener('click', () => { userToggledWaveform = true; setWaveformEnabled(!state.waveformEnabled); });

  mediaEl.addEventListener('play', () => { setPlayIcon(true); broadcastState(); startRippleLoop(); });
  mediaEl.addEventListener('pause', () => { setPlayIcon(false); broadcastState(); stopRippleLoop(); });
  mediaEl.addEventListener('ended', () => playNext(true));

  mediaEl.addEventListener('loadedmetadata', () => {
    durTimeEl.textContent = fmtTime(mediaEl.duration);
    updateCoverVisibility(false);
  });

  // timeupdate fires many times a second; broadcastState() is throttled to
  // every 500ms so the overlay's progress bar still feels live without
  // flooding the IPC channel (the audio-level pings on a separate, faster
  // channel — see broadcastLevel() above).
  let lastOverlayBroadcast = 0;
  mediaEl.addEventListener('timeupdate', () => {
    if (state.seeking) return;
    curTimeEl.textContent = fmtTime(mediaEl.currentTime);
    if (mediaEl.duration) {
      const pct = (mediaEl.currentTime / mediaEl.duration) * 1000;
      seekBar.value = String(pct);
      updateRangeFill(seekBar);
    }
    updateActiveLyricsLine();
    const now = Date.now();
    if (now - lastOverlayBroadcast > 500) {
      lastOverlayBroadcast = now;
      broadcastState();
    }
  });

  seekBar.addEventListener('input', () => {
    state.seeking = true;
    updateRangeFill(seekBar);
  });
  seekBar.addEventListener('change', () => {
    if (mediaEl.duration) {
      mediaEl.currentTime = (Number(seekBar.value) / 1000) * mediaEl.duration;
    }
    state.seeking = false;
  });

  volumeBar.addEventListener('input', () => {
    mediaEl.volume = Number(volumeBar.value) / 100;
    updateRangeFill(volumeBar);
    broadcastState();
    scheduleSave();
  });

  eqSliderEls.forEach((slider, i) => {
    slider.addEventListener('input', () => {
      applyEqBand(i, slider.value);
      clearPreset();
      scheduleSave();
      broadcastState();
    });
  });

  reverbSlider.addEventListener('input', () => {
    applyReverb(reverbSlider.value);
    clearPreset();
    scheduleSave();
    broadcastState();
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = EQ_PRESETS[btn.dataset.preset];
      if (!p) return;
      p.bands.forEach((value, i) => applyEqBand(i, value));
      applyReverb(p.reverb);
      state.currentPreset = btn.dataset.preset;
      updatePresetButtons();
      scheduleSave();
      broadcastState();
    });
  });

  // Drag & drop support
  ['dragenter', 'dragover'].forEach((evt) => {
    document.body.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map((f) => f.path).filter(Boolean);
    if (paths.length) addFiles(paths);
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') { mediaEl.currentTime = Math.min(mediaEl.duration || 0, mediaEl.currentTime + 5); }
    else if (e.code === 'ArrowLeft') { mediaEl.currentTime = Math.max(0, mediaEl.currentTime - 5); }
  });

  // Init
  setPlayIcon(false);
  volumeBar.value = 80;
  mediaEl.volume = 0.8;
  [seekBar, volumeBar, reverbSlider].forEach(updateRangeFill);
  updateRepeatButton();
  updateCoverVisibility(true);
  renderPlaylistTabs();
  restoreSettings();
})();
