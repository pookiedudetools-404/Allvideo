// tools/video-to-gif.js — Video to GIF converter

import {
  showToast,
  escapeHtml,
  formatBytes,
  formatDuration,
  isValidUrl,
  inferFilename,
  downloadBlob,
  createObjectURL,
  revokeObjectURL,
  createAbortRegistry,
  createProgressBarHTML,
  updateProgressBar,
  hideProgressBar,
} from '../shared/utils.js';

const STATE = {
  sourceUrl: null,
  ownObjectUrl: false,
  videoLoaded: false,
  baseName: 'clip',
  abort: createAbortRegistry(),
  busy: false,
  lastGifBlob: null,
};

export function cleanup() {
  STATE.abort.abortAll();
  if (STATE.ownObjectUrl && STATE.sourceUrl) {
    revokeObjectURL(STATE.sourceUrl);
  }
  STATE.sourceUrl = null;
  STATE.ownObjectUrl = false;
  STATE.videoLoaded = false;
  STATE.busy = false;
  STATE.lastGifBlob = null;
}

function setStatus(msg, kind = 'info') {
  const box = document.getElementById('v2g-status');
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
  const box = document.getElementById('v2g-status');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function setBusy(busy, label = '') {
  STATE.busy = busy;
  const spinner = document.getElementById('v2g-spinner');
  const text = document.getElementById('v2g-gen-text');
  const genBtn = document.getElementById('v2g-generate-btn');
  const loadBtn = document.getElementById('v2g-load-btn');
  if (spinner) spinner.classList.toggle('hidden', !busy);
  if (text) text.textContent = busy ? (label || 'Generating…') : 'Generate GIF';
  if (genBtn) genBtn.disabled = busy || !STATE.videoLoaded;
  if (loadBtn) loadBtn.disabled = busy;
}

function seekAndWait(video, time) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      reject(new Error('Seek timeout'));
    }, 8000);
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      setTimeout(resolve, 80);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    try { video.currentTime = time; } catch (e) { clearTimeout(timer); reject(e); }
  });
}

async function loadGifenc() {
  if (window.__gifencModule) return window.__gifencModule;
  const mod = await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm');
  window.__gifencModule = mod;
  return mod;
}

async function loadFromUrl() {
  if (STATE.busy) return;
  const input = document.getElementById('v2g-url-input');
  const url = (input?.value || '').trim();
  if (!isValidUrl(url)) {
    setStatus('❌ Please paste a valid video URL.', 'error');
    return;
  }
  clearStatus();
  loadVideoIntoPlayer(url, false, inferFilename(url, 'video/mp4').replace(/\.[^.]+$/, ''));
}

async function loadFromFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    setStatus('❌ Please choose a video file.', 'error');
    return;
  }
  clearStatus();
  if (STATE.ownObjectUrl && STATE.sourceUrl) revokeObjectURL(STATE.sourceUrl);
  const objUrl = createObjectURL(file);
  const name = (file.name || 'clip').replace(/\.[^.]+$/, '');
  loadVideoIntoPlayer(objUrl, true, name);
}

async function loadVideoIntoPlayer(url, isBlob, baseName) {
  const video = document.getElementById('v2g-video');
  const wrap = document.getElementById('v2g-video-wrap');
  const settings = document.getElementById('v2g-settings');
  STATE.videoLoaded = false;
  STATE.lastGifBlob = null;
  document.getElementById('v2g-preview-wrap')?.classList.add('hidden');
  hideProgressBar('v2g-progress');

  if (STATE.ownObjectUrl && STATE.sourceUrl && STATE.sourceUrl !== url) {
    revokeObjectURL(STATE.sourceUrl);
  }
  STATE.sourceUrl = url;
  STATE.ownObjectUrl = isBlob;
  STATE.baseName = baseName || 'clip';

  video.crossOrigin = 'anonymous';
  video.src = url;
  video.load();
  wrap.classList.remove('hidden');
  settings.classList.add('hidden');
  setStatus('Loading video metadata…', 'info');

  try {
    await new Promise((resolve, reject) => {
      const onMeta = () => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onError);
        clearTimeout(timer);
        resolve();
      };
      const onError = () => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onError);
        clearTimeout(timer);
        reject(new Error('Video failed to load — host may block CORS or the format is unsupported.'));
      };
      const timer = setTimeout(() => {
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onError);
        reject(new Error('Load timeout (15s)'));
      }, 15000);
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      video.addEventListener('error', onError, { once: true });
    });

    STATE.videoLoaded = true;
    const dur = video.duration;
    const startInput = document.getElementById('v2g-start');
    const endInput = document.getElementById('v2g-end');
    if (startInput) { startInput.value = '0'; startInput.max = isFinite(dur) ? dur : 10; }
    if (endInput) {
      endInput.value = isFinite(dur) ? Math.min(dur, 5) : 5;
      endInput.max = isFinite(dur) ? dur : 10;
    }
    updateRangeLabels();

    settings.classList.remove('hidden');
    setBusy(false);
    setStatus(`✅ Video ready · ${formatDuration(dur)} · ${video.videoWidth}×${video.videoHeight}`, 'success');
  } catch (err) {
    setStatus(
      `❌ ${err.message}\n\n` +
      `If the host blocks cross-origin access, the GIF encoder cannot read frames. ` +
      `Try uploading a local file instead — click "Choose File".`,
      'error'
    );
    setBusy(false);
  }
}

function updateRangeLabels() {
  const start = document.getElementById('v2g-start');
  const end = document.getElementById('v2g-end');
  const startLabel = document.getElementById('v2g-start-label');
  const endLabel = document.getElementById('v2g-end-label');
  if (start && startLabel) startLabel.textContent = formatDuration(parseFloat(start.value) || 0);
  if (end && endLabel) endLabel.textContent = formatDuration(parseFloat(end.value) || 0);
}

function readSettings() {
  const fps = Math.min(30, Math.max(1, parseInt(document.getElementById('v2g-fps')?.value || '10', 10) || 10));
  const width = Math.min(1280, Math.max(100, parseInt(document.getElementById('v2g-width')?.value || '480', 10) || 480));
  const colors = Math.min(256, Math.max(4, parseInt(document.getElementById('v2g-colors')?.value || '128', 10) || 128));
  const start = Math.max(0, parseFloat(document.getElementById('v2g-start')?.value || '0') || 0);
  const end = Math.max(start + 0.1, parseFloat(document.getElementById('v2g-end')?.value || '5') || 5);
  const loop = document.getElementById('v2g-loop')?.checked ?? true;
  const dither = document.getElementById('v2g-dither')?.checked ?? true;
  return { fps, width, colors, start, end, loop, dither };
}

async function generateGif() {
  if (STATE.busy || !STATE.videoLoaded) return;

  const video = document.getElementById('v2g-video');
  const { fps, width, colors, start, end, loop, dither } = readSettings();

  if (end - start < 0.1) {
    setStatus('❌ End time must be at least 0.1s after start time.', 'error');
    return;
  }
  if (end - start > 30) {
    setStatus('⚠️ Long GIFs may take a while and produce a large file. Consider trimming to under 15s for best results.', 'warning');
  }

  const duration = end - start;
  const frameCount = Math.max(1, Math.ceil(duration * fps));
  const delayMs = Math.round(1000 / fps);

  setBusy(true, 'Generating GIF…');
  clearStatus();
  setStatus(`Generating ${frameCount} frames at ${fps} FPS…`, 'info');
  document.getElementById('v2g-preview-wrap')?.classList.add('hidden');

  const ctrl = STATE.abort.newController();
  const originalTime = video.currentTime;

  try {
    const gifenc = await loadGifenc();
    const { GIFEncoder, quantize, applyPalette } = gifenc;
    if (!GIFEncoder) throw new Error('GIF library failed to load from CDN');

    const aspect = video.videoHeight / video.videoWidth;
    const outWidth = Math.round(width);
    const outHeight = Math.max(1, Math.round(outWidth * aspect));

    const canvas = document.createElement('canvas');
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const gif = GIFEncoder();

    for (let i = 0; i < frameCount; i++) {
      if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const t = start + (i / fps);
      if (t > end) break;
      await seekAndWait(video, Math.min(t, video.duration - 0.01));
      ctx.drawImage(video, 0, 0, outWidth, outHeight);
      const { data } = ctx.getImageData(0, 0, outWidth, outHeight);
      const palette = quantize(data, colors, { format: 'rgba4444' });
      const index = applyPalette(data, palette, 'rgba4444');
      const isLast = i === frameCount - 1;
      gif.writeFrame(index, outWidth, outHeight, {
        palette,
        delay: delayMs,
        repeat: loop ? 0 : (isLast ? undefined : 0),
        transparent: false,
        dispose: 1,
        dither: dither,
      });
      const pct = Math.round(((i + 1) / frameCount) * 95);
      updateProgressBar('v2g-progress', { percent: pct, received: 0, total: 0, label: `Frame ${i + 1}/${frameCount}` });
    }

    updateProgressBar('v2g-progress', { percent: 96, received: 0, total: 0, label: 'Finalizing…' });
    gif.finish();
    const bytes = gif.bytes();
    const blob = new Blob([bytes], { type: 'image/gif' });
    STATE.lastGifBlob = blob;

    updateProgressBar('v2g-progress', { percent: 100, received: blob.size, total: blob.size, label: 'Complete' });

    const previewImg = document.getElementById('v2g-preview-img');
    const previewWrap = document.getElementById('v2g-preview-wrap');
    const previewInfo = document.getElementById('v2g-preview-info');
    const oldSrc = previewImg?.src;
    if (previewImg && oldSrc && oldSrc.startsWith('blob:')) {
      revokeObjectURL(oldSrc);
    }
    if (previewImg) previewImg.src = createObjectURL(blob);
    if (previewInfo) {
      previewInfo.textContent = `${outWidth}×${outHeight} · ${formatBytes(blob.size)} · ${frameCount} frames · ${duration.toFixed(1)}s`;
    }
    previewWrap?.classList.remove('hidden');

    setStatus(`✅ GIF ready — ${outWidth}×${outHeight}, ${formatBytes(blob.size)}, ${frameCount} frames.`, 'success');
    showToast('GIF generated successfully', 'success');

    const filename = `${STATE.baseName}_${Math.round(start * 10) / 10}-${Math.round(end * 10) / 10}s.gif`;
    downloadBlob(blob, filename);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(
      `❌ GIF generation failed: ${err.message}\n\n` +
      `Try reducing FPS, resolution, or clip length. Large GIFs can be slow to encode. ` +
      `If a CORS error is shown, use "Choose File" to upload the video locally instead.`,
      'error'
    );
    hideProgressBar('v2g-progress');
  } finally {
    STATE.abort.release(ctrl);
    try { video.currentTime = originalTime; } catch { /* ignore */ }
    setBusy(false);
  }
}

function downloadAgain() {
  if (!STATE.lastGifBlob) {
    showToast('No GIF generated yet.', 'warning');
    return;
  }
  const { start, end } = readSettings();
  downloadBlob(STATE.lastGifBlob, `${STATE.baseName}_${start.toFixed(1)}-${end.toFixed(1)}s.gif`);
}

export default async function render(container) {
  if (!container) return;
  cleanup();

  container.innerHTML = `
    <div class="space-y-5 fade-in">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2">
            <span>🎞️</span> Video → GIF
          </h2>
          <p class="text-sm text-slate-400 mt-1">Turn any clip into an optimized animated GIF. Runs entirely in your browser.</p>
        </div>
        <button onclick="goHome()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">
          ← Back
        </button>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <label for="v2g-url-input" class="block text-xs font-bold uppercase tracking-wider text-slate-400">Video Source</label>
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            id="v2g-url-input"
            type="url"
            placeholder="https://example.com/video.mp4"
            class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="v2g-load-btn" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed min-w-[140px]">
            Load URL
          </button>
          <label class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold cursor-pointer transition">
            📁 Choose File
            <input id="v2g-file-input" type="file" accept="video/*" class="hidden" />
          </label>
        </div>
        <div id="v2g-status" class="hidden mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed"></div>
      </div>

      <div id="v2g-video-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4">
        <video id="v2g-video" controls playsinline preload="metadata" crossorigin="anonymous" class="w-full rounded-lg bg-black max-h-[400px]"></video>
      </div>

      <div id="v2g-settings" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">GIF Settings</h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-semibold text-slate-400">Start Time</label>
              <span id="v2g-start-label" class="text-xs font-mono text-indigo-300">0:00</span>
            </div>
            <input id="v2g-start" type="range" min="0" max="100" step="0.1" value="0" class="w-full accent-indigo-500" />
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-semibold text-slate-400">End Time</label>
              <span id="v2g-end-label" class="text-xs font-mono text-indigo-300">0:05</span>
            </div>
            <input id="v2g-end" type="range" min="0" max="100" step="0.1" value="5" class="w-full accent-indigo-500" />
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">FPS</span>
            <select id="v2g-fps" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="5">5 (smallest)</option>
              <option value="10" selected>10 (recommended)</option>
              <option value="15">15</option>
              <option value="20">20</option>
              <option value="25">25 (largest)</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Width (px)</span>
            <select id="v2g-width" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="320">320 (small)</option>
              <option value="480" selected>480 (medium)</option>
              <option value="640">640 (large)</option>
              <option value="800">800</option>
              <option value="1280">1280 (huge)</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Colors</span>
            <select id="v2g-colors" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="64">64 (small)</option>
              <option value="128" selected>128 (recommended)</option>
              <option value="256">256 (best)</option>
            </select>
          </label>
        </div>

        <div class="flex flex-wrap gap-4 text-sm text-slate-300">
          <label class="inline-flex items-center gap-2 cursor-pointer">
            <input id="v2g-loop" type="checkbox" checked class="accent-indigo-500 w-4 h-4" />
            Loop forever
          </label>
          <label class="inline-flex items-center gap-2 cursor-pointer">
            <input id="v2g-dither" type="checkbox" checked class="accent-indigo-500 w-4 h-4" />
            Dithering (smoother colors)
          </label>
        </div>

        <button id="v2g-generate-btn" disabled class="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white text-sm font-bold transition disabled:opacity-50 disabled:cursor-not-allowed">
          <svg id="v2g-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
          <span id="v2g-gen-text">Generate GIF</span>
        </button>

        ${createProgressBarHTML('v2g-progress')}
      </div>

      <div id="v2g-preview-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Preview</h3>
          <button id="v2g-redownload-btn" class="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition">
            💾 Download Again
          </button>
        </div>
        <div class="rounded-xl overflow-hidden bg-black flex items-center justify-center p-4 min-h-[200px]">
          <img id="v2g-preview-img" alt="Generated GIF preview" class="max-w-full max-h-[400px]" />
        </div>
        <p id="v2g-preview-info" class="text-xs text-slate-500 text-center font-mono"></p>
      </div>

      <div class="rounded-xl bg-slate-900/40 border border-slate-800/60 px-4 py-3 text-xs text-slate-500 leading-relaxed">
        <strong class="text-slate-400">Tips:</strong> Shorter clips (under 5s) and lower FPS produce much smaller GIFs. If loading a URL fails with a CORS error, use "Choose File" to upload the video from your device instead — no upload happens, the file stays in your browser.
      </div>
    </div>
  `;

  const video = document.getElementById('v2g-video');
  const startInput = document.getElementById('v2g-start');
  const endInput = document.getElementById('v2g-end');

  document.getElementById('v2g-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); loadFromUrl(); }
  });
  document.getElementById('v2g-load-btn')?.addEventListener('click', loadFromUrl);
  document.getElementById('v2g-file-input')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadFromFile(f);
  });

  startInput?.addEventListener('input', () => {
    if (endInput && parseFloat(startInput.value) >= parseFloat(endInput.value)) {
      endInput.value = String(parseFloat(startInput.value) + 0.2);
    }
    updateRangeLabels();
  });
  endInput?.addEventListener('input', () => {
    if (startInput && parseFloat(endInput.value) <= parseFloat(startInput.value)) {
      startInput.value = String(Math.max(0, parseFloat(endInput.value) - 0.2));
    }
    updateRangeLabels();
  });

  document.getElementById('v2g-generate-btn')?.addEventListener('click', generateGif);
  document.getElementById('v2g-redownload-btn')?.addEventListener('click', downloadAgain);

  video?.addEventListener('loadedmetadata', () => {
    if (startInput) startInput.max = video.duration;
    if (endInput) endInput.max = video.duration;
    if (endInput && parseFloat(endInput.value) > video.duration) endInput.value = video.duration;
    updateRangeLabels();
  });
                       }
