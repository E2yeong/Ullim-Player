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
  const state = {
    tracks: [],        // { path, name, durationSec }
    currentIndex: -1,
    repeatMode: 'off',  // off -> all -> one
    shuffle: false,
    eqEnabled: true,
    waveformEnabled: true,
    currentPreset: null, // EQ_PRESETS key, or null once the user hand-tweaks a slider
    trayOnClose: true,   // read directly by main.js's close handler via the settings file
    introEnabled: true,  // read directly by main.js before creating the splash window
    autoUpdateCheck: true, // read directly by main.js for the silent startup check
    seeking: false
  };

  // ---------- Elements ----------
  const mediaEl = document.getElementById('mediaEl');
  const coverArt = document.getElementById('coverArt');
  const playlistEl = document.getElementById('playlist');
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
  const presetLabelEl = document.getElementById('presetLabel');

  const appVersionEl = document.getElementById('appVersion');
  const btnCheckUpdate = document.getElementById('btnCheckUpdate');
  const updateStatusEl = document.getElementById('updateStatus');

  const toggleTray = document.getElementById('toggleTray');
  const toggleIntro = document.getElementById('toggleIntro');
  const toggleWave = document.getElementById('toggleWave');
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

  function addFiles(paths) {
    let added = 0;
    for (const p of paths) {
      if (!p) continue;
      const track = { path: p, name: baseName(p), durationSec: null };
      state.tracks.push(track);
      probeDuration(track);
      added++;
    }
    if (added) renderPlaylist();
    if (state.currentIndex === -1 && state.tracks.length) {
      loadTrack(0, false);
    }
    scheduleSave();
  }

  function renderPlaylist() {
    trackCountEl.textContent = state.tracks.length + '곡';

    playlistEl.innerHTML = '';
    state.tracks.forEach((track, i) => {
      const li = document.createElement('li');
      if (i === state.currentIndex) li.classList.add('active');

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = track.name;
      name.title = track.path;

      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = track.durationSec ? fmtTime(track.durationSec) : '';

      const remove = document.createElement('span');
      remove.className = 'remove';
      remove.textContent = '✕';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(i);
      });

      li.appendChild(idx);
      li.appendChild(name);
      li.appendChild(dur);
      li.appendChild(remove);
      li.addEventListener('click', () => loadTrack(i, true));

      playlistEl.appendChild(li);
    });
  }

  function removeTrack(i) {
    const wasCurrent = i === state.currentIndex;
    state.tracks.splice(i, 1);
    if (state.tracks.length === 0) {
      state.currentIndex = -1;
      mediaEl.removeAttribute('src');
      trackTitle.textContent = '재생할 파일을 선택하세요';
      trackSub.textContent = ' ';
      updateCoverVisibility(true);
      broadcastState();
    } else if (wasCurrent) {
      const next = Math.min(i, state.tracks.length - 1);
      loadTrack(next, true);
    } else if (i < state.currentIndex) {
      state.currentIndex--;
    }
    renderPlaylist();
    scheduleSave();
  }

  function clearPlaylist() {
    state.tracks = [];
    state.currentIndex = -1;
    mediaEl.pause();
    mediaEl.removeAttribute('src');
    trackTitle.textContent = '재생할 파일을 선택하세요';
    trackSub.textContent = ' ';
    updateCoverVisibility(true);
    renderPlaylist();
    setPlayIcon(false);
    broadcastState();
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

    const encoded = encodeURI(track.path.replace(/\\/g, '/'));
    mediaEl.src = 'file:///' + encoded.replace(/^\/+/, '');

    trackTitle.textContent = track.name;
    trackSub.textContent = `트랙 ${index + 1} / ${state.tracks.length}`;
    updateCoverVisibility(true);
    renderPlaylist();

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
    if (state.currentIndex === -1) {
      if (state.tracks.length) loadTrack(0, true);
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
    window.api.sendPlayerState({
      title: state.currentIndex >= 0 ? state.tracks[state.currentIndex].name : '',
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
      tracks: state.tracks,
      currentIndex: state.currentIndex,
      repeatMode: state.repeatMode,
      shuffle: state.shuffle,
      eqEnabled: state.eqEnabled,
      waveformEnabled: state.waveformEnabled,
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

      if (Array.isArray(data.tracks) && data.tracks.length) {
        state.tracks = data.tracks;
        // older saves predate the duration column — backfill it lazily.
        state.tracks.forEach((t) => { if (!t.durationSec) probeDuration(t); });
        renderPlaylist();
        const idx = typeof data.currentIndex === 'number' ? data.currentIndex : -1;
        if (idx >= 0 && idx < state.tracks.length) {
          loadTrack(idx, false);
        }
      }
    }

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
  restoreSettings();
})();
