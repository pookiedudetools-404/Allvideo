// tools/format-converter.js — Video Format Converter (MP4 / WebM)

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
  hasAudio: false,
  busy: false,
  cancelled: false,
  abort: createAbortRegistry(),
};

const QUALITY_PRESETS = {
  high: { videoBitsPerSecond: 4000000, audioBitsPerSecond: 192000 },
  medium: { videoBitsPerSecond: 1500000, audioBitsPerSecond: 128000 },
  low: { videoBitsPerSecond: 500000, audioBitsPerSecond: 96000 },
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
  const box = document.getElementById('fc-status');
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
  const box = document.getElementById('fc-status');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function updateButtonStates() {
  const busy = STATE.busy;
  const hasSource = !!STATE.sourceBlob;
  const cancelBtn = document.getElementById('fc-cancel-btn');
  const loadBtn = document.getElementById('fc-load-btn');
  const input = document.getElementById('fc-url-input');
  const spinner = document.getElementById('fc-load-spinner');
  const loadText = document.getElementById('fc-load-text');

  if (loadBtn) loadBtn.disabled = busy;
  if (input) input.disabled = busy;
  if (spinner) spinner.classList.toggle('hidden', !busy || !!STATE.sourceBlob);
  if (loadText) loadText.textContent = busy && !hasSource ? 'Loading…' : 'Load';

  document.querySelectorAll('.fc-convert-btn').forEach((b) => {
    b.disabled = !hasSource || busy;
  });
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !busy);
}

function getSupportedMime(targetFormat) {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = targetFormat === 'mp4'
    ? [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
        'video/mp4;codecs=avc1.64001f,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4;codecs=h264',
        'video/mp4',
      ]
    : [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function detectAudioTrack(video) {
  // Heuristic: try to check if audio track exists via captureStream (best effort)
  try {
    const s = video.captureStream ? video.captureStream() : (video.mozCaptureStream && video.mozCaptureStream());
    if (s && s.getAudioTracks().length > 0) return true;
  } catch { /* ignore */ }
  return null;
}

async function loadSource(source) {
  if (STATE.busy) return;
  clearStatus();
  hideProgressBar('fc-progress');
  document.getElementById('fc-result-wrap')?.classList.add('hidden');

  if (STATE.sourceUrl) {
    revokeObjectURL(STATE.sourceUrl);
    STATE.sourceUrl = null;
  }
  STATE.sourceBlob = null;
  STATE.busy = true;
  updateButtonStates();
  setStatus('Loading source…', 'info');

  const previewVideo = document.getElementById('fc-video');
  const wrap = document.getElementById('fc-video-wrap');

  try {
    let blob;
    let name;
    if (source.type === 'url') {
      if (!isValidUrl(source.url)) throw new Error('Invalid URL');
      setStatus('Downloading video via browser fetch…', 'info');
      const ctrl = STATE.abort.newController();
      try {
        const res = await fetchWithTimeout(source.url, { mode: 'cors', signal: ctrl.signal }, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const total = parseInt(res.headers.get('content-length') || '0', 10);
        const ct = res.headers.get('content-type') || '';
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
            updateProgressBar('fc-progress', { percent: pct, received, total, label: 'Downloading source…' });
          }
        } else {
          const ab = await res.arrayBuffer();
          chunks.push(new Uint8Array(ab));
        }
        blob = new Blob(chunks, { type: ct || 'video/mp4' });
        name = inferFilename(source.url, ct).replace(/\.[^.]+$/, '');
        STATE.sourceMime = ct;
      } finally {
        STATE.abort.release(ctrl);
      }
    } else {
      blob = source.file;
      name = (source.file.name || 'video').replace(/\.[^.]+$/, '');
      STATE.sourceMime = source.file.type || '';
    }

    STATE.sourceBlob = blob;
    STATE.sourceName = name || 'video';
    STATE.sourceUrl = createObjectURL(blob);

    previewVideo.src = STATE.sourceUrl;
    previewVideo.load();
    wrap.classList.remove('hidden');

    await new Promise((resolve, reject) => {
      const onMeta = () => { clearTimeout(t); previewVideo.removeEventListener('error', onErr); resolve(); };
      const onErr = () => { clearTimeout(t); previewVideo.removeEventListener('loadedmetadata', onMeta); reject(new Error('Preview failed to load')); };
      const t = setTimeout(() => reject(new Error('Metadata load timeout (15s)')), 15000);
      previewVideo.addEventListener('loadedmetadata', onMeta, { once: true });
      previewVideo.addEventListener('error', onErr, { once: true });
    });

    STATE.duration = previewVideo.duration;
    STATE.width = previewVideo.videoWidth;
    STATE.height = previewVideo.videoHeight;
    STATE.hasAudio = detectAudioTrack(previewVideo) !== false;

    renderInfo();
    setStatus(`✅ Loaded · ${formatDuration(STATE.duration)} · ${STATE.width}×${STATE.height} · ${formatBytes(blob.size)}`, 'success');
    updateProgressBar('fc-progress', { percent: 100, received: blob.size, total: blob.size, label: 'Ready' });
    setTimeout(() => hideProgressBar('fc-progress'), 1500);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`❌ Failed to load source: ${err.message}`, 'error');
    STATE.sourceBlob = null;
  } finally {
    STATE.busy = false;
    updateButtonStates();
  }
}

function renderInfo() {
  const info = document.getElementById('fc-source-info');
  if (!info) return;
  info.classList.remove('hidden');
  const pill = (label, value) => `
    <div class="flex flex-col gap-0.5 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700/60">
      <span class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">${escapeHtml(label)}</span>
      <span class="text-sm font-semibold text-indigo-300">${escapeHtml(String(value))}</span>
    </div>`;
  info.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      ${pill('Format', (STATE.sourceMime || 'unknown').split(';')[0] || 'unknown')}
      ${pill('Size', formatBytes(STATE.sourceBlob?.size || 0))}
      ${pill('Duration', formatDuration(STATE.duration))}
      ${pill('Resolution', `${STATE.width}×${STATE.height}`)}
    </div>
  `;
}

function cancelConversion() {
  if (!STATE.busy) return;
  STATE.cancelled = true;
  setStatus('⚠️ Cancelling conversion…', 'warning');
}

async function convert(targetFormat) {
  if (STATE.busy || !STATE.sourceBlob) return;

  const quality = document.getElementById('fc-quality')?.value || 'medium';
  const fpsCap = Math.min(60, Math.max(1, parseInt(document.getElementById('fc-fps')?.value || '30', 10) || 30));
  const resCap = document.getElementById('fc-resolution')?.value || 'original';

  let mimeType = getSupportedMime(targetFormat);
  let actualFormat = targetFormat;

  if (!mimeType) {
    const fallback = getSupportedMime('webm');
    if (!fallback) {
      setStatus(`❌ Your browser cannot encode ${targetFormat.toUpperCase()} or WebM. Try a different browser (Chrome / Edge recommended).`, 'error');
      return;
    }
    setStatus(`⚠️ This browser doesn't support ${targetFormat.toUpperCase()} encoding. Falling back to WebM.`, 'warning');
    mimeType = fallback;
    actualFormat = 'webm';
  }

  // target dimensions
  let tw = STATE.width || 1280;
  let th = STATE.height || 720;
  if (resCap !== 'original') {
    const max = parseInt(resCap, 10);
    if (isFinite(max) && max > 0) {
      const scale = Math.min(1, max / Math.max(tw, th));
      tw = Math.max(2, Math.round((tw * scale) / 2) * 2);
      th = Math.max(2, Math.round((th * scale) / 2) * 2);
    }
  }

  STATE.busy = true;
  STATE.cancelled = false;
  updateButtonStates();
  clearStatus();
  document.getElementById('fc-result-wrap')?.classList.add('hidden');
  setStatus(`Converting to ${actualFormat.toUpperCase()} (realtime — video plays once in the background)…`, 'info');
  updateProgressBar('fc-progress', { percent: 0, received: 0, total: 0, label: 'Starting…' });

  const workVideo = document.createElement('video');
  workVideo.src = STATE.sourceUrl;
  workVideo.crossOrigin = 'anonymous';
  workVideo.playsInline = true;
  workVideo.muted = false;
  workVideo.style.cssText = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(workVideo);

  let audioCtx = null;
  let rafId = null;
  let progressIv = null;

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Work video metadata timeout')), 12000);
      workVideo.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
      workVideo.addEventListener('error', () => { clearTimeout(t); reject(new Error('Work video failed to load')); }, { once: true });
    });

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d', { alpha: false });

    const fpsStream = canvas.captureStream(fpsCap);
    let audioTracks = [];

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const srcNode = audioCtx.createMediaElementSource(workVideo);
      const destNode = audioCtx.createMediaStreamDestination();
      srcNode.connect(destNode);
      // NOTE: intentionally NOT connected to audioCtx.destination → no speaker output
      audioTracks = destNode.stream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn('[converter] No audio tracks captured');
      }
    } catch (audioErr) {
      console.warn('[converter] Audio capture unavailable:', audioErr.message);
      audioCtx = null;
    }

    const combinedStream = new MediaStream([
      ...fpsStream.getVideoTracks(),
      ...audioTracks,
    ]);

    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
    const recorderOptions = {
      mimeType,
      videoBitsPerSecond: preset.videoBitsPerSecond,
    };
    if (audioTracks.length > 0) {
      recorderOptions.audioBitsPerSecond = preset.audioBitsPerSecond;
    }

    const recorder = new MediaRecorder(combinedStream, recorderOptions);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stoppedPromise = new Promise((resolve) => { recorder.onstop = resolve; });

    recorder.start(1000);

    const drawFrame = () => {
      if (STATE.cancelled) return;
      if (!workVideo.paused && !workVideo.ended) {
        try { ctx.drawImage(workVideo, 0, 0, canvas.width, canvas.height); } catch { /* ignore frame errors */ }
        rafId = requestAnimationFrame(drawFrame);
      }
    };

    workVideo.currentTime = 0;
    await workVideo.play();
    drawFrame();

    await new Promise((resolve) => {
      progressIv = setInterval(() => {
        if (STATE.cancelled) return resolve();
        const cur = workVideo.currentTime || 0;
        const dur = workVideo.duration || STATE.duration || 1;
        const pct = Math.min(99, Math.round((cur / dur) * 100));
        updateProgressBar('fc-progress', {
          percent: pct,
          received: 0,
          total: 0,
          label: `Converting ${actualFormat.toUpperCase()}… ${pct}% (${formatDuration(cur)} / ${formatDuration(dur)})`,
        });
        if (workVideo.ended) resolve();
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
      hideProgressBar('fc-progress');
      return;
    }

    if (chunks.length === 0) throw new Error('Recorder produced no data. Try a different quality preset or WebM format.');

    const outBlob = new Blob(chunks, { type: mimeType.split(';')[0] });
    if (outBlob.size < 1024) throw new Error('Output file is too small — recording likely failed.');

    updateProgressBar('fc-progress', { percent: 100, received: outBlob.size, total: outBlob.size, label: 'Complete' });
    setStatus(`✅ Conversion complete · ${formatBytes(outBlob.size)} · ${actualFormat.toUpperCase()}`, 'success');

    const filename = `${STATE.sourceName}_converted.${actualFormat}`;
    downloadBlob(outBlob, filename);
    showToast(`✅ Saved ${filename}`, 'success');

    const preview = document.getElementById('fc-result-video');
    const resultWrap = document.getElementById('fc-result-wrap');
    const resultInfo = document.getElementById('fc-result-info');
    if (preview) {
      const oldSrc = preview.src;
      if (oldSrc && oldSrc.startsWith('blob:')) revokeObjectURL(oldSrc);
      preview.src = createObjectURL(outBlob);
    }
    if (resultInfo) resultInfo.textContent = `${actualFormat.toUpperCase()} · ${formatBytes(outBlob.size)} · ${tw}×${th}`;
    resultWrap?.classList.remove('hidden');
  } catch (err) {
    if (STATE.cancelled || err.name === 'AbortError') {
      setStatus('⚠️ Conversion cancelled.', 'warning');
    } else {
      setStatus(
        `❌ Conversion failed: ${err.message}\n\n` +
        `Troubleshooting:\n` +
        `• If your browser blocks autoplay: click Convert again immediately.\n` +
        `• Some browsers can't encode ${actualFormat.toUpperCase()}. Try WebM (VP9) target.\n` +
        `• Reduce resolution (720p or 480p) and use "Low" quality for very large sources.\n` +
        `• Very long videos (>30 min) may fail — split into shorter clips first.`,
        'error'
      );
    }
    hideProgressBar('fc-progress');
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

  const mp4Supported = !!getSupportedMime('mp4');
  const webmSupported = !!getSupportedMime('webm');

  container.innerHTML = `
    <div class="space-y-5 fade-in">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 class="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2">
            <span>🔄</span> Format Converter
          </h2>
          <p class="text-sm text-slate-400 mt-1">Convert between MP4 and WebM. Auto-chooses the best supported codec.</p>
        </div>
        <button onclick="goHome()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">
          ← Back
        </button>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <label for="fc-url-input" class="block text-xs font-bold uppercase tracking-wider text-slate-400">Source Video</label>
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            id="fc-url-input"
            type="url"
            placeholder="https://example.com/video.mp4"
            class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="fc-load-btn" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed min-w-[130px]">
            <svg id="fc-load-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
            <span id="fc-load-text">Load</span>
          </button>
          <label class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold cursor-pointer transition">
            📁 File
            <input id="fc-file-input" type="file" accept="video/*" class="hidden" />
          </label>
        </div>

        <div id="fc-status" class="hidden mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed"></div>
        ${createProgressBarHTML('fc-progress')}
      </div>

      <div id="fc-source-info" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4"></div>

      <div id="fc-video-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4">
        <video id="fc-video" controls playsinline preload="metadata" class="w-full rounded-lg bg-black max-h-[360px]"></video>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Conversion Settings</h3>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Quality Preset</span>
            <select id="fc-quality" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="high">High (4 Mbps)</option>
              <option value="medium" selected>Medium (1.5 Mbps)</option>
              <option value="low">Low (0.5 Mbps — small)</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Frame Rate</span>
            <select id="fc-fps" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="15">15 fps</option>
              <option value="24">24 fps</option>
              <option value="30" selected>30 fps</option>
              <option value="60">60 fps</option>
            </select>
          </label>
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">Max Resolution</span>
            <select id="fc-resolution" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="original" selected>Original</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
              <option value="480">480p</option>
              <option value="360">360p</option>
            </select>
          </label>
        </div>

        <div class="flex flex-wrap gap-2">
          <button data-fmt="mp4" class="fc-convert-btn px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-sm font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">
            📼 Convert to MP4 ${mp4Supported ? '' : '(fallback: WebM)'}
          </button>
          <button data-fmt="webm" class="fc-convert-btn px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white text-sm font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">
            🎬 Convert to WebM ${webmSupported ? '' : '(unsupported)'}
          </button>
          <button id="fc-cancel-btn" class="hidden px-5 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-bold transition">
            ✕ Cancel
          </button>
        </div>
      </div>

      <div id="fc-result-wrap" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Result Preview</h3>
          <span id="fc-result-info" class="text-xs font-mono text-slate-500"></span>
        </div>
        <video id="fc-result-video" controls playsinline class="w-full rounded-lg bg-black max-h-[360px]"></video>
      </div>

      <div class="rounded-xl bg-slate-900/40 border border-slate-800/60 px-4 py-3 text-xs text-slate-500 leading-relaxed">
        <strong class="text-slate-400">⚠️ Heads-up:</strong> Browser-based conversion runs in <strong>real-time</strong> — a 10-minute video takes roughly 10 minutes to convert because it must be played and re-recorded. This tool uses your browser's native codecs (H.264/VP9 + AAC/Opus). If MP4 isn't supported, WebM is used automatically. For true offline-speed conversion with advanced codecs, use a desktop tool like HandBrake.
      </div>
    </div>
  `;

  document.getElementById('fc-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const url = (e.target.value || '').trim();
      if (url) loadSource({ type: 'url', url });
    }
  });

  document.getElementById('fc-load-btn')?.addEventListener('click', () => {
    const url = (document.getElementById('fc-url-input')?.value || '').trim();
    if (!url) {
      showToast('Paste a URL first, or choose a file.', 'warning');
      return;
    }
    loadSource({ type: 'url', url });
  });

  document.getElementById('fc-file-input')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadSource({ type: 'file', file: f });
    e.target.value = '';
  });

  document.querySelectorAll('.fc-convert-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fmt = btn.dataset.fmt;
      if (fmt === 'mp4' && !mp4Supported) {
        if (!webmSupported) {
          setStatus('❌ Neither MP4 nor WebM encoding is supported in this browser.', 'error');
          return;
        }
      }
      if (fmt === 'webm' && !webmSupported) {
        setStatus('❌ WebM encoding is not supported in this browser.', 'error');
        return;
      }
      convert(fmt);
    });
  });

  document.getElementById('fc-cancel-btn')?.addEventListener('click', cancelConversion);

  updateButtonStates();
      }
