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

  const bassSlider = document.getElementById('bassSlider');
  const midSlider = document.getElementById('midSlider');
  const trebleSlider = document.getElementById('trebleSlider');
  const reverbSlider = document.getElementById('reverbSlider');
  const valBass = document.getElementById('valBass');
  const valMid = document.getElementById('valMid');
  const valTreble = document.getElementById('valTreble');
  const valReverb = document.getElementById('valReverb');

  const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv']);

  // ---------- Web Audio EQ chain ----------
  let audioCtx = null;
  let sourceNode = null;
  let bassFilter, midFilter, trebleFilter;
  let dryGain, wetGain, convolver, masterGain;

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

    bassFilter = audioCtx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 150;

    midFilter = audioCtx.createBiquadFilter();
    midFilter.type = 'peaking';
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 0.9;

    trebleFilter = audioCtx.createBiquadFilter();
    trebleFilter.type = 'highshelf';
    trebleFilter.frequency.value = 3500;

    convolver = audioCtx.createConvolver();
    convolver.buffer = buildImpulseResponse(audioCtx, 2.5, 2.2);

    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    wetGain.gain.value = 0;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;

    // source -> bass -> mid -> treble -> [dry + convolver->wet] -> master -> destination
    sourceNode.connect(bassFilter);
    bassFilter.connect(midFilter);
    midFilter.connect(trebleFilter);

    trebleFilter.connect(dryGain);
    trebleFilter.connect(convolver);
    convolver.connect(wetGain);

    dryGain.connect(masterGain);
    wetGain.connect(masterGain);
    masterGain.connect(audioCtx.destination);

    applyEqValues();
  }

  function applyEqValues() {
    if (!audioCtx) return;
    const enabled = state.eqEnabled;
    bassFilter.gain.value = enabled ? Number(bassSlider.value) : 0;
    midFilter.gain.value = enabled ? Number(midSlider.value) : 0;
    trebleFilter.gain.value = enabled ? Number(trebleSlider.value) : 0;
    const wet = enabled ? Number(reverbSlider.value) / 100 : 0;
    wetGain.gain.value = wet;
    dryGain.gain.value = 1 - wet * 0.6;
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
        bass: Number(bassSlider.value),
        mid: Number(midSlider.value),
        treble: Number(trebleSlider.value),
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
        bassSlider.value = data.eq.bass ?? 0;
        midSlider.value = data.eq.mid ?? 0;
        trebleSlider.value = data.eq.treble ?? 0;
        reverbSlider.value = data.eq.reverb ?? 0;
        valBass.textContent = `${bassSlider.value} dB`;
        valMid.textContent = `${midSlider.value} dB`;
        valTreble.textContent = `${trebleSlider.value} dB`;
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
      [bassSlider, midSlider, trebleSlider, reverbSlider, volumeBar].forEach(updateRangeFill);

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

  function wireEqSlider(slider, label, unit, fmt) {
    slider.addEventListener('input', () => {
      label.textContent = fmt ? fmt(slider.value) : `${slider.value}${unit}`;
      updateRangeFill(slider);
      applyEqValues();
      scheduleSave();
    });
  }
  wireEqSlider(bassSlider, valBass, ' dB');
  wireEqSlider(midSlider, valMid, ' dB');
  wireEqSlider(trebleSlider, valTreble, ' dB');
  wireEqSlider(reverbSlider, valReverb, ' %');

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presets = {
        flat: { bass: 0, mid: 0, treble: 0, reverb: 0 },
        bassBoost: { bass: 9, mid: 1, treble: 0, reverb: 5 },
        vocal: { bass: -3, mid: 6, treble: 3, reverb: 8 },
        hall: { bass: 1, mid: 0, treble: 2, reverb: 55 }
      };
      const p = presets[btn.dataset.preset];
      if (!p) return;
      bassSlider.value = p.bass;
      midSlider.value = p.mid;
      trebleSlider.value = p.treble;
      reverbSlider.value = p.reverb;
      [bassSlider, midSlider, trebleSlider, reverbSlider].forEach(updateRangeFill);
      valBass.textContent = p.bass + ' dB';
      valMid.textContent = p.mid + ' dB';
      valTreble.textContent = p.treble + ' dB';
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
  [seekBar, volumeBar, bassSlider, midSlider, trebleSlider, reverbSlider].forEach(updateRangeFill);
  updateRepeatButton();
  updateCoverVisibility(true);
  restoreSettings();
})();
