(() => {
  'use strict';

  const titleEl = document.getElementById('title');
  const btnPlay = document.getElementById('btnPlay');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnClose = document.getElementById('btnClose');
  const volume = document.getElementById('volume');
  const seekBar = document.getElementById('seekBar');
  const curTimeEl = document.getElementById('curTime');
  const durTimeEl = document.getElementById('durTime');

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

  let volumeDragging = false;
  let seekDragging = false;
  let lastDuration = 0;

  window.overlayApi.onState((state) => {
    titleEl.textContent = state.title
      ? `${state.title}${state.total ? ` (${state.index + 1}/${state.total})` : ''}`
      : '재생 중인 곡 없음';
    btnPlay.textContent = state.playing ? '⏸' : '▶';
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

  updateRangeFill(volume);
  updateRangeFill(seekBar);
})();
