(() => {
  'use strict';

  const titleEl = document.getElementById('title');
  const btnPlay = document.getElementById('btnPlay');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnClose = document.getElementById('btnClose');
  const volume = document.getElementById('volume');

  function updateRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  let volumeDragging = false;

  window.overlayApi.onState((state) => {
    titleEl.textContent = state.title
      ? `${state.title}${state.total ? ` (${state.index + 1}/${state.total})` : ''}`
      : '재생 중인 곡 없음';
    btnPlay.textContent = state.playing ? '⏸' : '▶';
    if (!volumeDragging && typeof state.volume === 'number') {
      volume.value = String(Math.round(state.volume * 100));
      updateRangeFill(volume);
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

  updateRangeFill(volume);
})();
