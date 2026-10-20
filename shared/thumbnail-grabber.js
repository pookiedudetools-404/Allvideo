// tools/thumbnail-grabber.js — Video Thumbnail Grabber

import {
  showToast,
  escapeHtml,
  formatBytes,
  formatDuration,
  isValidUrl,
  detectMediaFormat,
  inferFilename,
  downloadBlob,
  createObjectURL,
  revokeObjectURL,
  createAbortRegistry,
  loadScriptOnce,
} from '../shared/utils.js';

const STATE = {
  objectUrl: null,
  videoEl: null,
  loaded: false,
  filename: '',
  capturedFrames: [],
  abort: createAbortRegistry(),
};

export function cleanup() {
  STATE.abort.abortAll();
  if (STATE.objectUrl) {
    revokeObjectURL(STATE.objectUrl);
    STATE.objectUrl = null;
  }
  STATE.loaded = false;
  STATE.capturedFrames = [];
}

function setStatus(msg, kind = 'info') {
  const box = document.getElementById('tg-status');
  if (!box) return;
  const colors = {
    info: 'border-slate-700 bg-slate-800/50 text-slate-300',
    success: 'border-emerald-700 bg-emerald-900/30 text-emerald-200',
    warning: 'border-amber-700 bg-amber-900/30 text-amber-200',
    error: 'border-red-700 bg-red-900/30 text-red-200',
  };
  box.className = `mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed ${colors[kind] || colors.info}`;
  box.innerHTML = escapeHtml(msg).replace(/\n/g, '<br>');
  box.classList.remove('hidden');
}

function clearStatus() {
  const box = document.getElementById('tg-status');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function setBusy(busy, label = '') {
  const loadBtn = document.getElementById('tg-load-btn');
  const input = document.getElementById('tg-url-input');
  const spinner = document.getElementById('tg-spinner');
  const text = document.getElementById('tg-load-text');
  if (loadBtn) loadBtn.disabled = busy;
  if (input) input.disabled = busy;
  if (spinner) spinner.classList.toggle('hidden', !busy);
  if (text) text.textContent = busy ? (label || 'Loading…') : 'Load Video';
}

async function handleLoad() {
  const input = document.getElementById('tg-url-input');
  const url = (input?.value || '').trim();
  if (!isValidUrl(url)) {
    setStatus('❌ Please paste a valid video URL.', 'error');
    return;
  }

  clearStatus();
  if (STATE.objectUrl) {
    revokeObjectURL(STATE.objectUrl);
    STATE.objectUrl = null;
  }
  STATE.loaded = false;
  STATE.capturedFrames = [];
  document.getElementById('tg-capture-panel')?.classList.add('hidden');
  document.getElementById('tg-gallery')?.classList.add('hidden');

  const detected = detectMediaFormat(url);
  setBusy(true, 'Loading video…');
  setStatus('Loading video metadata…', 'info');

  const video = document.getElementById('tg-video');
  const wrap = document.getElementById('tg-video-wrap');

  try {
    if (detected.format === 'hls') {
      setStatus('HLS stream detected. Loading via hls.js…', 'info');
      const Hls = await loadScriptOnce('https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js', 'Hls');
      wrap.classList.remove('hidden');
      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        await new Promise((resolve, reject) => {
          hls.on(Hls.Events.MANIFEST_PARSED, resolve);
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) reject(new Error('HLS load error'));
          });
          setTimeout(() => reject(new Error('HLS load timeout')), 15000);
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
      } else {
        throw new Error('HLS not supported in this browser.');
      }
      STATE.filename = `hls_frame_${Date.now()}`;
    } else {
      video.src = url;
      video.crossOrigin = 'anonymous';
      wrap.classList.remove('hidden');
      await new Promise((resolve, reject) => {
        const onOk = () => { cleanup(); resolve(); };
        const onErr = () => { cleanup(); reject(new Error('Video failed to load — host may block CORS. Try a direct .mp4 link.')); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Load timeout (15s)')); }, 15000);
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onOk);
          video.removeEventListener('error', onErr);
          clearTimeout(timer);
        };
        video.addEventListener('loadedmetadata', onOk, { once: true });
        video.addEventListener('error', onErr, { once: true });
      });
      STATE.filename = inferFilename(url, 'video/mp4').replace(/\.[^.]+$/, '');
    }

    STATE.loaded = true;
    const dur = formatDuration(video.duration);
    setStatus(`✅ Video loaded · Duration: ${dur} · ${video.videoWidth}×${video.videoHeight}`, 'success');

    const seekInput = document.getElementById('tg-seek');
    if (seekInput && isFinite(video.duration)) {
      seekInput.max = video.duration;
      seekInput.value = Math.min(video.duration / 2, video.duration);
      updateSeekLabel();
    }
    document.getElementById('tg-capture-panel')?.classList.remove('hidden');
    showToast('Video loaded — move the slider and capture frames.', 'success');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(
      `❌ ${err.message}\n\nIf the host blocks cross-origin access, thumbnails cannot be captured directly. Try a direct .mp4 URL or use the Universal Downloader first, then load the local file.`,
      'error'
    );
  } finally {
    setBusy(false);
  }
}

function updateSeekLabel() {
  const seek = document.getElementById('tg-seek');
  const label = document.getElementById('tg-seek-label');
  if (!seek || !label) return;
  label.textContent = formatDuration(parseFloat(seek.value) || 0);
}

function seekTo(value) {
  const video = document.getElementById('tg-video');
  if (!video || !STATE.loaded) return;
  const t = Math.max(0, Math.min(parseFloat(value) || 0, video.duration || 0));
  try { video.currentTime = t; } catch { /* ignore */ }
  updateSeekLabel();
}

async function seekAndWait(time) {
  const video = document.getElementById('tg-video');
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      setTimeout(resolve, 120);
    };
    const timer = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      reject(new Error('Seek timeout'));
    }, 6000);
    video.addEventListener('seeked', onSeeked, { once: true });
    try { video.currentTime = time; } catch (e) { reject(e); }
  });
}

async function captureFrame({ time = null, label = null, silent = false } = {}) {
  const video = document.getElementById('tg-video');
  if (!video || !STATE.loaded) {
    if (!silent) showToast('Load a video first.', 'warning');
    return null;
  }

  try {
    if (time != null) await seekAndWait(time);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png', 1.0));
    const filename = `${STATE.filename || 'frame'}_${Math.round(video.currentTime * 1000)}ms.png`;

    const frame = {
      id: `frame_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      time: video.currentTime,
      dataUrl,
      blob,
      filename,
      width: canvas.width,
      height: canvas.height,
    };

    STATE.capturedFrames.unshift(frame);
    renderGallery();

    if (!silent) showToast('Frame captured ✅', 'success');
    return frame;
  } catch (err) {
    console.error('Capture error:', err);
    if (!silent) {
      setStatus(
        `❌ Failed to capture frame: ${err.message}\n\nThis usually means the video host doesn't allow cross-origin canvas access (CORS). Download the video first with the Universal Downloader, then use the local file.`,
        'error'
      );
    }
    return null;
  }
}

function renderGallery() {
  const gallery = document.getElementById('tg-gallery');
  const list = document.getElementById('tg-gallery-list');
  const count = document.getElementById('tg-gallery-count');
  if (!gallery || !list) return;

  if (STATE.capturedFrames.length === 0) {
    gallery.classList.add('hidden');
    return;
  }
  gallery.classList.remove('hidden');
  if (count) count.textContent = STATE.capturedFrames.length;

  list.innerHTML = STATE.capturedFrames.map((f) => `
    <div class="group rounded-xl bg-slate-900 border border-slate-800 overflow-hidden flex flex-col">
      <div class="relative aspect-video bg-black">
        <img src="${f.dataUrl}" alt="Frame at ${formatDuration(f.time)}" class="w-full h-full object-contain" loading="lazy" />
        <span class="absolute top-1.5 left-1.5 px-2 py-0.5 text-[10px] font-bold rounded bg-slate-950/80 text-slate-200">${formatDuration(f.time)}</span>
      </div>
      <div class="p-2 flex items-center justify-between gap-1">
        <span class="text-[10px] text-slate-500">${f.width}×${f.height}</span>
        <div class="flex gap-1">
          <button data-save-id="${f.id}" class="tg-save-btn px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold">Save</button>
          <button data-del-id="${f.id}" class="tg-del-btn px-2 py-1 rounded-md bg-slate-800 hover:bg-red-600 text-slate-300 text-[10px] font-semibold">✕</button>
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.tg-save-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const frame = STATE.capturedFrames.find((f) => f.id === btn.dataset.saveId);
      if (frame) {
        downloadBlob(frame.blob, frame.filename);
        showToast('Frame saved', 'success');
      }
    });
  });
  list.querySelectorAll('.tg-del-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.capturedFrames = STATE.capturedFrames.filter((f) => f.id !== btn.dataset.delId);
      renderGallery();
    });
  });
}

async function captureBatch() {
  const video = document.getElementById('tg-video');
  if (!video || !STATE.loaded || !isFinite(video.duration)) {
    showToast('Load a video first.', 'warning');
    return;
  }
  const countInput = document.getElementById('tg-batch-count');
  const n = Math.min(50, Math.max(1, parseInt(countInput?.value || '5', 10) || 5));
  const originalTime = video.currentTime;
  setStatus(`Capturing ${n} frames evenly across the video…`, 'info');

  let captured = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * video.duration;
    const f = await captureFrame({ time: t, silent: true });
    if (f) captured++;
    setStatus(`Capturing frames… ${i + 1}/${n}`, 'info');
  }
  try { video.currentTime = originalTime; } catch { /* ignore */ }
  setStatus(`✅ Captured ${captured} of ${n} frames.`, 'success');
  showToast(`${captured} frames captured`, 'success');
}

function downloadAll() {
  if (STATE.capturedFrames.length === 0) {
    showToast('No frames captured yet.', 'warning');
    return;
  }
  STATE.capturedFrames.forEach((f, i) => {
    setTimeout(() => downloadBlob(f.blob, f.filename), i * 250);
  });
  showToast(`Saving ${STATE.capturedFrames.length} frames…`, 'info');
}

export default async function render(container) {
  if (!container) return;
  cleanup();

  container.innerHTML = `
    <div class="space-y-5 fade-in">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2">
            <span>🖼️</span> Thumbnail Grabber
          </h2>
          <p class="text-sm text-slate-400 mt-1">Scrub any video and capture high-quality PNG frames at any timestamp.</p>
        </div>
        <button onclick="goHome()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">
          ← Back
        </button>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <label for="tg-url-input" class="block text-xs font-bold uppercase tracking-wider text-slate-400">Video URL</label>
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            id="tg-url-input"
            type="url"
            placeholder="https://example.com/video.mp4"
            class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="tg-load-btn" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed min-w-[160px]">
            <svg id="tg-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
            <span id="tg-load-text">Load Video</span>
          </button>
        </div>
        <div id="tg-status" class="hidden mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed"></div>
      </div>

      <div id="tg-video-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4">
        <video id="tg-video" controls playsinline preload="metadata" class="w-full rounded-lg bg-black max-h-[420px]"></video>
      </div>

      <div id="tg-capture-panel" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-bold uppercase tracking-wider text-slate-400">Seek Position</label>
            <span id="tg-seek-label" class="text-xs font-mono text-indigo-300">0:00</span>
          </div>
          <input id="tg-seek" type="range" min="0" max="100" step="0.05" value="0" class="w-full accent-indigo-500" />
        </div>

        <div class="flex flex-wrap gap-2">
          <button id="tg-capture-current-btn" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition">
            📸 Capture Current Frame
          </button>
          <button id="tg-prev-btn" class="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">← Prev</button>
          <button id="tg-next-btn" class="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">Next →</button>
        </div>

        <div class="border-t border-slate-800 pt-4">
          <label class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 block">Batch Capture</label>
          <div class="flex flex-wrap items-center gap-2">
            <input id="tg-batch-count" type="number" min="1" max="50" value="5" class="w-20 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500" />
            <button id="tg-batch-btn" class="px-5 py-2.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-sm font-semibold transition">
              🎬 Capture Frames
            </button>
            <button id="tg-download-all-btn" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition">
              💾 Save All
            </button>
          </div>
        </div>
      </div>

      <div id="tg-gallery" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Captured Frames (<span id="tg-gallery-count">0</span>)</h3>
        </div>
        <div id="tg-gallery-list" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"></div>
      </div>

      <div class="rounded-xl bg-slate-900/40 border border-slate-800/60 px-4 py-3 text-xs text-slate-500 leading-relaxed">
        <strong class="text-slate-400">Tip:</strong> If frames fail to capture with a CORS error, the video host blocks cross-origin canvas access. Download the video first with the Universal Downloader, then load the local file here.
      </div>
    </div>
  `;

  const video = document.getElementById('tg-video');
  const seek = document.getElementById('tg-seek');

  document.getElementById('tg-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleLoad(); }
  });
  document.getElementById('tg-load-btn')?.addEventListener('click', handleLoad);
  seek?.addEventListener('input', (e) => seekTo(e.target.value));

  document.getElementById('tg-capture-current-btn')?.addEventListener('click', () => captureFrame());
  document.getElementById('tg-prev-btn')?.addEventListener('click', () => {
    if (!STATE.loaded) return;
    const t = Math.max(0, video.currentTime - 1);
    seekTo(t);
    if (seek) seek.value = t;
  });
  document.getElementById('tg-next-btn')?.addEventListener('click', () => {
    if (!STATE.loaded) return;
    const t = Math.min(video.duration || 0, video.currentTime + 1);
    seekTo(t);
    if (seek) seek.value = t;
  });
  document.getElementById('tg-batch-btn')?.addEventListener('click', captureBatch);
  document.getElementById('tg-download-all-btn')?.addEventListener('click', downloadAll);

  video?.addEventListener('timeupdate', () => {
    if (seek && document.activeElement !== seek) {
      seek.value = video.currentTime;
      updateSeekLabel();
    }
  });
        }
