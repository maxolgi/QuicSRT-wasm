// Unified viewer page. Thin wrapper around the framework-agnostic player SDK
// (mountPlayer) with an opt-in debug panel (mountDebug) lazy-loaded on demand.
// Ported from the QuicSRT-rust reference viewer: same controls, pacing
// persistence, debug toggle and debug-resizer behavior — here built on the
// vendored SDK (page/vendor/) driving the C++ wasm engine worker
// (page/bundle/worker.js, which runs the engine via js/srt_engine.js).

import { mountPlayer } from './vendor/player/index';
import type { PlayerState, PlayerStatsDetail } from './vendor/player/index';
import { createAbr } from './vendor/abr';

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

// ?worker=1: opt-in worker-decode mode exercising the embedded-host path
// (the same one SlopShady runs) — frames decode in the engine worker and
// render SDK-side onto the canvas below, with worker-decoded audio sunk
// through the standard <audio>/mute path.
const workerMode = new URLSearchParams(location.search).get('worker') === '1';

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
  // Worker mode: the localStorage seed above is inert (the worker cannot
  // read it), so ?decode= maps to the init-time hwMode option instead.
  ...(workerMode ? {
    decodeInWorker: true,
    workerAudio: true,
    hwMode:
      decodeParam === 'software' ? 'prefer-software' as const :
      decodeParam === 'hardware' ? 'prefer-hardware' as const : undefined,
  } : {}),
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

// --- Quality selector (manual + auto ABR rung switching) ---
// ?rungs= is the comma-separated rendition-suffix ladder the gateway
// transcoder publishes as ${base}_${suffix} (the source itself is ${base});
// default matches its 288p,216p. ?rungs=none (or empty) hides the control.
// setStream records the name for the next connect and reconnects immediately
// when active; a watchdog reverts to the last 'playing'-confirmed selection
// and disables a rung that never came up — 10 s, or 12 s when the target is
// the source rung (its ~8.3 s GOP legitimately delays the first frame).
// The default 'auto' option drives the same switch machinery from the
// vendored ABR engine: one rung per decision, fed ~1 Hz from 'stats'.
const rungsParam = new URLSearchParams(location.search).get('rungs') ?? '288p,216p';
const baseStream = new URLSearchParams(location.search).get('stream') ?? 'default';
const qualitySel = document.getElementById('quality') as HTMLSelectElement;
// Ladder top-down = option order after 'auto': the source ('') then the
// rendition suffixes; stepRung walks it by index.
const ladder = [''].concat(rungsParam.split(',').map(s => s.trim()).filter(Boolean));

if (rungsParam === 'none' || rungsParam === '') {
  qualitySel.closest('label')?.remove();
} else {
  for (const suffix of ladder.slice(1)) {
    const opt = document.createElement('option');
    opt.value = suffix;
    opt.textContent = suffix;
    qualitySel.appendChild(opt);
  }
}

// '' (source) maps to the base stream itself.
function streamFor(value: string) {
  return value === '' ? baseStream : `${baseStream}_${value}`;
}

let prevValue = '';
let prevTarget = baseStream;
let watchdog = 0;
// Auto mode: 'auto' is the default selection; any user-picked rung parks
// the engine until 'auto' is re-selected. `rung` tracks the live rung even
// while the select shows 'auto'; `autoSwitch` marks an engine-initiated
// switch awaiting its 'playing' confirmation.
const engine = createAbr();
let autoMode = true;
let rung = '';
let autoSwitch = false;

function armWatchdog() {
  clearTimeout(watchdog);
  watchdog = window.setTimeout(() => {
    watchdog = 0;
    // 'playing' fires once per connection, so a fire with nothing newer
    // confirmed is steady playback — only an unconfirmed switch reverts.
    // While the select shows 'auto', the live rung is `rung`.
    if ((qualitySel.value === 'auto' ? rung : qualitySel.value) === prevValue) return;
    const failed = qualitySel.selectedOptions[0];
    failed.disabled = true;
    qualitySel.value = prevValue;
    rung = prevValue;
    handle.setStream(prevTarget);
    // In auto mode the revert is engine bookkeeping, not a mode change:
    // the reverted-to stream is what was playing, so just show 'auto'
    // again — no switch follows.
    if (autoMode) qualitySel.value = 'auto';
  }, qualitySel.value === '' ? 12000 : 10000);
}

qualitySel.addEventListener('change', (e) => {
  // User picks rule the mode: 'auto' engages the engine, any rung parks
  // it. Engine switches dispatch untrusted 'change' events and the
  // watchdog revert writes .value directly (no event) — neither flips it.
  if (e.isTrusted) {
    autoMode = qualitySel.value === 'auto';
    if (autoMode) engine.reset();
  }
  if (qualitySel.value === 'auto') {
    // Engaging auto keeps the current stream and rung; nothing is in
    // flight, so disarm instead of watching a no-switch.
    clearTimeout(watchdog);
    watchdog = 0;
    return;
  }
  rung = qualitySel.value;
  handle.setStream(streamFor(rung));
  // Idle: nothing reconnects — the name just rides the next connect.
  if (handle.state !== 'idle') armWatchdog();
});

handle.addEventListener('playing', () => {
  // Stream confirmed (initial connect or switch): roll the watchdog window
  // and commit the current selection as the new fallback. While the select
  // shows 'auto', the confirmed rung is `rung`.
  prevValue = qualitySel.value === 'auto' ? rung : qualitySel.value;
  prevTarget = streamFor(prevValue);
  if (autoSwitch) {
    // Engine-initiated switch confirmed: restart its decision window.
    engine.reset();
    autoSwitch = false;
  }
  armWatchdog();
});

// One rung along the ladder (option order: source → 288p → 216p), clamped
// at both ends. Rides the exact manual-switch path: set the select and
// dispatch 'change' (untrusted → the mode holds); the watchdog reverts a
// target that never comes up.
function stepRung(delta: number) {
  const next = ladder.indexOf(rung) + delta;
  if (next < 0 || next >= ladder.length) return;
  autoSwitch = true;
  qualitySel.value = ladder[next];
  qualitySel.dispatchEvent(new Event('change'));
  // The switch rode the change handler (which armed the watchdog while the
  // value still named the target rung); re-show 'auto' so the UI keeps
  // saying the engine owns the ladder. Mode never flipped — untrusted event.
  qualitySel.value = 'auto';
}

// Feed the engine the ~1 Hz cumulative counters; a decision moves one rung.
handle.addEventListener('stats', (ev) => {
  if (!autoMode) return;
  const { rxData, rxLoss, rxDropped } =
    (ev as CustomEvent<PlayerStatsDetail>).detail.stats;
  const decision = engine.tick({ rxData, rxLoss, rxDropped }, performance.now());
  if (decision === 'down') stepRung(1);
  else if (decision === 'up') stepRung(-1);
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
