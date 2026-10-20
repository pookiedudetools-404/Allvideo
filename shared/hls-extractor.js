// tools/hls-extractor.js — HLS / M3U8 Extractor

import {
  showToast,
  escapeHtml,
  formatBytes,
  isValidUrl,
  fetchWithTimeout,
  parseM3U8,
  downloadBlob,
  createProgressBarHTML,
  updateProgressBar,
  hideProgressBar,
  createAbortRegistry,
} from '../shared/utils.js';

const STATE = {
  url: '',
  masterUrl: '',
  finalUrl: '',
  variants: [],
  segments: [],
  selectedVariant: null,
  abort: createAbortRegistry(),
  busy: false,
};

export function cleanup() {
  STATE.abort.abortAll();
  STATE.variants = [];
  STATE.segments = [];
  STATE.selectedVariant = null;
  STATE.busy = false;
}

function setBusy(busy, label = '') {
  STATE.busy = busy;
  const btn = document.getElementById('hls-analyze-btn');
  const input = document.getElementById('hls-url-input');
  const spinner = document.getElementById('hls-spinner');
  const text = document.getElementById('hls-analyze-text');
  if (btn) btn.disabled = busy;
  if (input) input.disabled = busy;
  if (spinner) spinner.classList.toggle('hidden', !busy);
  if (text) text.textContent = busy ? (label || 'Working…') : 'Analyze Playlist';
}

function setStatus(msg, kind = 'info') {
  const box = document.getElementById('hls-status');
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
  const box = document.getElementById('hls-status');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

async function loadPlaylist(url) {
  const res = await fetchWithTimeout(url, { mode: 'cors' }, 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return { text, finalUrl: res.url || url };
}

async function analyze() {
  if (STATE.busy) return;
  const input = document.getElementById('hls-url-input');
  const url = (input?.value || '').trim();
  if (!isValidUrl(url)) {
    setStatus('❌ Please paste a valid .m3u8 URL.', 'error');
    return;
  }

  clearStatus();
  STATE.url = url;
  STATE.masterUrl = url;
  STATE.variants = [];
  STATE.segments = [];
  STATE.selectedVariant = null;

  document.getElementById('hls-variants-panel')?.classList.add('hidden');
  document.getElementById('hls-segments-panel')?.classList.add('hidden');
  hideProgressBar('hls-progress');

  setBusy(true, 'Fetching playlist…');
  setStatus('Fetching playlist…', 'info');

  try {
    const { text, finalUrl } = await loadPlaylist(url);
    STATE.finalUrl = finalUrl;
    const parsed = parseM3U8(text, finalUrl);

    if (parsed.isMaster && parsed.variants.length > 0) {
      setStatus(`✅ Master playlist with ${parsed.variants.length} variant(s). Select a quality below.`, 'success');
      STATE.variants = parsed.variants;
      renderVariants();
    } else if (parsed.segments.length > 0) {
      setStatus(`✅ Media playlist with ${parsed.segments.length} segment(s). Ready to download.`, 'success');
      STATE.segments = parsed.segments;
      renderSegments();
    } else {
      throw new Error('Playlist has no variants or segments.');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(
      `❌ Failed to load playlist: ${err.message}\n\n` +
      `This usually happens when the host blocks browser requests (CORS). ` +
      `Try again — some servers work intermittently, or use a different URL.`,
      'error'
    );
  } finally {
    setBusy(false);
  }
}

function renderVariants() {
  const panel = document.getElementById('hls-variants-panel');
  const list = document.getElementById('hls-variants-list');
  if (!panel || !list) return;
  panel.classList.remove('hidden');

  if (STATE.variants.length === 0) {
    list.innerHTML = '<p class="text-sm text-slate-500">No variants.</p>';
    return;
  }

  list.innerHTML = STATE.variants.map((v, i) => `
    <button data-variant-index="${i}" class="hls-variant-btn w-full text-left flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 hover:border-indigo-500/60 transition">
      <div class="flex items-center gap-3">
        <span class="text-lg">${v.resolution ? '🎞️' : '📄'}</span>
        <div>
          <p class="font-semibold text-slate-100">${escapeHtml(v.resolution || 'Unknown resolution')}</p>
          <p class="text-xs text-slate-500">${v.bandwidth ? Math.round(v.bandwidth / 1000) + ' kbps' : 'bitrate unknown'}</p>
        </div>
      </div>
      <span class="text-xs font-semibold text-indigo-400">Select →</span>
    </button>
  `).join('');

  list.querySelectorAll('.hls-variant-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.variantIndex, 10);
      selectVariant(idx);
    });
  });
}

async function selectVariant(index) {
  const v = STATE.variants[index];
  if (!v || !v.uri) return;
  clearStatus();
  setBusy(true, 'Loading variant…');
  setStatus(`Loading variant ${v.resolution || ''}…`, 'info');
  try {
    const { text, finalUrl } = await loadPlaylist(v.uri);
    const parsed = parseM3U8(text, finalUrl);
    if (parsed.segments.length === 0) throw new Error('Variant playlist has no segments.');
    STATE.segments = parsed.segments;
    STATE.selectedVariant = v;
    setStatus(`✅ Variant "${v.resolution || 'selected'}" loaded — ${parsed.segments.length} segments ready.`, 'success');
    renderSegments();
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`❌ Failed to load variant: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

function renderSegments() {
  const panel = document.getElementById('hls-segments-panel');
  const summary = document.getElementById('hls-segments-summary');
  const list = document.getElementById('hls-segments-list');
  if (!panel || !summary || !list) return;
  panel.classList.remove('hidden');

  const totalDur = STATE.segments.reduce((s, seg) => s + (seg.duration || 0), 0);
  summary.innerHTML = `
    <div class="flex flex-wrap gap-3 text-xs">
      <span class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700"><strong class="text-indigo-300">${STATE.segments.length}</strong> segments</span>
      <span class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700"><strong class="text-indigo-300">${Math.round(totalDur)}</strong>s total</span>
      ${STATE.selectedVariant ? `<span class="px-3 py-1.5 rounded-lg bg-emerald-900/40 border border-emerald-700/60 text-emerald-300">${escapeHtml(STATE.selectedVariant.resolution || 'Variant')}</span>` : ''}
    </div>
  `;

  list.innerHTML = STATE.segments.slice(0, 200).map((seg, i) => `
    <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800 text-xs">
      <span class="text-slate-400 font-mono">#${i + 1}</span>
      <span class="flex-1 text-slate-500 truncate font-mono text-[10px]">${escapeHtml(seg.uri.split('/').pop() || seg.uri)}</span>
      <span class="text-slate-600">${seg.duration ? seg.duration + 's' : ''}</span>
    </div>
  `).join('') + (STATE.segments.length > 200 ? `<p class="text-center text-xs text-slate-500 pt-2">…and ${STATE.segments.length - 200} more segments</p>` : '');
}

async function download() {
  if (STATE.busy) return;
  if (STATE.segments.length === 0) {
    setStatus('⚠️ No segments loaded. Click "Analyze Playlist" first.', 'warning');
    return;
  }

  setBusy(true, 'Downloading segments…');
  setStatus(`Downloading ${STATE.segments.length} segments…`, 'info');

  const ctrl = STATE.abort.newController();
  const parts = [];

  try {
    for (let i = 0; i < STATE.segments.length; i++) {
      if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const seg = STATE.segments[i];
      const res = await fetchWithTimeout(seg.uri, { mode: 'cors', signal: ctrl.signal }, 30000);
      if (!res.ok) {
        setStatus(`Segment ${i + 1} failed (HTTP ${res.status}). Continuing with available segments…`, 'warning');
        continue;
      }
      const buf = await res.arrayBuffer();
      parts.push(new Uint8Array(buf));
      const pct = Math.round(((i + 1) / STATE.segments.length) * 100);
      updateProgressBar('hls-progress', {
        percent: pct,
        received: parts.reduce((s, p) => s + p.length, 0),
        total: 0,
        label: `Segment ${i + 1}/${STATE.segments.length}`,
      });
    }

    if (parts.length === 0) throw new Error('All segments failed to download.');

    const blob = new Blob(parts, { type: 'video/mp2t' });
    const filename = `hls_extract_${Date.now()}.ts`;
    updateProgressBar('hls-progress', { percent: 100, received: blob.size, total: blob.size, label: 'Complete' });
    setStatus(`✅ Downloaded ${parts.length} segments (${formatBytes(blob.size)}). Saving as .ts…`, 'success');

    downloadBlob(blob, filename);
    showToast(`✅ HLS extraction complete: ${filename}`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`❌ Download failed: ${err.message}`, 'error');
    hideProgressBar('hls-progress');
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
            <span>📡</span> HLS / M3U8 Extractor
          </h2>
          <p class="text-sm text-slate-400 mt-1">Analyze .m3u8 playlists, pick a quality, and merge all segments into one .ts file.</p>
        </div>
        <button onclick="goHome()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition">
          ← Back
        </button>
      </div>

      <div class="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-4">
        <label for="hls-url-input" class="block text-xs font-bold uppercase tracking-wider text-slate-400">Playlist URL (.m3u8)</label>
        <div class="flex flex-col sm:flex-row gap-2">
          <input
            id="hls-url-input"
            type="url"
            placeholder="https://example.com/stream.m3u8"
            class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            autocomplete="off"
            spellcheck="false"
          />
          <button id="hls-analyze-btn" class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed min-w-[160px]">
            <svg id="hls-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25"/><path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"/></svg>
            <span id="hls-analyze-text">Analyze Playlist</span>
          </button>
        </div>

        <div id="hls-status" class="hidden mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed"></div>
        ${createProgressBarHTML('hls-progress')}
      </div>

      <div id="hls-variants-panel" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5">
        <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400 mb-3">Select Quality</h3>
        <div id="hls-variants-list" class="space-y-2"></div>
      </div>

      <div id="hls-segments-panel" class="hidden rounded-2xl bg-slate-900/70 border border-slate-800 p-4 sm:p-5 space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <h3 class="text-sm font-bold uppercase tracking-wider text-slate-400">Segments</h3>
          <button id="hls-download-btn" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition">
            ⬇️ Download & Merge Segments
          </button>
        </div>
        <div id="hls-segments-summary"></div>
        <div id="hls-segments-list" class="max-h-[400px] overflow-y-auto space-y-1 rounded-xl"></div>
      </div>

      <div class="rounded-xl bg-slate-900/40 border border-slate-800/60 px-4 py-3 text-xs text-slate-500 leading-relaxed">
        <strong class="text-slate-400">What's a .m3u8?</strong> It's a playlist file used by HLS video streams (YouTube Live, Twitch, online courses, most streaming sites). The actual video is split into many .ts segment files. This tool fetches the playlist, downloads all segments, and merges them into a single .ts file you can play in VLC or convert to MP4 later.
      </div>
    </div>
  `;

  document.getElementById('hls-url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); analyze(); }
  });
  document.getElementById('hls-analyze-btn')?.addEventListener('click', analyze);
  document.getElementById('hls-download-btn')?.addEventListener('click', download);
}
