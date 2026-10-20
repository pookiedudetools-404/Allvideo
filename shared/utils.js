// shared/utils.js — Global utility library for VideoToolkit
// ES module. Also exposes window.VTUtils for legacy access.

// ============================================================
// TOAST / NOTIFICATION
// ============================================================
export function showToast(message, type = 'info', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none';
    document.body.appendChild(container);
  }
  const colors = {
    info: 'bg-slate-800 border-slate-700 text-slate-100',
    success: 'bg-emerald-900/90 border-emerald-700 text-emerald-100',
    error: 'bg-red-900/90 border-red-700 text-red-100',
    warning: 'bg-amber-900/90 border-amber-700 text-amber-100',
  };
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg max-w-sm text-sm font-medium fade-in ${colors[type] || colors.info}`;
  toast.innerHTML = `<span class="shrink-0">${icons[type] || icons.info}</span><span class="flex-1">${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// ============================================================
// HTML / TEXT HELPERS
// ============================================================
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0 || bytes == null || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function debounce(fn, wait = 300) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// ============================================================
// URL / FORMAT UTILITIES
// ============================================================
export function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function detectMediaFormat(url, contentType = '') {
  const lowerUrl = (url || '').toLowerCase().split('?')[0].split('#')[0];
  const ct = (contentType || '').toLowerCase();

  if (lowerUrl.endsWith('.m3u8') || ct.includes('mpegurl')) return { format: 'hls', ext: 'ts', kind: 'video' };
  if (lowerUrl.endsWith('.mpd') || ct.includes('dash+xml')) return { format: 'dash', ext: 'mp4', kind: 'video' };
  if (lowerUrl.endsWith('.mp4') || ct.includes('video/mp4')) return { format: 'mp4', ext: 'mp4', kind: 'video' };
  if (lowerUrl.endsWith('.webm') || ct.includes('video/webm')) return { format: 'webm', ext: 'webm', kind: 'video' };
  if (lowerUrl.endsWith('.mkv') || ct.includes('matroska')) return { format: 'mkv', ext: 'mkv', kind: 'video' };
  if (lowerUrl.endsWith('.mov') || ct.includes('quicktime')) return { format: 'mov', ext: 'mov', kind: 'video' };
  if (lowerUrl.endsWith('.avi') || ct.includes('x-msvideo')) return { format: 'avi', ext: 'avi', kind: 'video' };
  if (lowerUrl.endsWith('.mp3') || ct.includes('audio/mpeg')) return { format: 'mp3', ext: 'mp3', kind: 'audio' };
  if (lowerUrl.endsWith('.wav') || ct.includes('audio/wav')) return { format: 'wav', ext: 'wav', kind: 'audio' };
  if (lowerUrl.endsWith('.ogg') || ct.includes('audio/ogg')) return { format: 'ogg', ext: 'ogg', kind: 'audio' };
  if (lowerUrl.endsWith('.m4a') || ct.includes('audio/mp4')) return { format: 'm4a', ext: 'm4a', kind: 'audio' };
  if (ct.startsWith('video/')) return { format: 'video', ext: 'mp4', kind: 'video' };
  if (ct.startsWith('audio/')) return { format: 'audio', ext: 'mp3', kind: 'audio' };
  if (ct.includes('mpegurl')) return { format: 'hls', ext: 'ts', kind: 'video' };
  return { format: 'unknown', ext: 'bin', kind: 'unknown' };
}

export function inferFilename(url, contentType = '', fallbackExt = 'mp4') {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    if (last && /\.\w{2,5}$/.test(last)) {
      return decodeURIComponent(last);
    }
    if (last) {
      return `${decodeURIComponent(last)}.${fallbackExt}`;
    }
  } catch { /* ignore */ }
  const det = detectMediaFormat(url, contentType);
  return `video_${Date.now()}.${det.ext || fallbackExt}`;
}

export function parseContentDisposition(header) {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try { return decodeURIComponent(utf8Match[1]); } catch { return utf8Match[1]; }
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  if (plainMatch) return plainMatch[1];
  return null;
}

// ============================================================
// FETCH HELPERS (retry, timeout, abort)
// ============================================================
export function createAbortRegistry() {
  const controllers = new Set();
  return {
    newController() {
      const c = new AbortController();
      controllers.add(c);
      return c;
    },
    abortAll() {
      for (const c of controllers) {
        try { c.abort(); } catch { /* ignore */ }
      }
      controllers.clear();
    },
    release(controller) {
      controllers.delete(controller);
    },
  };
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithRetry(url, opts = {}, { attempts = 3, baseDelay = 1000, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, opts, timeoutMs);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500) {
        return res;
      }
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      if (i < attempts - 1) await sleep(baseDelay * Math.pow(2, i));
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') throw err;
      if (i < attempts - 1) await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr || new Error('Fetch failed after retries');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// CORS PROXY ROTATOR
// ============================================================
export const CORS_PROXIES = [
  {
    name: 'corsproxy.io',
    build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  },
  {
    name: 'allorigins.win',
    build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: 'thingproxy.freeboard.io',
    build: (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
  },
  {
    name: 'codetabs.com',
    build: (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  },
];

export async function fetchViaProxy(url, opts = {}, onProgress = null) {
  const errors = [];
  for (let i = 0; i < CORS_PROXIES.length; i++) {
    const proxy = CORS_PROXIES[i];
    if (onProgress) onProgress({ stage: 'proxy', index: i + 1, total: CORS_PROXIES.length, name: proxy.name });
    try {
      const proxied = proxy.build(url);
      const res = await fetchWithTimeout(proxied, { ...opts, mode: 'cors' }, 20000);
      if (res.ok) {
        return { response: res, proxyName: proxy.name };
      }
      errors.push(`${proxy.name}: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${proxy.name}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    }
  }
  const error = new Error(`All CORS proxies failed. ${errors.join(' | ')}`);
  error.proxyErrors = errors;
  throw error;
}

// ============================================================
// BLOB & DOWNLOAD MANAGEMENT
// ============================================================
const _objectUrls = new Set();

export function createObjectURL(blob) {
  const url = URL.createObjectURL(blob);
  _objectUrls.add(url);
  return url;
}

export function revokeObjectURL(url) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  _objectUrls.delete(url);
}

export function revokeAllObjectURLs() {
  for (const url of _objectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  _objectUrls.clear();
}

export function downloadBlob(blob, filename) {
  const url = createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `download_${Date.now()}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    setTimeout(() => revokeObjectURL(url), 5000);
  }, 100);
}

export function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `download_${Date.now()}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 100);
}

// ============================================================
// STREAMING DOWNLOAD WITH PROGRESS
// ============================================================
export async function fetchBlobWithProgress(url, opts = {}, onProgress = null) {
  const res = opts.response || (await fetchWithTimeout(url, { ...opts, mode: 'cors' }, 60000));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const contentType = res.headers.get('content-type') || '';
  const chunks = [];
  let received = 0;

  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob();
    if (onProgress) onProgress({ received: blob.size, total: blob.size, done: true });
    return { blob, contentType, size: blob.size, total: blob.size };
  }

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) {
      const pct = total > 0 ? Math.round((received / total) * 100) : 0;
      onProgress({ received, total, percent: pct, done: false });
    }
  }

  const blob = new Blob(chunks, { type: contentType || 'application/octet-stream' });
  if (onProgress) onProgress({ received, total: total || received, percent: 100, done: true });
  return { blob, contentType, size: blob.size, total: total || blob.size };
}

// ============================================================
// RANGE-BASED CHUNKED DOWNLOAD (for huge files)
// ============================================================
export async function fetchBlobRange(url, { chunkSize = 5 * 1024 * 1024, onProgress = null, signal = null } = {}) {
  const headRes = await fetchWithTimeout(url, { method: 'HEAD', mode: 'cors', signal }, 15000);
  if (!headRes.ok) throw new Error(`HEAD failed: HTTP ${headRes.status}`);
  const total = parseInt(headRes.headers.get('content-length') || '0', 10);
  const contentType = headRes.headers.get('content-type') || '';
  const acceptRanges = (headRes.headers.get('accept-ranges') || '').toLowerCase();

  if (total === 0 || acceptRanges !== 'bytes') {
    throw new Error('Server does not support range requests or reported empty file.');
  }

  const totalChunks = Math.ceil(total / chunkSize);
  const parts = [];
  let received = 0;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, total - 1);
    const res = await fetchWithTimeout(url, {
      mode: 'cors',
      signal,
      headers: { Range: `bytes=${start}-${end}` },
    }, 45000);
    if (!res.ok) throw new Error(`Chunk ${i + 1} failed: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    parts.push(new Uint8Array(buf));
    received += buf.byteLength;
    if (onProgress) {
      onProgress({
        received,
        total,
        percent: Math.round((received / total) * 100),
        chunk: i + 1,
        totalChunks,
        done: i === totalChunks - 1,
      });
    }
  }

  const blob = new Blob(parts, { type: contentType || 'application/octet-stream' });
  return { blob, contentType, size: blob.size, total };
}

// ============================================================
// HLS PLAYLIST PARSER & DOWNLOADER
// ============================================================
export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const segments = [];
  let currentDuration = null;
  let isMaster = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      variants.push({
        bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
        resolution: resMatch ? `${resMatch[1]}x${resMatch[2]}` : null,
        uri: null,
      });
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const dMatch = line.match(/#EXTINF:([\d.]+)/);
      currentDuration = dMatch ? parseFloat(dMatch[1]) : 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    const absolute = new URL(line, baseUrl).href;
    if (isMaster && variants.length > 0 && variants[variants.length - 1].uri === null) {
      variants[variants.length - 1].uri = absolute;
    } else {
      segments.push({ uri: absolute, duration: currentDuration || 0 });
      currentDuration = null;
    }
  }

  return { isMaster, variants, segments };
}

export async function loadHlsJs() {
  if (window.Hls) return window.Hls;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
    s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js loaded but window.Hls missing')));
    s.onerror = () => reject(new Error('Failed to load hls.js from CDN'));
    document.head.appendChild(s);
  });
}

export async function downloadHlsStream(m3u8Url, { onProgress = null, signal = null } = {}) {
  const loadPlaylist = async (url) => {
    const res = await fetchWithTimeout(url, { mode: 'cors', signal }, 20000);
    if (!res.ok) throw new Error(`Playlist fetch failed: HTTP ${res.status}`);
    return { text: await res.text(), finalUrl: res.url || url };
  };

  if (onProgress) onProgress({ stage: 'playlist', message: 'Fetching master playlist…' });
  let { text, finalUrl } = await loadPlaylist(m3u8Url);
  let parsed = parseM3U8(text, finalUrl);

  if (parsed.isMaster && parsed.variants.length > 0) {
    const best = parsed.variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
    if (onProgress) onProgress({ stage: 'variant', message: `Selected variant ${best.resolution || best.bandwidth}` });
    ({ text, finalUrl } = await loadPlaylist(best.uri));
    parsed = parseM3U8(text, finalUrl);
  }

  if (parsed.segments.length === 0) throw new Error('No segments found in playlist.');

  const segments = parsed.segments;
  const total = segments.length;
  const parts = [];

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const seg = segments[i];
    const res = await fetchWithTimeout(seg.uri, { mode: 'cors', signal }, 30000);
    if (!res.ok) throw new Error(`Segment ${i + 1} failed: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    parts.push(new Uint8Array(buf));
    if (onProgress) {
      onProgress({
        stage: 'segment',
        current: i + 1,
        total,
        percent: Math.round(((i + 1) / total) * 100),
      });
    }
  }

  const blob = new Blob(parts, { type: 'video/mp2t' });
  return { blob, segmentCount: total, size: blob.size };
}

// ============================================================
// DASH MPD PARSER (basic SegmentTemplate support)
// ============================================================
export function parseMPD(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const mpd = doc.querySelector('MPD');
  if (!mpd) throw new Error('Invalid MPD file');

  const mediaPresentationDuration = mpd.getAttribute('mediaPresentationDuration');
  const adaptations = Array.from(doc.querySelectorAll('AdaptationSet'));
  const videoSets = adaptations.filter((a) => (a.getAttribute('contentType') || a.getAttribute('mimeType') || '').includes('video'));

  const results = [];
  for (const as of videoSets) {
    const reps = Array.from(as.querySelectorAll('Representation'));
    for (const rep of reps) {
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
      const segTemplate = rep.querySelector('SegmentTemplate') || as.querySelector('SegmentTemplate');
      if (!segTemplate) continue;

      const init = segTemplate.getAttribute('initialization');
      const media = segTemplate.getAttribute('media');
      const startNumber = parseInt(segTemplate.getAttribute('startNumber') || '1', 10);
      const timescale = parseInt(segTemplate.getAttribute('timescale') || '1', 10);
      const duration = parseInt(segTemplate.getAttribute('duration') || '0', 10);
      const timeline = segTemplate.querySelector('SegmentTimeline');

      let segCount = 0;
      let segDurations = [];
      if (timeline) {
        const S = Array.from(timeline.querySelectorAll('S'));
        for (const s of S) {
          const r = parseInt(s.getAttribute('r') || '0', 10);
          const d = parseInt(s.getAttribute('d') || '0', 10);
          segDurations.push(d);
          for (let i = 0; i < r; i++) segDurations.push(d);
        }
        segCount = segDurations.length;
      } else if (duration > 0 && mediaPresentationDuration) {
        const totalSec = parseISODuration(mediaPresentationDuration);
        segCount = Math.ceil((totalSec * timescale) / duration);
      }
      if (segCount === 0) continue;

      results.push({
        bandwidth,
        init,
        media,
        startNumber,
        segCount,
        segDurations,
        timescale,
        baseUrl: rep.getAttribute('baseURL') || baseUrl,
      });
    }
  }
  return results;
}

function parseISODuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  const h = parseFloat(m[1] || 0);
  const min = parseFloat(m[2] || 0);
  const s = parseFloat(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

export async function downloadDashStream(mpdUrl, { onProgress = null, signal = null } = {}) {
  const res = await fetchWithTimeout(mpdUrl, { mode: 'cors', signal }, 20000);
  if (!res.ok) throw new Error(`MPD fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const reps = parseMPD(text, res.url || mpdUrl);
  if (reps.length === 0) throw new Error('No downloadable video representations found in MPD.');
  const best = reps.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));

  const resolveUrl = (tpl, number) => {
    const filled = tpl.replace(/\$RepresentationID\$/g, '').replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => {
      const n = String(number);
      return pad ? n.padStart(parseInt(pad, 10), '0') : n;
    }).replace(/\$Time(?:%0(\d+)d)?\$/g, (_, pad) => {
      const t = String(number);
      return pad ? t.padStart(parseInt(pad, 10), '0') : t;
    });
    return new URL(filled, best.baseUrl || mpdUrl).href;
  };

  const parts = [];
  if (best.init) {
    const initRes = await fetchWithTimeout(resolveUrl(best.init, best.startNumber), { mode: 'cors', signal }, 30000);
    if (initRes.ok) parts.push(new Uint8Array(await initRes.arrayBuffer()));
  }

  for (let i = 0; i < best.segCount; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const num = best.startNumber + i;
    const segRes = await fetchWithTimeout(resolveUrl(best.media, num), { mode: 'cors', signal }, 30000);
    if (!segRes.ok) continue;
    parts.push(new Uint8Array(await segRes.arrayBuffer()));
    if (onProgress) {
      onProgress({
        stage: 'segment',
        current: i + 1,
        total: best.segCount,
        percent: Math.round(((i + 1) / best.segCount) * 100),
      });
    }
  }

  const blob = new Blob(parts, { type: 'video/mp4' });
  return { blob, segmentCount: best.segCount, size: blob.size };
}

// ============================================================
// UNIFIED SMART DOWNLOAD (auto-fallback chain)
// ============================================================
export async function smartDownload(url, {
  onStatus = null,
  onProgress = null,
  signal = null,
  useRangeThreshold = 50 * 1024 * 1024,
  chunkSize = 5 * 1024 * 1024,
  attempts = 3,
} = {}) {
  if (!isValidUrl(url)) throw new Error('Invalid URL. Must start with http:// or https://');

  const status = (msg, kind = 'info') => { if (onStatus) onStatus({ message: msg, kind }); };
  const detected = detectMediaFormat(url);

  if (detected.format === 'hls') {
    status('Detected HLS (.m3u8) stream — downloading segments…');
    const { blob, size, segmentCount } = await downloadHlsStream(url, { onProgress, signal });
    const filename = `hls_stream_${Date.now()}.ts`;
    return { blob, filename, method: 'hls', size, extra: { segmentCount } };
  }

  if (detected.format === 'dash') {
    status('Detected DASH (.mpd) stream — downloading segments…');
    const { blob, size, segmentCount } = await downloadDashStream(url, { onProgress, signal });
    const filename = `dash_stream_${Date.now()}.mp4`;
    return { blob, filename, method: 'dash', size, extra: { segmentCount } };
  }

  status('Attempting direct download…');
  try {
    const res = await fetchWithTimeout(url, { mode: 'cors', signal }, 30000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    const disposition = res.headers.get('content-disposition') || '';

    if (contentLength > useRangeThreshold) {
      status(`Large file (${formatBytes(contentLength)}) — switching to chunked download…`);
      try {
        const { blob, size } = await fetchBlobRange(url, { chunkSize, onProgress, signal });
        const filename = parseContentDisposition(disposition) || inferFilename(url, contentType);
        return { blob, filename, method: 'direct-range', size };
      } catch (rangeErr) {
        status('Range download failed — falling back to full stream download…', 'warning');
      }
    }

    const { blob, size } = await fetchBlobWithProgress(url, { response: res }, onProgress);
    const filename = parseContentDisposition(disposition) || inferFilename(url, contentType);
    return { blob, filename, method: 'direct', size };
  } catch (directErr) {
    if (directErr.name === 'AbortError') throw directErr;
    status(`Direct download failed (${directErr.message}). Trying CORS proxies…`, 'warning');
  }

  try {
    const { response: proxiedRes, proxyName } = await fetchViaProxy(url, { signal }, ({ index, total, name }) => {
      status(`Trying CORS mirror ${index}/${total} (${name})…`, 'info');
    });
    const contentType = proxiedRes.headers.get('content-type') || '';
    const disposition = proxiedRes.headers.get('content-disposition') || '';
    const { blob, size } = await fetchBlobWithProgress(url, { response: proxiedRes }, onProgress);
    const filename = parseContentDisposition(disposition) || inferFilename(url, contentType);
    return { blob, filename, method: `proxy:${proxyName}`, size };
  } catch (proxyErr) {
    if (proxyErr.name === 'AbortError') throw proxyErr;
    status('All automatic methods failed.', 'error');
    const error = new Error(
      'The host blocks browser downloads (CORS restriction). ' +
      'Try opening the URL in a new tab and saving the file manually, ' +
      'or use the "Download via Proxy" option with a different URL.'
    );
    error.directError = proxyErr;
    error.details = proxyErr.proxyErrors || [];
    throw error;
  }
}

// ============================================================
// MEDIA ELEMENT HELPERS
// ============================================================
export function waitForMediaReady(element, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (element.readyState >= 2) return resolve(element);
    const cleanup = () => {
      element.removeEventListener('loadedmetadata', onOk);
      element.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const onOk = () => { cleanup(); resolve(element); };
    const onErr = () => { cleanup(); reject(new Error('Media failed to load')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for media metadata'));
    }, timeoutMs);
    element.addEventListener('loadedmetadata', onOk, { once: true });
    element.addEventListener('error', onErr, { once: true });
  });
}

export function loadScriptOnce(src, globalCheckName) {
  if (globalCheckName && window[globalCheckName]) return Promise.resolve(window[globalCheckName]);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalCheckName ? window[globalCheckName] : true));
      existing.addEventListener('error', () => reject(new Error(`Failed loading ${src}`)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(globalCheckName ? window[globalCheckName] : true);
    s.onerror = () => reject(new Error(`Failed loading ${src}`));
    document.head.appendChild(s);
  });
}

// ============================================================
// DOM / UI BUILDERS
// ============================================================
export function createProgressBarHTML(id = 'progress') {
  return `
    <div id="${id}-wrap" class="hidden mt-4">
      <div class="flex items-center justify-between text-xs text-slate-400 mb-2">
        <span id="${id}-label">Downloading…</span>
        <span id="${id}-stats">0% · 0 B / 0 B</span>
      </div>
      <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
        <div id="${id}-bar" class="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all duration-200" style="width:0%"></div>
      </div>
    </div>
  `;
}

export function updateProgressBar(id, { percent = 0, received = 0, total = 0, label = null } = {}) {
  const wrap = document.getElementById(`${id}-wrap`);
  const bar = document.getElementById(`${id}-bar`);
  const stats = document.getElementById(`${id}-stats`);
  const labelEl = document.getElementById(`${id}-label`);
  if (!wrap || !bar || !stats) return;
  wrap.classList.remove('hidden');
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  stats.textContent = `${percent}% · ${formatBytes(received)} / ${total ? formatBytes(total) : '?'}`;
  if (label && labelEl) labelEl.textContent = label;
}

export function hideProgressBar(id) {
  const wrap = document.getElementById(`${id}-wrap`);
  if (wrap) wrap.classList.add('hidden');
}

// ============================================================
// GLOBAL EXPORT (for legacy window.VTUtils access)
// ============================================================
if (typeof window !== 'undefined') {
  window.VTUtils = {
    showToast, escapeHtml, formatBytes, formatDuration, debounce,
    isValidUrl, detectMediaFormat, inferFilename, parseContentDisposition,
    fetchWithTimeout, fetchWithRetry, sleep,
    CORS_PROXIES, fetchViaProxy,
    createObjectURL, revokeObjectURL, revokeAllObjectURLs, downloadBlob, downloadUrl,
    fetchBlobWithProgress, fetchBlobRange,
    parseM3U8, loadHlsJs, downloadHlsStream,
    parseMPD, downloadDashStream,
    smartDownload,
    waitForMediaReady, loadScriptOnce,
    createProgressBarHTML, updateProgressBar, hideProgressBar,
    createAbortRegistry,
  };
}
