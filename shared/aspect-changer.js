// tools/aspect-changer.js — Video Aspect Ratio Changer

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
  fetchWithTimeout,
} from '../shared/utils.js';

const STATE = {
  sourceBlob: null,
  sourceUrl: null,
  sourceName: 'video',
  sourceMime: '',
  duration: 0,
  width: 0,
  height: 0,
  busy: false,
  cancelled: false,
  abort: createAbortRegistry(),
};

const PRESETS = {
  '16:9': { ratio: 16 / 9, label: '16:9 (YouTube / Landscape)' },
  '9:16': { ratio: 9 / 16, label: '9:16 (TikTok / Reels / Shorts)' },
  '1:1': { ratio: 1, label: '1:1 (Instagram Square)' },
  '4:5': { ratio: 4 / 5, label: '4:5 (Instagram Portrait)' },
  '4:3': { ratio: 4 / 3, label: '4:3 (Classic TV)' },
  '21:9': { ratio: 21 / 9, label: '21:9 (Cinematic)' },
};

const BG_OPTIONS = {
  black: '#000000',
  white: '#ffffff',
  blur: 'blur',
  color: 'custom',
};

export function cleanup() {
  STATE.cancelled = true;
  STATE.abort.abortAll();
  if (STATE.sourceUrl) {
    revokeObjectURL(STATE.sourceUrl);
    STATE.sourceUrl = null;
  }
  STATE.sourceBlob = null;
  STATE.busy = false;
}

function setStatus(msg, kind = 'info') {
  const box = document.getElementById('ac-status');
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
  const box = document.getElementById('ac-status');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function updateButtonStates() {
  const hasSource = !!STATE.sourceBlob;
  const loadBtn = document.getElementById('ac-load-btn');
  const input = document.getElementById('ac-url-input');
  const spinner = document.getElementById('ac-load-spinner');
  const loadText = document.getElementById('ac-load-text');
  const convertBtn = document.getElementById('ac-convert-btn');
  const cancelBtn = document.getElementById('ac-cancel-btn');

  if (loadBtn) loadBtn.disabled = STATE.busy;
  if (input) input.disabled = STATE.busy;
  if (spinner) spinner.classList.toggle('hidden', !STATE.busy || hasSource);
  if (loadText) loadText.textContent = STATE.busy && !hasSource ? 'Loading…' : 'Load';
  if (convertBtn) convertBtn.disabled = !hasSource || STATE.busy;
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !STATE.busy);
}

function getSupportedMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

async function loadSource(source) {
  if (STATE.busy) return;
  clearStatus();
  hideProgressBar('ac-progress');
  document.getElementById('ac-result-wrap')?.classList.add('hidden');
  document.getElementById('ac-source-info')?.classList.add('hidden');

  if (STATE.sourceUrl) {
    revokeObjectURL(STATE.sourceUrl);
    STATE.sourceUrl = null;
  }
  STATE.sourceBlob = null;
  STATE.busy = true;
  updateButtonStates();
  setStatus('Loading source…', 'info');

  const previewVideo = document.getElementById('ac-video');
  const wrap = document.getElementById('ac-video-wrap');

  try {
    let blob;
    let name;
    let mime = '';
    if (source.type === 'url') {
      if (!isValidUrl(source.url)) throw new Error('Invalid URL');
      setStatus('Downloading video…', 'info');
      const ctrl = STATE.abort.newController();
      try {
        const res = await fetchWithTimeout(source.url, { mode: 'cors', signal: ctrl.signal }, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        mime = res.headers.get('content-type') || '';
        const total = parseInt(res.headers.get('content-length') || '0', 10);
        const chunks = [];
        let received = 0;
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            const pct = total ? Math.round((received / total) * 100) : 0;
            updateProgressBar('ac-progress', { percent: pct, received, total, label: 'Downloading…' });
          }
        } else {
          const ab = await res.arrayBuffer();
          chunks.push(new Uint8Array(ab));
        }
        blob = new Blob(chunks, { type: mime || 'video/mp4' });
        name = inferFilename(source.url, mime).replace(/\.[^.]+$/, '');
      } finally {
        STATE.abort.release(ctrl);
      }
    } else {
      blob = source.file;
      mime = source.file.type || '';
      name = (source.file.name || 'video').replace(/\.[^.]+$/, '');
    }

    STATE.sourceBlob = blob;
    STATE.sourceMime = mime;
    STATE.sourceName = name || 'video';
    STATE.sourceUrl = createObjectURL(blob);

    previewVideo.src = STATE.sourceUrl;
    previewVideo.load();
    wrap.classList.remove('hidden');

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Metadata load timeout (15s)')), 15000);
      previewVideo.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
      previewVideo.addEventListener('error', () => { clearTimeout(t); reject(new Error('Preview failed to load')); }, { once: true });
    });

    STATE.duration = previewVideo.duration;
    STATE.width = previewVideo.videoWidth;
    STATE.height = previewVideo.videoHeight;

    renderSourceInfo();
    updatePreviewFrame();
    setStatus(`✅ Loaded · ${STATE.width}×${STATE.height} · ${formatDuration(STATE.duration)} · ${formatBytes(blob.size)}`, 'success');
    updateProgressBar('ac-progress', { percent: 100, received: blob.size, total: blob.size, label: 'Ready' });
    setTimeout(() => hideProgressBar('ac-progress'), 1500);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`❌ Failed to load: ${err.message}`, 'error');
    STATE.sourceBlob = null;
  } finally {
    STATE.busy = false;
    updateButtonStates();
  }
}

function renderSourceInfo() {
  const info = document.getElementById('ac-source-info');
  if (!info) return;
  info.classList.remove('hidden');
  const pill = (label, value) => `
    <div class="flex flex-col gap-0.5 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700/60">
      <span class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">${escapeHtml(label)}</span>
      <span class="text-sm font-semibold text-indigo-300">${escapeHtml(String(value))}</span>
    </div>`;
  info.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      ${pill('Source Size', formatBytes(STATE.sourceBlob?.size || 0))}
      ${pill('Duration', formatDuration(STATE.duration))}
      ${pill('Resolution', `${STATE.width}×${STATE.height}`)}
      ${pill('Ratio', getRatioLabel(STATE.width, STATE.height))}
    </div>
  `;
}

function getRatioLabel(w, h) {
  if (!w || !h) return '—';
  const r = w / h;
  let best = null;
  let bestDiff = Infinity;
  for (const [key, p] of Object.entries(PRESETS)) {
    const diff = Math.abs(p.ratio - r);
    if (diff < bestDiff) { bestDiff = diff; best = key; }
  }
  return best && bestDiff < 0.05 ? best : r.toFixed(2);
}

function getTargetDimensions(targetRatio, sourceW, sourceH) {
  // Max output dim capped at 1920 for safety
  const maxDim = 1920;
  let w, h;
  if (targetRatio >= 1) {
    // Landscape or square
    w = Math.min(sourceW, maxDim);
    h = Math.round(w / targetRatio);
    // Ensure height fits within reasonable bound
    if (h > maxDim) { h = maxDim; w = Math.round(h * targetRatio); }
  } else {
    // Portrait
    h = Math.min(sourceH, maxDim);
    w = Math.round(h * targetRatio);
    if (w > maxDim) { w = maxDim; h = Math.round(w / targetRatio); }
  }
  // Ensure even dimensions
  w = Math.max(2, w - (w % 2));
  h = Math.max(2, h - (h % 2));
  return { width: w, height: h };
}

function getSelectedRatio() {
  const sel = document.getElementById('ac-ratio');
  const key = sel?.value || '9:16';
  return PRESETS[key]?.ratio || 9 / 16;
}

function getSelectedFit() {
  return document.getElementById('ac-fit')?.value || 'pad';
}

function getBgValue() {
  const bg = document.getElementById('ac-bg')?.value || 'black';
  if (bg === 'black') return '#000000';
  if (bg === 'white') return '#ffffff';
  if (bg === 'blur') return 'blur';
  if (bg === 'custom') return document.getElementById('ac-bg-color')?.value || '#1e1b4b';
  return '#000000';
}

function updatePreviewFrame() {
  const frame = document.getElementById('ac-preview-frame');
  const dims = document.getElementById('ac-target-dims');
  if (!frame) return;
  const ratio = getSelectedRatio();
  frame.style.aspectRatio = String(ratio);
  if (dims && STATE.width && STATE.height) {
    const { width, height } = getTargetDimensions(ratio, STATE.width, STATE.height);
    dims.textContent = `${width}×${height}`;
  }
}

function getSupportedQuality() {
  const q = document.getElementById('ac-quality')?.value || 'medium';
  if (q === 'high') return { videoBitsPerSecond: 4000000, audioBitsPerSecond: 192000 };
  if (q === 'low') return { videoBitsPerSecond: 500000, audioBitsPerSecond: 96000 };
  return { videoBitsPerSecond: 1500000, audioBitsPerSecond: 128000 };
}

function cancelConversion() {
  if (!STATE.busy) return;
  STATE.cancelled = true;
  setStatus('⚠️ Cancelling…', 'warning');
}

function drawFrameWithFit(ctx, video, targetW, targetH, fit, bgValue) {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const srcRatio = srcW / srcH;
  const targetRatio = targetW / targetH;

  // Fill background first (for pad modes)
  if (fit !== 'crop') {
    if (bgValue === 'blur') {
      // Blurred background fill
      ctx.save();
      const scale = Math.max(targetW / srcW, targetH / srcH);
      const bw = srcW * scale;
      const bh = srcH * scale;
      ctx.filter = 'blur(28px) brightness(0.6)';
      ctx.drawImage(video, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);
      ctx.filter = 'none';
      ctx.restore();
    } else {
      ctx.fillStyle = bgValue;
      ctx.fillRect(0, 0, targetW, targetH);
    }
  }

  if (fit === 'stretch') {
    ctx.drawImage(video, 0, 0, targetW, targetH);
    return;
  }

  if (fit === 'crop') {
    // Center crop to fill
    let sw, sh, sx, sy;
    if (srcRatio > targetRatio) {
      // Source wider → crop sides
      sh = srcH;
      sw = srcH * targetRatio;
      sx = (srcW - sw) / 2;
      sy = 0;
    } else {
      sw = srcW;
      sh = srcW / targetRatio;
      sx = 0;
      sy = (srcH - sh) / 2;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
    return;
  }

  // 'pad' or 'blur' — fit inside, letterbox/pillarbox
  let dw, dh, dx, dy;
  if (srcRatio > targetRatio) {
    dw = targetW;
    dh = targetW / srcRatio;
    dx = 0;
    dy = (targetH - dh) / 2;
  } else {
    dh = targetH;
    dw = targetH * srcRatio;
    dx = (targetW - dw) / 2;
    dy = 0;
  }
  ctx.drawImage(video, dx, dy, dw, dh);
}

async function convert() {
  if (STATE.busy || !STATE.sourceBlob) return;

  const mimeType = getSupportedMime();
  if (!mimeType) {
    setStatus('❌ Your browser cannot encode video with MediaRecorder. Try Chrome or Edge.', 'error');
    return;
  }

  const targetRatio = getSelectedRatio();
  const { width: outW, height: outH } = getTargetDimensions(targetRatio, STATE.width, STATE.height);
  const fit = getSelectedFit();
  const bgValue = getBgValue();
  const preset = getSupportedQuality();

  STATE.busy = true;
  STATE.cancelled = false;
  updateButtonStates();
  clearStatus();
  document.getElementById('ac-result-wrap')?.classList.add('hidden');
  setStatus(`Reshaping to ${outW}×${outH} (${fit === 'pad' ? 'letterbox' : fit}) — realtime…`, 'info');
  updateProgressBar('ac-progress', { percent: 0, received: 0, total: 0, label: 'Starting…' });

  const workVideo = document.createElement('video');
  workVideo.src = STATE.sourceUrl;
  workVideo.crossOrigin = 'anonymous';
  workVideo.playsInline = true;
  workVideo.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(workVideo);

  let audioCtx = null;
  let rafId = null;
  let progressIv = null;

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Work video timeout')), 12000);
      workVideo.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
      workVideo.addEventListener('error', () => { clearTimeout(t); reject(new Error('Work video failed')); }, { once: true });
    });

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });

    // Draw first frame immediately so stream starts clean
    drawFrameWithFit(ctx, workVideo, outW, outH, fit, bgValue);

    const fpsStream = canvas.captureStream(30);
    let audioTracks = [];

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const srcNode = audioCtx.createMediaElementSource(workVideo);
      const destNode = audioCtx.createMediaStreamDestination();
      srcNode.connect(destNode);
      audioTracks = destNode.stream.getAudioTracks();
    } catch (e) {
      console.warn('[aspect] audio capture failed:', e.message);
    }

    const combinedStream = new MediaStream([
      ...fpsStream.getVideoTracks(),
      ...audioTracks,
    ]);

    const recorderOpts = { mimeType, videoBitsPerSecond: preset.videoBitsPerSecond };
    if (audioTracks.length > 0) recorderOpts.audioBitsPerSecond = preset.audioBitsPerSecond;
    const recorder = new MediaRecorder(combinedStream, recorderOpts);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stoppedPromise = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);

    const drawLoop = () => {
      if (STATE.cancelled) return;
      if (!workVideo.paused && !workVideo.ended) {
        try { drawFrameWithFit(ctx, workVideo, outW, outH, fit, bgValue); } catch { /* ignore */ }
        rafId = requestAnimationFrame(drawLoop);
      }
    };

    workVideo.currentTime = 0;
    await workVideo.play();
    drawLoop();

    await new Promise((resolve) => {
      progressIv = setInterval(() => {
        if (STATE.cancelled) return resolve();
        const cur = workVideo.currentTime || 0;
        const dur = workVideo.duration || STATE.duration || 1;
        const pct = Math.min(99, Math.round((cur / dur) * 100));
        updateProgressBar('ac-progress', {
          percent: pct, received: 0, total: 0,
          label: `Reshaping… ${pct}% (${formatDuration(cur)} / ${formatDuration(dur)})`,
        });
        if (workVideo.ended) { clearInterval(progressIv); resolve(); }
      }, 250);
      workVideo.addEventListener('ended', () => { clearInterval(progressIv); resolve(); }, { once: true });
      setTimeout(() => { clearInterval(progressIv); resolve(); }, Math.max(15000, (STATE.duration + 5) * 1000));
    });

    clearInterval(progressIv);
    if (rafId) cancelAnimationFrame(rafId);
    if (recorder.state !== 'inactive') recorder.stop();
    await stoppedPromise;

    if (STATE.cancelled) {
      setStatus('⚠️ Conversion cancelled.', 'warning');
      hideProgressBar('ac-progress');
      return;
    }

    if (chunks.length === 0) throw new Error('Recorder produced no data.');
    const outBlob = new Blob(chunks, { type: mimeType.split(';')[0] });
    if (outBlob.size < 1024) throw new Error('Output too small — recording failed.');

    updateProgressBar('ac-progress', { percent: 100, received: outBlob.size, total: outBlob.size, label: 'Complete' });

    const outExt = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const filename = `${STATE.sourceName}_${outW}x${outH}.${outExt}`;
    downloadBlob(outBlob, filename);
    showToast(`✅ Saved ${filename}`, 'success');
    setStatus(`✅ Done · ${outW}×${outH} · ${formatBytes(outBlob.size)}`, 'success');

    const preview = document.getElementById('ac-result-video');
    const resultWrap = document.getElementById('ac-result-wrap');
    const resultInfo = document.getElementById('ac-result-info');
    if (preview) {
      const oldSrc = preview.src;
      if (oldSrc && oldSrc.startsWith('blob:')) revokeObjectURL(oldSrc);
      preview.src = createObjectURL(outBlob);
    }
    if (resultInfo) resultInfo.textContent = `${outW}×${outH} · ${formatBytes(outBlob.size)} · ${outExt.toUpperCase()}`;
    resultWrap?.classList.remove('hidden');
  } catch (err) {
    if (STATE.cancelled || err.name === 'AbortError') {
      setStatus('⚠️ Conversion cancelled.', 'warning');
    } else {
      setStatus(`❌ Failed: ${err.message}\n\nTry a shorter clip or lower quality preset.`, 'error');
    }
    hideProgressBar('ac-progress');
  } finally {
    if (rafId) cancelAnimationFrame(rafId);
    if (progressIv) clearInterval(progressIv);
    try { workVideo.pause(); } catch { /* ignore */ }
    workVideo.remove();
    if (audioCtx) { try { await audioCtx.close(); } catch { /* ignore */ } }
    STATE.busy = false;
    STATE.cancelled = false;
    updateButtonStates();
  }
}

export default async function render(container) {
  if (!container) return;
  cleanup();

  container.innerHTML = `
    <div class="space-y-5 fade-in">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2">
            <span>📐</span> Aspect Ratio Changer
          </h2>
          <p class="text-sm text-slate-400 mt-1">Reshape video for Reels, TikTok, YouTube, Instagram and more — with padding, crop or stretch.</p>
        </div>
        <button onclick="goHome()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">
          ← Back
        </button>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <label for="ac-url-input" class="block text-xs font-bold uppercase tracking-wider text-slate-400">Source Video</label>
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            id="ac-url-input"
            type="url"
            placeholder="https://example.com/video.mp4"
            class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="ac-load-btn" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed min-w-[130px]">
            <svg id="ac-load-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
            <span id="ac-load-text">Load</span>
          </button>
          <label class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold cursor-pointer transition">
            📁 File
            <input id="ac-file-input" type="file" accept="video/*" class="hidden" />
          </label>
        </div>

        <div id="ac-status" class="hidden mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed"></div>
        ${createProgressBarHTML('ac-progress')}
      </div>

      <div id="ac-source-info" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4"></div>

      <div id="ac-video-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4">
        <video id="ac-video" controls playsinline preload="metadata" class="w-full rounded-lg bg-black max-h-[360px]"></video>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Output Settings</h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Target Ratio</span>
            <select id="ac-ratio" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              ${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === '9:16' ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
            </select>
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Fit Mode</span>
            <select id="ac-fit" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="pad" selected>Pad (letterbox — keep full frame)</option>
              <option value="crop">Crop (fill — lose edges)</option>
              <option value="stretch">Stretch (distort)</option>
            </select>
          </label>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Background</span>
            <select id="ac-bg" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="black" selected>Black</option>
              <option value="white">White</option>
              <option value="blur">Blurred video</option>
              <option value="custom">Custom color</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Custom Color</span>
            <input id="ac-bg-color" type="color" value="#1e1b4b" class="w-full h-[38px] bg-slate-950 border border-slate-800 rounded-lg cursor-pointer" />
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Quality</span>
            <select id="ac-quality" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="high">High (4 Mbps)</option>
              <option value="medium" selected>Medium (1.5 Mbps)</option>
              <option value="low">Low (0.5 Mbps)</option>
            </select>
          </label>
        </div>

        <div class="rounded-xl bg-slate-950/60 border border-slate-800 p-4 flex flex-col sm:flex-row items-center gap-4">
          <div class="flex flex-col items-center gap-1">
            <span class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Target Frame</span>
            <div id="ac-preview-frame" class="bg-black/80 border border-indigo-500/40 rounded-lg" style="aspect-ratio:0.5625;width:80px;max-height:140px;"></div>
          </div>
          <div class="flex-1 text-center sm:text-left">
            <p class="text-xs text-slate-500">Target resolution</p>
            <p id="ac-target-dims" class="text-lg font-bold text-indigo-300">—</p>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button id="ac-convert-btn" disabled class="px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-fuchsia-600 hover:from-indigo-500 hover:to-fuchsia-500 text-white text-sm font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">
            🎬 Convert Aspect Ratio
          </button>
          <button id="ac-cancel-btn" class="hidden px-5 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-bold transition">
            ✕ Cancel
          </button>
        </div>
      </div>

      <div id="ac-result-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Result</h3>
          <span id="ac-result-info" class="text-xs font-mono text-slate-500"></span>
        </div>
        <video id="ac-result-video" controls playsinline class="w-full rounded-lg bg-black max-h-[400px]"></video>
      </div>

      <div class="rounded-xl bg-slate-900/40 border border-slate-800/60 px-4 py-3 text-xs text-slate-500 leading-relaxed">
        <strong class="text-slate-400">⚠️ Realtime processing:</strong> Conversion re-records the video frame-by-frame in your browser. A 5-minute video takes about 5 minutes. Blur background is heavier — for long videos prefer Pad + solid color.
      </div>
    </div>
  `;

  document.getElementById('ac-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const url = (e.target.value || '').trim();
      if (url) loadSource({ type: 'url', url });
    }
  });

  document.getElementById('ac-load-btn')?.addEventListener('click', () => {
    const url = (document.getElementById('ac-url-input')?.value || '').trim();
    if (!url) { showToast('Paste a URL or choose a file.', 'warning'); return; }
    loadSource({ type: 'url', url });
  });

  document.getElementById('ac-file-input')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadSource({ type: 'file', file: f });
    e.target.value = '';
  });

  document.getElementById('ac-ratio')?.addEventListener('change', updatePreviewFrame);
  document.getElementById('ac-fit')?.addEventListener('change', () => {});
  document.getElementById('ac-bg')?.addEventListener('change', (e) => {
    const color = document.getElementById('ac-bg-color');
    if (color) color.classList.toggle('hidden', e.target.value !== 'custom');
  });
  document.getElementById('ac-bg-color')?.classList.add('hidden');

  document.getElementById('ac-convert-btn')?.addEventListener('click', convert);
  document.getElementById('ac-cancel-btn')?.addEventListener('click', cancelConversion);

  updateButtonStates();
}
