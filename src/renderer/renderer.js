(() => {
  'use strict';

  // ---------- State ----------
  const state = {
    tracks: [],        // { path, name }
    currentIndex: -1,
    repeatMode: 'off',  // off -> all -> one
    shuffle: false,
    eqEnabled: true,
    seeking: false
  };

  // ---------- Elements ----------
  const mediaEl = document.getElementById('mediaEl');
  const coverArt = document.getElementById('coverArt');
  const playlistEl = document.getElementById('playlist');
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

  const appVersionEl = document.getElementById('appVersion');
  const btnCheckUpdate = document.getElementById('btnCheckUpdate');
  const updateStatusEl = document.getElementById('updateStatus');

  const eqBandsEl = document.getElementById('eqBands');
  const reverbSlider = document.getElementById('reverbSlider');
  const valReverb = document.getElementById('valReverb');

  const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv']);

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
  const EQ_MIN = -24;
  const EQ_MAX = 24;

  const eqSliderEls = [];
  const eqValEls = [];
  EQ_BANDS.forEach((band, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'eq-band';

    const val = document.createElement('span');
    val.className = 'eq-val';
    val.textContent = '0';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(EQ_MIN);
    input.max = String(EQ_MAX);
    input.step = '1';
    input.value = '0';
    input.id = `eqSlider${i}`;

    const freq = document.createElement('span');
    freq.className = 'eq-freq';
    freq.textContent = band.label;

    wrap.appendChild(val);
    wrap.appendChild(input);
    wrap.appendChild(freq);
    eqBandsEl.appendChild(wrap);

    eqSliderEls.push(input);
    eqValEls.push(val);
  });

  // ---------- Web Audio EQ chain ----------
  let audioCtx = null;
  let sourceNode = null;
  let eqFilters = [];
  let dryGain, wetGain, convolver, masterGain, limiter;

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
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
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

    applyEqValues();
  }

  function applyEqValues() {
    if (!audioCtx) return;
    const enabled = state.eqEnabled;
    eqFilters.forEach((filter, i) => {
      filter.gain.value = enabled ? Number(eqSliderEls[i].value) : 0;
    });
    const wet = enabled ? (Number(reverbSlider.value) / 100) * 0.7 : 0;
    wetGain.gain.value = wet;
    dryGain.gain.value = 0.92; // small constant headroom so wet doesn't clip; independent of reverb amount
  }

  // ---------- Playlist helpers ----------
  function extOf(p) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(p);
    return m ? m[1].toLowerCase() : '';
  }

  function baseName(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function addFiles(paths) {
    let added = 0;
    for (const p of paths) {
      if (!p) continue;
      state.tracks.push({ path: p, name: baseName(p) });
      added++;
    }
    if (added) renderPlaylist();
    if (state.currentIndex === -1 && state.tracks.length) {
      loadTrack(0, false);
    }
    scheduleSave();
  }

  function renderPlaylist() {
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

      const remove = document.createElement('span');
      remove.className = 'remove';
      remove.textContent = '✕';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(i);
      });

      li.appendChild(idx);
      li.appendChild(name);
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
      trackSub.textContent = ' ';
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
    trackSub.textContent = ' ';
    updateCoverVisibility(true);
    renderPlaylist();
    setPlayIcon(false);
    broadcastState();
    scheduleSave();
  }

  function updateCoverVisibility(forceCover) {
    const ext = state.currentIndex >= 0 ? extOf(state.tracks[state.currentIndex].path) : '';
    const isVideo = VIDEO_EXT.has(ext) && mediaEl.videoWidth > 0;
    if (forceCover || !isVideo) {
      coverArt.classList.remove('hidden');
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
    btnPlay.textContent = playing ? '⏸' : '▶';
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

  const REPEAT_LABELS = { off: '🔁', all: '🔁', one: '🔂' };

  function updateRepeatButton() {
    btnRepeat.textContent = REPEAT_LABELS[state.repeatMode];
    btnRepeat.classList.toggle('active', state.repeatMode !== 'off');
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
      volume: mediaEl.volume
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
  let readyToSave = false;
  let saveTimer = null;

  function gatherSettings() {
    return {
      tracks: state.tracks,
      currentIndex: state.currentIndex,
      repeatMode: state.repeatMode,
      shuffle: state.shuffle,
      eqEnabled: state.eqEnabled,
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
          eqSliderEls.forEach((s, i) => {
            s.value = data.eq.bands[i] ?? 0;
            eqValEls[i].textContent = s.value;
          });
        }
        reverbSlider.value = data.eq.reverb ?? 0;
        valReverb.textContent = `${reverbSlider.value} %`;
      }
      if (typeof data.eqEnabled === 'boolean') {
        state.eqEnabled = data.eqEnabled;
        btnEqToggle.classList.toggle('on', state.eqEnabled);
        btnEqToggle.textContent = state.eqEnabled ? 'EQ ON' : 'EQ OFF';
      }
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
      [reverbSlider, volumeBar].forEach(updateRangeFill);

      if (Array.isArray(data.tracks) && data.tracks.length) {
        state.tracks = data.tracks;
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

  mediaEl.addEventListener('play', () => { setPlayIcon(true); broadcastState(); });
  mediaEl.addEventListener('pause', () => { setPlayIcon(false); broadcastState(); });
  mediaEl.addEventListener('ended', () => playNext(true));

  mediaEl.addEventListener('loadedmetadata', () => {
    durTimeEl.textContent = fmtTime(mediaEl.duration);
    updateCoverVisibility(false);
  });

  mediaEl.addEventListener('timeupdate', () => {
    if (state.seeking) return;
    curTimeEl.textContent = fmtTime(mediaEl.currentTime);
    if (mediaEl.duration) {
      const pct = (mediaEl.currentTime / mediaEl.duration) * 1000;
      seekBar.value = String(pct);
      updateRangeFill(seekBar);
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
      eqValEls[i].textContent = slider.value;
      applyEqValues();
      scheduleSave();
    });
  });

  function wireEqSlider(slider, label, unit, fmt) {
    slider.addEventListener('input', () => {
      label.textContent = fmt ? fmt(slider.value) : `${slider.value}${unit}`;
      updateRangeFill(slider);
      applyEqValues();
      scheduleSave();
    });
  }
  wireEqSlider(reverbSlider, valReverb, ' %');

  // Band order: 60, 150, 400, 1K, 2.5K, 6K, 12K, 16K
  const EQ_PRESETS = {
    flat: { bands: [0, 0, 0, 0, 0, 0, 0, 0], reverb: 0 },
    bassBoost: { bands: [16, 10, 3, 0, 0, 0, 0, 0], reverb: 8 },
    vocal: { bands: [-6, -3, -2, 3, 6, 4, 1, 0], reverb: 10 },
    hall: { bands: [1, 0, 0, 0, 0, 2, 3, 2], reverb: 65 }
  };

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = EQ_PRESETS[btn.dataset.preset];
      if (!p) return;
      eqSliderEls.forEach((slider, i) => {
        slider.value = p.bands[i];
        eqValEls[i].textContent = slider.value;
      });
      reverbSlider.value = p.reverb;
      updateRangeFill(reverbSlider);
      valReverb.textContent = p.reverb + ' %';
      applyEqValues();
      scheduleSave();
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
  volumeBar.value = 80;
  mediaEl.volume = 0.8;
  [seekBar, volumeBar, reverbSlider].forEach(updateRangeFill);
  updateRepeatButton();
  updateCoverVisibility(true);
  restoreSettings();
})();
