// Overlay (mini player) renderer. This window is a thin remote control: it
// never touches audio/playback directly. Button/slider interactions send
// commands to the main window via window.overlayApi.sendCommand(), and the
// main window is the source of truth — it echoes the real state back through
// onState()/onLevel(), which is what actually moves these sliders/labels.
(() => {
  'use strict';

  const panelEl = document.querySelector('.panel');
  const titleEl = document.getElementById('title');
  const dotEl = document.querySelector('.dot');
  const btnPlay = document.getElementById('btnPlay');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnClose = document.getElementById('btnClose');
  const volume = document.getElementById('volume');
  const seekBar = document.getElementById('seekBar');
  const curTimeEl = document.getElementById('curTime');
  const durTimeEl = document.getElementById('durTime');
  const eqMiniBandsEl = document.getElementById('eqMiniBands');
  const miniReverb = document.getElementById('miniReverb');

  // must match src/renderer/renderer.js EQ_BANDS
  const EQ_BAND_LABELS = ['60', '150', '400', '1K', '2.5K', '6K', '12K', '16K'];
  const EQ_MIN = -36;
  const EQ_MAX = 36;

  // Same icon markup as the main window's PLAY_ICON/PAUSE_ICON (src/renderer/renderer.js).
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

  // While the user is actively dragging a slider, incoming onState() updates
  // for that control are skipped so they don't fight the drag and make the
  // thumb jump around mid-gesture.
  let volumeDragging = false;
  let seekDragging = false;
  let eqDragging = false;
  let lastDuration = 0;

  const miniSliders = [];
  EQ_BAND_LABELS.forEach((label, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'eq-mini-band';

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'eq-mini-slider-wrap';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(EQ_MIN);
    input.max = String(EQ_MAX);
    input.step = '1';
    input.value = '0';

    sliderWrap.appendChild(input);

    const freq = document.createElement('span');
    freq.className = 'eq-mini-freq';
    freq.textContent = label;

    wrap.appendChild(sliderWrap);
    wrap.appendChild(freq);
    eqMiniBandsEl.appendChild(wrap);
    miniSliders.push(input);

    input.addEventListener('mousedown', () => { eqDragging = true; });
    input.addEventListener('mouseup', () => { eqDragging = false; });
    input.addEventListener('input', () => {
      updateRangeFill(input);
      window.overlayApi.sendCommand({ type: 'eq-band', index: i, value: Number(input.value) });
    });
  });

  // The mini sliders are rotated horizontal inputs (see the note in
  // overlay.css), so their pre-rotation `width` is what becomes their
  // vertical length on screen. The wrap's height is flexible (the overlay
  // can be resized), so that width has to be set in JS to match — called
  // once the bands exist and again whenever the panel's layout changes.
  function syncMiniSliderSizes() {
    miniSliders.forEach((input) => {
      const wrapHeight = input.parentElement.clientHeight;
      if (wrapHeight > 0) input.style.width = wrapHeight + 'px';
    });
  }

  function updateRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  window.overlayApi.onState((state) => {
    titleEl.textContent = state.title
      ? `${state.title}${state.total ? ` (${state.index + 1}/${state.total})` : ''}`
      : '재생 중인 곡 없음';
    btnPlay.innerHTML = state.playing ? PAUSE_ICON : PLAY_ICON;
    if (!volumeDragging && typeof state.volume === 'number') {
      volume.value = String(Math.round(state.volume * 100));
      updateRangeFill(volume);
    }
    if (typeof state.duration === 'number') {
      lastDuration = state.duration;
      durTimeEl.textContent = fmtTime(state.duration);
    }
    if (!seekDragging && typeof state.currentTime === 'number') {
      curTimeEl.textContent = fmtTime(state.currentTime);
      if (lastDuration) {
        seekBar.value = String((state.currentTime / lastDuration) * 1000);
        updateRangeFill(seekBar);
      }
    }
    if (!eqDragging && state.eq) {
      if (Array.isArray(state.eq.bands)) {
        miniSliders.forEach((s, i) => {
          if (state.eq.bands[i] != null) {
            s.value = state.eq.bands[i];
            updateRangeFill(s);
          }
        });
      }
      if (typeof state.eq.reverb === 'number') {
        miniReverb.value = String(state.eq.reverb);
        updateRangeFill(miniReverb);
      }
    }
  });

  window.overlayApi.onLevel((level) => {
    const scale = 1 + Math.min(1, level) * 1.6;
    dotEl.style.transform = `scale(${scale})`;
    dotEl.style.boxShadow = `0 0 ${4 + level * 10}px rgba(108, 92, 231, ${0.4 + level * 0.5})`;
  });

  btnPlay.addEventListener('click', () => window.overlayApi.sendCommand({ type: 'toggle-play' }));
  btnPrev.addEventListener('click', () => window.overlayApi.sendCommand({ type: 'prev' }));
  btnNext.addEventListener('click', () => window.overlayApi.sendCommand({ type: 'next' }));
  btnClose.addEventListener('click', () => window.overlayApi.close());

  volume.addEventListener('mousedown', () => { volumeDragging = true; });
  volume.addEventListener('mouseup', () => { volumeDragging = false; });
  volume.addEventListener('input', () => {
    updateRangeFill(volume);
    window.overlayApi.sendCommand({ type: 'volume', value: Number(volume.value) / 100 });
  });

  seekBar.addEventListener('mousedown', () => { seekDragging = true; });
  seekBar.addEventListener('input', () => {
    updateRangeFill(seekBar);
    if (lastDuration) {
      curTimeEl.textContent = fmtTime((Number(seekBar.value) / 1000) * lastDuration);
    }
  });
  seekBar.addEventListener('change', () => {
    window.overlayApi.sendCommand({ type: 'seek', fraction: Number(seekBar.value) / 1000 });
    seekDragging = false;
  });

  miniReverb.addEventListener('mousedown', () => { eqDragging = true; });
  miniReverb.addEventListener('mouseup', () => { eqDragging = false; });
  miniReverb.addEventListener('input', () => {
    updateRangeFill(miniReverb);
    window.overlayApi.sendCommand({ type: 'eq-reverb', value: Number(miniReverb.value) });
  });

  // reveal the mini EQ panel once the user resizes the window tall enough for it
  const EXPAND_THRESHOLD = 260;
  function updateExpanded() {
    panelEl.classList.toggle('expanded', window.innerHeight >= EXPAND_THRESHOLD);
    syncMiniSliderSizes(); // the eq-mini area's rendered height just changed (or became visible)
  }
  window.addEventListener('resize', updateExpanded);
  updateExpanded();

  updateRangeFill(volume);
  updateRangeFill(seekBar);
  updateRangeFill(miniReverb);
  miniSliders.forEach(updateRangeFill);
})();
