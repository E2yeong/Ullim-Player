(async () => {
  'use strict';

  const video = document.getElementById('introVideo');
  const skipBtn = document.getElementById('skipBtn');

  const done = () => window.splashApi.done();

  video.addEventListener('ended', done);
  video.addEventListener('error', done);
  skipBtn.addEventListener('click', done);

  try {
    const url = await window.splashApi.getVideoUrl();
    video.src = url;
  } catch {
    done();
  }
})();
