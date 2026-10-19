// Publisher page: full port of the QuicSRT-rust web/src/stream.tsx UI —
// screen/webcam capture with a camera picker, codec auto-detect, tab/mic
// audio, the stream-back player and the Preact debug panel — driving the
// wasm publisher worker (page/bundle/publish_worker.js, built from
// page/vendor/stream-worker.ts: WebCodecs encode + the C++ TS mux + the
// C++ wasm engine behind js/srt_engine.js as the SRT layer) through its
// postMessage protocol. wasm deltas vs stream.tsx: both workers are
// pre-bundled /bundle/ URLs (no Vite new URL()), the publish endpoint
// comes from the url field (wt://host:port shorthand for
// https://host:port/wt) instead of ?host=/?port=/window.WT_PORT
// resolution, and ?source=canvas keeps the hardware-free animated-canvas
// test-source mode (audio selector disabled at (none), no mic acquired).
// cert-hash.js is served same-origin by the gateway; window.CERT_HASH
// pins the WT session (null hash = PKI mode, no pinning).
import { render } from 'preact';
import { DebugStore } from './vendor/debug/store';
import { DebugPanel } from './vendor/debug/components/Panel';
import { attachConsoleErrorCapture } from './vendor/debug/sampler';
import { mountPlayer } from './vendor/player';
import type { PlayerHandle, PlayerState, PlayerErrorDetail, PlayerResizeDetail } from './vendor/player';
import type { PublishCmd, PublishMsg, EncodeStats } from './vendor/stream-worker';
import type { StatsMsg } from './vendor/worker';
import {
  CODEC_CANDIDATES,
  detectCodec,
  AudioGraphManager,
  FramePump,
  attachDebugResizer,
  formatPubStats,
  hexToBytes,
} from './vendor/shared/publish';

// ─── DOM refs ─────────────────────────────────────────────────────

const previewEl = document.getElementById('preview') as HTMLVideoElement;
const sourceSelect = document.getElementById('source-select') as HTMLSelectElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
const publishBtn = document.getElementById('publish-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const streamNameInput = document.getElementById('stream-name') as HTMLInputElement;
const latencyNum = document.getElementById('latency-num') as HTMLInputElement;
const codecSelect = document.getElementById('codec-select') as HTMLSelectElement;
const bitrateNum = document.getElementById('bitrate-num') as HTMLInputElement;
const framerateSelect = document.getElementById('framerate-select') as HTMLSelectElement;
const pubStatsText = document.getElementById('pub-stats-text') as HTMLDivElement;
const viewerLink = document.getElementById('viewer-link') as HTMLAnchorElement;
const audioSourceSelect = document.getElementById('audio-source') as HTMLSelectElement;
const playbackCanvas = document.getElementById('playback-canvas') as HTMLCanvasElement;
const playbackMuteBtn = document.getElementById('playback-mute') as HTMLButtonElement;
const playbackToggleBtn = document.getElementById('playback-toggle') as HTMLButtonElement;
const playbackLatencyNum = document.getElementById('playback-latency') as HTMLInputElement;
const pubUrlInput = document.getElementById('pub-url') as HTMLInputElement;

const debugRoot = document.getElementById('debug-root') as HTMLDivElement;

// ─── Debug panel (reused from viewer) ─────────────────────────────

const debugResizer = attachDebugResizer({ debugRoot });

const store = new DebugStore();
let panelMounted = false;
let consoleCleanup: (() => void) | null = null;

function log(msg: string, cls = '') { store.pushLog(msg, cls); }
function setStatus(s: string) { store.status.value = s; }

// ─── Stream-back viewer (round-trip from gateway) ─────────────────

let pbHandle: PlayerHandle | null = null;
let pbStream = '';

function mountPlayback(stream: string): void {
  pbHandle?.destroy();
  const h = mountPlayer(playbackCanvas, {
    stream,
    latencyMs: +playbackLatencyNum.value || 120,
    muted: true,
    workerUrl: '/bundle/worker.js',
  });
  pbHandle = h;
  pbStream = stream;
  h.addEventListener('statechange', (ev) => {
    const s = (ev as CustomEvent<PlayerState>).detail;
    playbackToggleBtn.textContent = (s === 'idle' || s === 'error') ? 'play' : 'stop';
    if (s === 'connected') playbackMuteBtn.disabled = false;
    else { playbackMuteBtn.disabled = true; playbackMuteBtn.classList.add('muted'); }
  });
  h.addEventListener('resize', (ev) => {
    const { width, height } = (ev as CustomEvent<PlayerResizeDetail>).detail;
    store.pushLog(`[playback] first frame ${width}x${height}`, 'ok');
  });
  h.addEventListener('playing', () => store.pushLog('[playback] playing', 'info'));
  h.addEventListener('error', (ev) => {
    const { message } = (ev as CustomEvent<PlayerErrorDetail>).detail;
    store.pushLog(`[playback] ${message}`, 'err');
  });
}

function playbackActive(): boolean {
  return pbHandle !== null && pbHandle.state !== 'idle' && pbHandle.state !== 'error';
}

playbackLatencyNum.addEventListener('change', () => {
  pbHandle?.setLatencyMs(+playbackLatencyNum.value);
});

playbackMuteBtn.addEventListener('click', () => {
  if (!pbHandle) return;
  pbHandle.setMuted(!pbHandle.muted);
  playbackMuteBtn.classList.toggle('muted', pbHandle.muted);
});

function setPanelVisible(visible: boolean) {
  store.panelVisible.value = visible;
  debugRoot.classList.toggle('visible', visible);
  document.body.classList.toggle('debug-open', visible);
  if (visible) {
    debugResizer.sync();
    localStorage.setItem('quicsrt-debug-open', '1');
    if (!panelMounted) {
      render(<DebugPanel store={store} />, debugRoot);
      panelMounted = true;
      consoleCleanup = attachConsoleErrorCapture(store);
    }
  } else {
    document.body.style.paddingRight = '';
    localStorage.removeItem('quicsrt-debug-open');
  }
}

// ─── State ────────────────────────────────────────────────────────

let worker: Worker | null = null;
let captureStream: MediaStream | null = null;
let publishing = false;
let capturing = false;
let detectedCodec: string | null = null;
let detectedCodecLabel = '';

const audio = new AudioGraphManager((msg) => log(msg, 'err'));

const framePump = new FramePump({
  getPreviewEl: () => previewEl,
  isPublishing: () => publishing && worker !== null,
  postFrame: (frame) => {
    const cmd: PublishCmd = { cmd: 'frame', frame };
    worker!.postMessage(cmd, [frame]);
  },
  getFps: () => +framerateSelect.value,
});

// ─── Codec auto-detection ─────────────────────────────────────────

function populateCodecSelect() {
  codecSelect.innerHTML = '';
  const autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = 'auto';
  codecSelect.appendChild(autoOpt);
  for (const c of CODEC_CANDIDATES) {
    const opt = document.createElement('option');
    opt.value = c.codec;
    opt.textContent = c.label;
    codecSelect.appendChild(opt);
  }
  codecSelect.value = 'auto';
}

// ─── Audio source population ──────────────────────────────────────

function populateAudioSources() {
  const current = audioSourceSelect.value;
  audioSourceSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(none)';
  audioSourceSelect.appendChild(none);
  if (captureStream && captureStream.getAudioTracks().length > 0) {
    const opt = document.createElement('option');
    opt.value = '__tab__';
    opt.textContent = 'Tab / System Audio';
    audioSourceSelect.appendChild(opt);
  }
  for (const opt of micOptions) {
    audioSourceSelect.appendChild(opt.cloneNode(true) as HTMLOptionElement);
  }
  audioSourceSelect.value = current || '';
}

let micOptions: HTMLOptionElement[] = [];
let cameraOptions: HTMLOptionElement[] = [];

async function enumerateMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    micOptions = mics.map((m) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || `Device ${m.deviceId.slice(0, 8)}`;
      return opt;
    });
    populateAudioSources();
  } catch { /* ignore */ }
}

async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === 'videoinput');
    cameraOptions = cameras.map((c) => {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${c.deviceId.slice(0, 8)}`;
      return opt;
    });
    populateCameraSelect();
  } catch { /* ignore */ }
}

function populateCameraSelect() {
  const current = cameraSelect.value;
  cameraSelect.innerHTML = '';
  for (const opt of cameraOptions) {
    cameraSelect.appendChild(opt.cloneNode(true) as HTMLOptionElement);
  }
  cameraSelect.value = current || cameraOptions[0]?.value || '';
}

// ─── ?source=canvas: hardware-free test source ────────────────────

// ?source=canvas: hardware-free mode for the automated live gate - an
// animated canvas replaces getUserMedia/getDisplayMedia as the
// MediaStream source; the downstream path (preview element,
// FramePump/rVFC, codec detection, worker protocol) is identical. No
// audio in this mode: the selector stays disabled at (none) - no mic
// is acquired either. Without the param, behavior matches stream.tsx
// (screen/webcam sources, camera picker).
const canvasMode = new URLSearchParams(location.search).get('source') === 'canvas';
const CANVAS_W = 1280;
const CANVAS_H = 720;

let canvasEl: HTMLCanvasElement | null = null;
let canvasRafId = 0;
let canvasFrame = 0;

// Animated test pattern: crawling color bars over a per-frame counter +
// wall-clock timestamp and a per-run random id - visibly unique per run,
// so playback/ffprobe can eyeball motion. Painted via rAF, sampled by
// captureStream(30).
function startCanvasSource(): MediaStream {
  const runId = Math.random().toString(16).slice(2, 8);
  const cv = document.createElement('canvas');
  cv.width = CANVAS_W;
  cv.height = CANVAS_H;
  // Laid out offscreen rather than display:none so paints stay live; the
  // preview video element shows the content, the status line marks the mode.
  cv.style.cssText = 'position:fixed;left:-9999px;bottom:0';
  document.body.appendChild(cv);
  canvasEl = cv;
  const ctx = cv.getContext('2d')!;
  const bars = ['#c33', '#3c3', '#33c', '#cc3', '#c3c', '#3cc'];
  const t0 = performance.now();
  const paint = (): void => {
    const t = (performance.now() - t0) / 1000;
    const bw = CANVAS_W / bars.length;
    const slide = Math.round((t * 90) % bw); // crawl left at 90 px/s
    for (let i = 0; i <= bars.length; i++) {
      ctx.fillStyle = bars[i % bars.length];
      ctx.fillRect(Math.round(i * bw) - slide, 0, Math.ceil(bw) + 1, CANVAS_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillRect(0, CANVAS_H / 2 - 96, CANVAS_W, 192);
    ctx.textAlign = 'center';
    ctx.font = 'bold 64px monospace';
    ctx.fillStyle = '#fff';
    const d = new Date();
    ctx.fillText(
      `#${canvasFrame} ${d.toLocaleTimeString('en-GB')}.${String(d.getMilliseconds()).padStart(3, '0')}`,
      CANVAS_W / 2,
      CANVAS_H / 2 - 12,
    );
    ctx.font = 'bold 36px monospace';
    ctx.fillStyle = '#6cf';
    ctx.fillText(`quicsrt canvas run ${runId}`, CANVAS_W / 2, CANVAS_H / 2 + 56);
    canvasFrame++;
    canvasRafId = requestAnimationFrame(paint);
  };
  paint();
  return cv.captureStream(30);
}

// ─── Source capture (screen / webcam / canvas) ─────────────────────

sourceSelect.addEventListener('change', () => {
  const isWebcam = sourceSelect.value === 'webcam';
  cameraSelect.style.display = isWebcam ? '' : 'none';
  cameraSelect.disabled = !isWebcam;
  if (isWebcam && cameraOptions.length === 0) {
    enumerateCameras();
  }
});

async function startCapture(): Promise<void> {
  const source = sourceSelect.value;
  let stream: MediaStream;

  if (canvasMode) {
    stream = startCanvasSource();
  } else if (source === 'screen') {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: +framerateSelect.value } },
      audio: true,
    });
    await enumerateMics();
  } else {
    const deviceId = cameraSelect.value || undefined;
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: +framerateSelect.value },
      },
      audio: true,
    });
    // Re-enumerate cameras now that permission is granted (labels populate)
    await enumerateCameras();
    // Auto-pair the webcam's mic in the audio dropdown. The audio track
    // from this getUserMedia is stopped — connectAudioSource() will
    // re-acquire the mic at publish time via the existing deviceId path.
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      const micDeviceId = audioTrack.getSettings().deviceId;
      audioTrack.stop();
      stream.removeTrack(audioTrack);
      if (micDeviceId) {
        await enumerateMics();
        audioSourceSelect.value = micDeviceId;
      }
    }
  }

  // Stop any previous capture before wiring the new one.
  if (captureStream) {
    captureStream.getTracks().forEach((t) => t.stop());
  }

  captureStream = stream;
  previewEl.srcObject = stream;
  await previewEl.play();

  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    stopCapture();
  });

  capturing = true;
  captureBtn.textContent = 'Stop Capture';
  publishBtn.disabled = false;

  const vTrack = stream.getVideoTracks()[0];
  const settings = vTrack?.getSettings();
  const w = canvasMode ? CANVAS_W : (settings?.width ?? 1280);
  const h = canvasMode ? CANVAS_H : (settings?.height ?? 720);
  log(`Captured ${w}x${h} (${canvasMode ? 'canvas test source' : source})`, 'info');
  setStatus(canvasMode
    ? 'canvas test source — ready to publish'
    : `${source === 'screen' ? 'screen' : 'webcam'} captured — ready to publish`);

  const fps = +framerateSelect.value;
  const br = +bitrateNum.value;
  const detected = await detectCodec(w, h, fps, br);
  if (detected) {
    detectedCodec = detected.codec;
    detectedCodecLabel = detected.label;
    log(`Codec auto-detected: ${detected.label} (${detected.codec})`, 'info');
  } else {
    log('No supported codec found!', 'err');
  }
}

function stopCapture(): void {
  if (publishing) stopAll();
  if (captureStream) {
    captureStream.getTracks().forEach((t) => t.stop());
  }
  if (canvasRafId) {
    cancelAnimationFrame(canvasRafId);
    canvasRafId = 0;
  }
  if (canvasEl) {
    canvasEl.remove();
    canvasEl = null;
  }
  captureStream = null;
  previewEl.srcObject = null;
  capturing = false;
  captureBtn.textContent = 'Capture';
  publishBtn.disabled = true;
  populateAudioSources();
  setStatus('capture stopped');
}

captureBtn.addEventListener('click', async () => {
  if (capturing) {
    stopCapture();
    return;
  }
  try {
    await startCapture();
  } catch (e) {
    log(`Capture failed: ${e}`, 'err');
    setStatus('capture failed');
  }
});

// ─── Publish URL ──────────────────────────────────────────────────

// wt://host:port is shorthand for https://host:port/wt (the WebTransport
// URL the worker expects); the publish query param always comes from the
// stream-name field, ?token= on the page URL passes through (stream.tsx).
function buildWtUrl(): string {
  const raw = pubUrlInput.value.trim();
  let u: URL;
  if (raw.startsWith('wt://')) {
    u = new URL(`https://${raw.slice('wt://'.length)}`);
    if (u.pathname === '/') u.pathname = '/wt';
  } else {
    u = new URL(raw);
  }
  u.searchParams.set('publish', streamNameInput.value || 'default');
  const authToken = new URLSearchParams(location.search).get('token');
  if (authToken) u.searchParams.set('token', authToken);
  return u.toString();
}

// ─── Publishing ───────────────────────────────────────────────────

publishBtn.addEventListener('click', async () => {
  if (publishing) return;
  if (!captureStream) { log('Capture a screen first', 'err'); return; }

  publishing = true;
  publishBtn.disabled = true;
  stopBtn.disabled = false;
  viewerLink.style.display = '';
  const sn = streamNameInput.value || 'default';
  const viewerUrl = `${location.origin}/?stream=${encodeURIComponent(sn)}`;
  viewerLink.href = viewerUrl;
  viewerLink.textContent = viewerUrl;
  setStatus('starting\u2026');

  // Determine codec
  const vTrack = captureStream.getVideoTracks()[0];
  const settings = vTrack?.getSettings();
  const width = canvasMode ? CANVAS_W : (settings?.width ?? 1280);
  const height = canvasMode ? CANVAS_H : (settings?.height ?? 720);
  const framerate = +framerateSelect.value;
  const bitrate = +bitrateNum.value;
  const chosenCodec = codecSelect.value === 'auto' ? (detectedCodec ?? 'avc1.640028') : codecSelect.value;
  const isAv1 = chosenCodec.startsWith('av01');

  // Determine audio config
  const audioSource = audioSourceSelect.value;
  const audioCfg = audioSource ? { bitrate: 128000, channels: 2 } : null;

  // Setup audio graph if needed
  if (audioSource) {
    await audio.setup();
    await audio.connect(audioSourceSelect.value, {
      allowTabAudio: true,
      getTabAudioTracks: () => captureStream?.getAudioTracks() ?? [],
    });
    await audio.resumeIfSuspended();
  }

  // Cert hash (cert-hash.js from the gateway; null = PKI, no pinning)
  const hashHex = (window as any).CERT_HASH as string | null | undefined;
  let certHash: Uint8Array | null = null;
  if (hashHex) certHash = hexToBytes(hashHex);

  const wtUrl = buildWtUrl();
  const latencyMs = +latencyNum.value;

  // Create worker (the pre-bundled vendored stream-worker - the esbuild
  // equivalent of stream.tsx's vite new URL('./stream-worker.ts'))
  worker = new Worker('/bundle/publish_worker.js', { type: 'module' });
  worker.onmessage = (e: MessageEvent) => handleWorkerMsg(e.data as PublishMsg);
  worker.onerror = (e) => { log(`worker error: ${e.message}`, 'err'); };

  const cmd: PublishCmd = {
    cmd: 'init',
    url: wtUrl,
    certHash,
    latencyMs,
    video: { codec: chosenCodec, width, height, bitrate, framerate },
    audio: audioCfg,
  };
  const transfer: ArrayBuffer[] = [];
  if (certHash) transfer.push(certHash.buffer as ArrayBuffer);
  worker.postMessage(cmd, transfer);

  // Transfer audio port
  if (audioSource) {
    audio.transferPort(worker);
  }

  log(`Publishing to ${wtUrl} (${isAv1 ? 'AV1' : 'H.264'})`, 'info');
  log(`latency: ${latencyMs}ms, bitrate: ${bitrate}Mbps, fps: ${framerate}`, 'info');
});

stopBtn.addEventListener('click', () => stopAll());

function stopAll() {
  publishing = false;
  framePump.stop();
  pbHandle?.disconnect();
  viewerLink.style.display = 'none';
  if (worker) {
    worker.postMessage({ cmd: 'stop' } as PublishCmd);
    worker.terminate();
    worker = null;
  }
  audio.close();
  publishBtn.disabled = !captureStream;
  stopBtn.disabled = true;
  framePump.resetCredits();
  setStatus('stopped');
}

// ─── Worker message handler ───────────────────────────────────────

function handleWorkerMsg(msg: PublishMsg) {
  if (msg.type === 'batch') {
    for (const m of msg.msgs) handleWorkerMsg(m);
    return;
  }
  switch (msg.type) {
    case 'log':
      log(msg.msg, msg.cls);
      break;
    case 'credit':
      framePump.credit();
      break;
    case 'wtReady':
      log('WT connected', 'ok');
      setStatus('WT ready; awaiting SRT handshake');
      break;
    case 'handshakeComplete':
      log('SRT handshake complete', 'ok');
      setStatus('LIVE');
      framePump.start();
      if (!playbackActive()) {
        const sn = streamNameInput.value || 'default';
        if (!pbHandle || pbStream !== sn) mountPlayback(sn);
        store.pushLog('[playback] auto-connecting stream-back…', 'info');
        pbHandle?.connect().catch(() => {});
      }
      break;
    case 'close':
      log('SRT closed', 'err');
      setStatus('closed');
      framePump.stop();
      break;
    case 'wtClosed':
      if (msg.error) log(`WT closed: ${msg.error}`, 'err');
      else log('WT closed', 'info');
      setStatus('disconnected');
      framePump.stop();
      break;
    case 'stats':
      store.srtStats.value = msg.stats;
      if (msg.encode) updateEncodeStats(msg.stats, msg.encode);
      break;
  }
}

function updateEncodeStats(srt: StatsMsg, enc: EncodeStats) {
  pubStatsText.innerHTML = formatPubStats(srt, enc, framerateVal());
}

function framerateVal(): number { return +framerateSelect.value; }

// ─── Misc handlers ────────────────────────────────────────────────

document.getElementById('debug-toggle')?.addEventListener('click', () => {
  setPanelVisible(!store.panelVisible.value);
});

document.addEventListener('visibilitychange', () => {
  if (publishing) framePump.schedule();
});

playbackToggleBtn.addEventListener('click', () => {
  if (playbackActive()) {
    pbHandle?.disconnect();
  } else {
    const sn = streamNameInput.value || 'default';
    if (!pbHandle || pbStream !== sn) mountPlayback(sn);
    pbHandle?.connect().catch(() => {});
  }
});

// ─── Init ─────────────────────────────────────────────────────────

// Persistent stream key: load from localStorage or generate a random 8-char one.
const STREAM_KEY_KEY = 'quicsrt-stream-name';
const savedName = localStorage.getItem(STREAM_KEY_KEY);
streamNameInput.value = savedName ?? Array.from(
  { length: 8 },
  () => Math.floor(Math.random() * 36).toString(36),
).join('');
localStorage.setItem(STREAM_KEY_KEY, streamNameInput.value);
streamNameInput.addEventListener('change', () => {
  localStorage.setItem(STREAM_KEY_KEY, streamNameInput.value);
});

populateCodecSelect();
if (canvasMode) {
  // ?source=canvas: hardware-free mode - no device enumeration, the
  // audio selector stays disabled at (none) (no mic acquired).
  audioSourceSelect.disabled = true;
  setStatus('canvas test source mode - ready to Capture');
} else {
  enumerateMics();
  enumerateCameras();
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    enumerateMics();
    enumerateCameras();
  });
}

setPanelVisible(false);

if ((window as any).CERT_HASH !== undefined) {
  if ((window as any).CERT_HASH) {
    log('Cert hash loaded', 'info');
  } else {
    log('mkcert mode', 'info');
  }
} else {
  log('No cert-hash.js. Start the gateway first, then reload.', 'info');
}
