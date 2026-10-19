// Unified viewer page. Thin wrapper around the framework-agnostic player SDK
// (mountPlayer) with an opt-in debug panel (mountDebug) lazy-loaded on demand.
// Ported from the QuicSRT-rust reference viewer: same controls, pacing
// persistence, debug toggle and debug-resizer behavior — here built on the
// vendored SDK (page/vendor/) driving the C++ wasm engine worker
// (page/bundle/worker.js, which runs the engine via js/srt_engine.js).

import { mountPlayer } from './vendor/player/index';
import type { PlayerState } from './vendor/player/index';

const canvas = document.getElementById('video-canvas') as HTMLCanvasElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const latencyNum = document.getElementById('latency-num') as HTMLInputElement;
const muteBtn = document.getElementById('mute') as HTMLButtonElement;
const fullscreenBtn = document.getElementById('fullscreen') as HTMLButtonElement;
const debugToggle = document.getElementById('debug-toggle') as HTMLButtonElement;
const debugRoot = document.getElementById('debug-root') as HTMLDivElement;

// Hw/sw decode preference. The vendored VideoPipeline reads localStorage
// 'quicsrt-hw-mode' when it is built (main thread, at mount) and defaults to
// prefer-hardware, which throws OperationError on software-only machines.
// ?decode=software|hardware seeds the preference before mount; the debug
// panel's Tools tab switches hw mode live via VideoPipeline.setHwMode.
const decodeParam = new URLSearchParams(location.search).get('decode');
if (decodeParam === 'software' || decodeParam === 'hardware') {
  localStorage.setItem('quicsrt-hw-mode', decodeParam === 'software' ? 'prefer-software' : 'prefer-hardware');
}

// --- Pacing persistence (render ON / decode OFF by default, as in advanced.tsx) ---
const savedRenderPacing = localStorage.getItem('quicsrt-pacing-render') !== '0';
const savedDecodePacing = localStorage.getItem('quicsrt-pacing-decode') === '1';

// --- Latency persistence ---
const savedLatency = localStorage.getItem('latency');
if (savedLatency) latencyNum.value = savedLatency;

const handle = mountPlayer(canvas, {
  latencyMs: +latencyNum.value || 120,
  renderPacing: savedRenderPacing,
  decodePacing: savedDecodePacing,
  workerUrl: '/bundle/worker.js',
});

// --- Controls ---
connectBtn.addEventListener('click', () => {
  if (handle.state === 'idle' || handle.state === 'error') {
    handle.connect().catch(() => {});
  } else {
    handle.disconnect();
  }
});

latencyNum.addEventListener('change', () => {
  const v = Math.max(20, Math.min(8000, +latencyNum.value || 120));
  latencyNum.value = String(v);
  localStorage.setItem('latency', String(v));
  // setLatencyMs reconnects when active and the value changed (viewer-internal).
  handle.setLatencyMs(v);
});

muteBtn.addEventListener('click', () => {
  handle.setMuted(!handle.muted);
  muteBtn.classList.toggle('muted', handle.muted);
});

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else canvas.requestFullscreen();
});

document.addEventListener('visibilitychange', () => {
  handle.getWorker()?.postMessage({ cmd: 'visibility', visible: !document.hidden });
});

// --- Player events → UI ---
const buttonLabel: Record<PlayerState, string> = {
  idle: 'connect',
  connecting: 'connecting…',
  connected: 'stop',
  reconnecting: 'connecting…',
  error: 'connect',
};

handle.addEventListener('statechange', (ev) => {
  const s = (ev as CustomEvent<PlayerState>).detail;
  connectBtn.textContent = buttonLabel[s];
  if (s === 'idle') {
    muteBtn.disabled = true;
    muteBtn.classList.add('muted');
  }
});

handle.addEventListener('open', () => {
  muteBtn.disabled = false;
  muteBtn.classList.toggle('muted', handle.muted);
});

handle.addEventListener('playing', () => {
  muteBtn.disabled = false;
  muteBtn.classList.toggle('muted', handle.muted);
});

// --- Debug panel resize handle (sits on the panel's left edge) ---
const PANEL_MIN_W = 320;
const PANEL_MAX_W_RATIO = 0.85;
const resizer = document.createElement('div');
resizer.className = 'debug-resizer';
document.body.appendChild(resizer);

function syncResizerPosition() {
  const w = debugRoot.offsetWidth;
  resizer.style.right = `${w}px`;
  document.body.style.paddingRight = `${w + 16}px`;
}

{
  const savedW = localStorage.getItem('quicsrt-debug-width');
  if (savedW) debugRoot.style.width = `${savedW}px`;

  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const maxW = window.innerWidth * PANEL_MAX_W_RATIO;
    const w = Math.min(maxW, Math.max(PANEL_MIN_W, window.innerWidth - e.clientX));
    debugRoot.style.width = `${w}px`;
    resizer.style.right = `${w}px`;
    document.body.style.paddingRight = `${w + 16}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('quicsrt-debug-width', String(debugRoot.offsetWidth));
  });
}

// --- Debug panel toggle (lazy-loaded; off by default, restored from storage) ---
let debugHandle: { destroy(): void } | null = null;
let debugMounting = false;

async function setPanelVisible(visible: boolean): Promise<void> {
  if (visible) {
    debugRoot.classList.add('visible');
    document.body.classList.add('debug-open');
    resizer.classList.add('visible');
    localStorage.setItem('quicsrt-debug-open', '1');
    syncResizerPosition();
    if (debugHandle || debugMounting) return;
    debugMounting = true;
    try {
      const { mountDebug } = await import('./vendor/debug');
      // Panel may have been closed while the chunk was loading.
      if (debugRoot.classList.contains('visible')) debugHandle = mountDebug(handle, debugRoot);
    } finally {
      debugMounting = false;
    }
    return;
  }
  debugRoot.classList.remove('visible');
  document.body.classList.remove('debug-open');
  resizer.classList.remove('visible');
  document.body.style.paddingRight = '';
  localStorage.removeItem('quicsrt-debug-open');
  debugHandle?.destroy();
  debugHandle = null;
}

debugToggle.addEventListener('click', () => {
  void setPanelVisible(!debugRoot.classList.contains('visible'));
});

if (localStorage.getItem('quicsrt-debug-open') === '1') {
  void setPanelVisible(true);
}

// --- Auto-connect once the gateway has published a cert hash ---
if ((window as any).CERT_HASH !== undefined) {
  handle.connect().catch(() => {});
}
