// tools/video-to-mp3.js — Video to MP3 / WAV / OGG

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
  fetchWithTimeout,
  loadScriptOnce,
  createProgressBarHTML,
  updateProgressBar,
  hideProgressBar,
} from '../shared/utils.js';

const STATE = {
  blob: null,
  objectUrl: null,
  audioBuffer: null,
  filename: '',
  sourceMethod: '',
  abort: createAbortRegistry(),
  busy: false,
};

export function cleanup() {
  STATE.abort.abortAll();
  if (STATE.objectUrl) {
    revokeObjectURL(STATE.objectUrl);
    STATE.objectUrl = null;
  }
  STATE.blob = null;
  STATE.audioBuffer = null;
  STATE.busy = false;
}

function setStatus(msg, kind = 'info') {
  const box = document.getElementById('a2s-status');
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
  const box = document.getElementById('a2s-status');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function setBusy(busy, label = '') {
  STATE.busy = busy;
  const loadBtn = document.getElementById('a2s-load-btn');
  const input = document.getElementById('a2s-url-input');
  const spinner = document.getElementById('a2s-spinner');
  const text = document.getElementById('a2s-load-text');
  if (loadBtn) loadBtn.disabled = busy;
  if (input) input.disabled = busy;
  if (spinner) spinner.classList.toggle('hidden', !busy);
  if (text) text.textContent = busy ? (label || 'Working…') : 'Load Video';
  document.querySelectorAll('.a2s-convert-btn').forEach((b) => {
    if (b) b.disabled = busy || !STATE.audioBuffer;
  });
}

// ---------- WAV encoder (16-bit PCM) ----------
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;
  const ab = new ArrayBuffer(bufferSize);
  const view = new DataView(ab);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------- MP3 encoder (via lamejs from CDN) ----------
async function encodeMp3(audioBuffer, bitrate = 192, onProgress = null) {
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js', 'lamejs');
  const lamejs = window.lamejs;
  if (!lamejs) throw new Error('lamejs failed to load from CDN');

  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
  const sampleBlockSize = 1152;
  const mp3Data = [];

  const left = audioBuffer.getChannelData(0);
  const right = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

  const leftInt16 = new Int16Array(numSamples);
  const rightInt16 = numChannels > 1 ? new Int16Array(numSamples) : null;
  for (let i = 0; i < numSamples; i++) {
    leftInt16[i] = Math.max(-1, Math.min(1, left[i])) * 0x7FFF;
    if (rightInt16) rightInt16[i] = Math.max(-1, Math.min(1, right[i])) * 0x7FFF;
  }

  const totalBlocks = Math.ceil(numSamples / sampleBlockSize);
  for (let i = 0; i < numSamples; i += sampleBlockSize) {
    const leftChunk = leftInt16.subarray(i, i + sampleBlockSize);
    const rightChunk = rightInt16 ? rightInt16.subarray(i, i + sampleBlockSize) : null;
    const mp3buf = numChannels > 1
      ? mp3encoder.encodeBuffer(leftChunk, rightChunk)
      : mp3encoder.encodeBuffer(leftChunk);
    if (mp3buf.length > 0) mp3Data.push(new Uint8Array(mp3buf));
    if (onProgress && i % (sampleBlockSize * 200) === 0) {
      onProgress({ percent: Math.round((i / numSamples) * 100), stage: 'mp3' });
    }
  }
  const end = mp3encoder.flush();
  if (end.length > 0) mp3Data.push(new Uint8Array(end));

  const blob = new Blob(mp3Data, { type: 'audio/mp3' });
  if (onProgress) onProgress({ percent: 100, stage: 'mp3' });
  return blob;
}

// ---------- Decode via Web Audio API ----------
async function decodeWithWebAudio(arrayBuffer, onStatus) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio API not supported');
  const ctx = new AC();
  try {
    if (onStatus) onStatus('Decoding audio…');
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return audioBuffer;
  } finally {
    try { ctx.close(); } catch { /* ignore */ }
  }
}

// ---------- Real-time capture (fallback) ----------
async function captureViaMediaElement(blobOrUrl, onStatus, onProgress) {
  const video = document.createElement('video');
  video.src = typeof blobOrUrl === 'string' ? blobOrUrl : createObjectURL(blobOrUrl);
  video.muted = false;
  video.volume = 0.0001;
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  document.body.appendChild(video);

  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Video element failed to load')), { once: true });
    setTimeout(() => reject(new Error('Video metadata load timeout')), 15000);
  });

  if (typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') {
    video.remove();
    throw new Error('captureStream() not supported in this browser');
  }
  const stream = (video.captureStream || video.mozCaptureStream).call(video);
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    video.remove();
    throw new Error('No audio track found in this video');
  }

  const audioStream = new MediaStream(audioTracks);
  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const mimeType = mimeCandidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mimeType) {
    video.remove();
    throw new Error('MediaRecorder not supported');
  }

  const recorder = new MediaRecorder(audioStream, { mimeType, audioBitsPerSecond: 128000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  const donePromise = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  if (onStatus) onStatus('Recording audio in real time (playback at 1×)…');
  recorder.start(1000);

  video.currentTime = 0;
  try { await video.play(); } catch { /* ignore */ }

  const duration = video.duration || 0;
  const progressTimer = setInterval(() => {
    if (onProgress && duration > 0) {
      onProgress({ percent: Math.round((video.currentTime / duration) * 100), stage: 'capture' });
    }
  }, 500);

  await new Promise((resolve) => {
    video.addEventListener('ended', resolve, { once: true });
  });

  clearInterval(progressTimer);
  recorder.stop();
  const recordedBlob = await donePromise;
  video.pause();
  video.remove();
  return recordedBlob;
}

async function loadVideo() {
  if (STATE.busy) return;
  const input = document.getElementById('a2s-url-input');
  const url = (input?.value || '').trim();
  if (!isValidUrl(url)) {
    setStatus('❌ Please paste a valid video URL.', 'error');
    return;
  }

  clearStatus();
  hideProgressBar('a2s-progress');
  if (STATE.objectUrl) { revokeObjectURL(STATE.objectUrl); STATE.objectUrl = null; }
  STATE.blob = null;
  STATE.audioBuffer = null;

  setBusy(true, 'Loading…');
  setStatus('Fetching video file…', 'info');
  const ctrl = STATE.abort.newController();

  try {
    const res = await fetchWithTimeout(url, { mode: 'cors', signal: ctrl.signal }, 60000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const contentType = res.headers.get('content-type') || 'video/mp4';
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);

    setStatus(`Downloading video (${contentLength ? formatBytes(contentLength) : 'unknown size'})…`, 'info');
    const total = contentLength;
    const chunks = [];
    let received = 0;

    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const pct = total > 0 ? Math.round((received / total) * 100) : 0;
        updateProgressBar('a2s-progress', { percent: pct, received, total, label: 'Downloading video…' });
      }
    } else {
      const ab = await res.arrayBuffer();
      chunks.push(new Uint8Array(ab));
      received = ab.byteLength;
    }

    STATE.blob = new Blob(chunks, { type: contentType });
    STATE.filename = inferFilename(url, contentType);
    STATE.sourceMethod = 'Direct';

    setStatus(`✅ Video loaded (${formatBytes(STATE.blob.size)}). Decoding audio…`, 'info');
    updateProgressBar('a2s-progress', { percent: 100, received: STATE.blob.size, total: STATE.blob.size, label: 'Downloaded' });

    const arrayBuffer = await STATE.blob.arrayBuffer();
    try {
      STATE.audioBuffer = await decodeWithWebAudio(arrayBuffer, (m) => setStatus(m, 'info'));
      const dur = formatDuration(STATE.audioBuffer.duration);
      const sr = STATE.audioBuffer.sampleRate;
      const ch = STATE.audioBuffer.numberOfChannels;
      setStatus(`✅ Audio decoded · ${dur} · ${sr} Hz · ${ch === 1 ? 'Mono' : 'Stereo'}. Choose a format below.`, 'success');
      showInfo(dur, sr, ch);
    } catch (decodeErr) {
      setStatus(
        `⚠️ Web Audio couldn't decode this format (${decodeErr.message}).\n\n` +
        `You can still convert using real-time capture — press one of the format buttons and we'll play the video once while recording.`,
        'warning'
      );
      STATE.audioBuffer = null;
    }
    setBusy(false);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(
      `❌ Failed to load video: ${err.message}\n\n` +
      `If the host blocks browser access (CORS), download the video first with the Universal Downloader, then save it locally and use a local file (not supported here yet) or try a direct .mp4 link.`,
      'error'
    );
  } finally {
    STATE.abort.release(ctrl);
    setBusy(false);
  }
}

function showInfo(duration, sampleRate, channels) {
  const wrap = document.getElementById('a2s-info');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class="grid grid-cols-3 gap-2">
      <div class="flex flex-col gap-0.5 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700/60">
        <span class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Duration</span>
        <span class="text-sm font-semibold text-indigo-300">${escapeHtml(duration)}</span>
      </div>
      <div class="flex flex-col gap-0.5 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700/60">
        <span class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Sample Rate</span>
        <span class="text-sm font-semibold text-indigo-300">${sampleRate} Hz</span>
      </div>
      <div class="flex flex-col gap-0.5 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700/60">
        <span class="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Channels</span>
        <span class="text-sm font-semibold text-indigo-300">${channels === 1 ? 'Mono' : 'Stereo'}</span>
      </div>
    </div>
  `;
}

async function convert(format) {
  if (STATE.busy) return;
  if (!STATE.blob && !STATE.audioBuffer) {
    setStatus('⚠️ Load a video first.', 'warning');
    return;
  }
  setBusy(true, 'Converting…');
  clearStatus();
  const ctrl = STATE.abort.newController();
  const baseName = (STATE.filename || 'audio').replace(/\.[^.]+$/, '');

  try {
    let outputBlob = null;
    let ext = format;

    if (format === 'wav' && STATE.audioBuffer) {
      setStatus('Encoding WAV…', 'info');
      outputBlob = audioBufferToWav(STATE.audioBuffer);
    } else if (format === 'mp3' && STATE.audioBuffer) {
      setStatus('Encoding MP3 — first run downloads lamejs from CDN (approx. 200 KB)…', 'info');
      const bitrate = parseInt(document.getElementById('a2s-bitrate')?.value || '192', 10);
      outputBlob = await encodeMp3(STATE.audioBuffer, bitrate, (p) => {
        updateProgressBar('a2s-progress', { percent: p.percent, received: 0, total: 0, label: `Encoding MP3… ${p.percent}%` });
      });
    } else {
      // Fallback: real-time capture (works when Web Audio can't decode but video can play)
      setStatus('Falling back to real-time audio capture. Video will play once at 1× speed…', 'warning');
      const captured = await captureViaMediaElement(STATE.blob || STATE.objectUrl, (m) => setStatus(m, 'info'), (p) => {
        updateProgressBar('a2s-progress', { percent: p.percent, received: 0, total: 0, label: `Recording… ${p.percent}%` });
      });
      if (format === 'mp3') {
        // Convert captured webm to wav then mp3 (best effort)
        try {
          const ab = await captured.arrayBuffer();
          const audioBuffer = await decodeWithWebAudio(ab, (m) => setStatus(m, 'info'));
          const bitrate = parseInt(document.getElementById('a2s-bitrate')?.value || '192', 10);
          outputBlob = await encodeMp3(audioBuffer, bitrate, (p) => {
            updateProgressBar('a2s-progress', { percent: p.percent, received: 0, total: 0, label: `Encoding MP3… ${p.percent}%` });
          });
          ext = 'mp3';
        } catch {
          outputBlob = captured;
          ext = captured.type.includes('webm') ? 'webm' : 'ogg';
          setStatus('⚠️ Captured as WebM audio (MP3 conversion failed).', 'warning');
        }
      } else if (format === 'wav') {
        try {
          const ab = await captured.arrayBuffer();
          const audioBuffer = await decodeWithWebAudio(ab, (m) => setStatus(m, 'info'));
          outputBlob = audioBufferToWav(audioBuffer);
          ext = 'wav';
        } catch {
          outputBlob = captured;
          ext = 'webm';
          setStatus('⚠️ Captured as WebM audio (WAV conversion failed).', 'warning');
        }
      } else {
        outputBlob = captured;
        ext = captured.type.includes('webm') ? 'webm' : 'ogg';
      }
    }

    if (!outputBlob || outputBlob.size === 0) {
      throw new Error('Conversion produced an empty file.');
    }

    const filename = `${baseName}.${ext}`;
    updateProgressBar('a2s-progress', { percent: 100, received: outputBlob.size, total: outputBlob.size, label: 'Complete' });
    setStatus(`✅ Ready: ${filename} (${formatBytes(outputBlob.size)}). Downloading…`, 'success');
    downloadBlob(outputBlob, filename);
    showToast(`✅ ${ext.toUpperCase()} downloaded`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`❌ Conversion failed: ${err.message}`, 'error');
    hideProgressBar('a2s-progress');
  } finally {
    STATE.abort.release(ctrl);
    setBusy(false);
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
            <span>🎵</span> Video → MP3 / WAV
          </h2>
          <p class="text-sm text-slate-400 mt-1">Extract audio from any video — encode as MP3, WAV, or WebM. All in-browser.</p>
        </div>
        <button onclick="goHome()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">
          ← Back
        </button>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <label for="a2s-url-input" class="block text-xs font-bold uppercase tracking-wider text-slate-400">Video URL</label>
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            id="a2s-url-input"
            type="url"
            placeholder="https://example.com/video.mp4"
            class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="a2s-load-btn" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed min-w-[160px]">
            <svg id="a2s-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
            <span id="a2s-load-text">Load Video</span>
          </button>
        </div>

        <div id="a2s-status" class="hidden mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed"></div>
        ${createProgressBarHTML('a2s-progress')}
      </div>

      <div id="a2s-info" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4"></div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Choose Output Format</h3>
        <div class="flex flex-wrap gap-2">
          <button class="a2s-convert-btn px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed" data-format="mp3">
            🎵 MP3
          </button>
          <button class="a2s-convert-btn px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed" data-format="wav">
            🎼 WAV (lossless)
          </button>
          <button class="a2s-convert-btn px-5 py-3 rounded-xl bg-gradient-to-r from-fuchsia-600 to-fuchsia-500 hover:from-fuchsia-500 hover:to-fuchsia-400 text-white text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed" data-format="webm">
            🔊 WebM (Opus)
          </button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="block">
            <span class="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">MP3 Bitrate (kbps)</span>
            <select id="a2s-bitrate" class="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
              <option value="128">128</option>
              <option value="192" selected>192</option>
              <option value="256">256</option>
              <option value="320">320</option>
            </select>
          </label>
        </div>
      </div>

      <div class="rounded-xl bg-slate-900/40 border border-slate-800/60 px-4 py-3 text-xs text-slate-500 leading-relaxed">
        <strong class="text-slate-400">Two methods:</strong> Fast method decodes the full audio via Web Audio API (seconds). If that fails, we fall back to real-time capture (video plays once at 1× while recording — works even for many DRM-free streams). MP3 encoding uses lamejs loaded on demand from CDN.
      </div>
    </div>
  `;

  document.getElementById('a2s-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); loadVideo(); }
  });
  document.getElementById('a2s-load-btn')?.addEventListener('click', loadVideo);

  document.querySelectorAll('.a2s-convert-btn').forEach((btn) => {
    btn.disabled = true;
    btn.addEventListener('click', () => convert(btn.dataset.format));
  });
}
