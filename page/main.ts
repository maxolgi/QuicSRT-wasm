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
const canvasB = document.getElementById('video-canvas-b') as HTMLCanvasElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const latencyNum = document.getElementById('latency-num') as HTMLInputElement;
const muteBtn = document.getElementById('mute') as HTMLButtonElement;
const fullscreenBtn = document.getElementById('fullscreen') as HTMLButtonElement;
const debugToggle = document.getElementById('debug-toggle') as HTMLButtonElement;
const debugRoot = document.getElementById('debug-root') as HTMLDivElement;

// Hw/sw decode preference. The vendored VideoPipeline reads localStorage
// 'quicsrt-hw-mode' when it is built (main thread, at mount) and defaults
// to 'no-preference' — the browser picks software where no hardware decoder
// exists. ?decode=software|hardware seeds an explicit preference before
// mount; the debug panel's Tools tab switches hw mode live via VideoPipeline.setHwMode.
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

// Two players, one config: A owns the visible stage, B is the hidden
// overlap target — mounted idle it costs nothing (the viewer creates its
// worker only on connect), so a rendition switch can pre-join B while A
// keeps playing and swap the canvases in on B's first rendered frame.
const mountOpts = {
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
};
const players = [mountPlayer(canvas, mountOpts), mountPlayer(canvasB, mountOpts)];
const canvases = [canvas, canvasB];
// The active player owns the visible canvas; an overlap swap flips this.
let activeIdx = 0;

// --- Controls ---
connectBtn.addEventListener('click', () => {
  const p = players[activeIdx];
  if (p.state === 'idle' || p.state === 'error') {
    p.connect().catch(() => {});
  } else {
    // Manual stop drops any pre-joined overlap target with it.
    cancelOverlap();
    p.disconnect();
  }
});

latencyNum.addEventListener('change', () => {
  const v = Math.max(20, Math.min(8000, +latencyNum.value || 120));
  latencyNum.value = String(v);
  localStorage.setItem('latency', String(v));
  // setLatencyMs reconnects when active and the value changed (viewer-internal).
  // Both handles, so a pre-joined B never carries a stale latency into a swap.
  for (const p of players) p.setLatencyMs(v);
  // That reconnect restarted the joiner on the OLD abort clock — redo the
  // pending overlap so it rejoins at the new latency, window fresh.
  if (pending) {
    const t = pending.target;
    cancelOverlap();
    switchTo(t);
  }
});

muteBtn.addEventListener('click', () => {
  const p = players[activeIdx];
  p.setMuted(!p.muted);
  muteBtn.classList.toggle('muted', p.muted);
});

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  // Fullscreen the stage, not the canvas: a swap display:nones the
  // fullscreened canvas, which drops out of fullscreen.
  else document.getElementById('video-stage')!.requestFullscreen();
});

document.addEventListener('visibilitychange', () => {
  // Both handles — a pre-join's worker would otherwise miss the hint.
  for (const p of players) p.getWorker()?.postMessage({ cmd: 'visibility', visible: !document.hidden });
});

// --- Quality selector (manual + auto ABR rung switching) ---
// ?rungs= is the comma-separated rendition-suffix ladder the test
// publisher simulcasts as ${base}_${suffix} (the source itself is
// ${base}); default matches its 540p rung. ?rungs=none (or empty)
// hides the control.
// setStream records the name for the next connect and reconnects immediately
// when active; a watchdog reverts to the last 'playing'-confirmed selection
// and disables a rung that never came up — 12 s for the source rung, 10 s
// for rendition rungs (conservative revert windows; every rung's GOP is 2 s).
// Rendition targets on an active player instead switch by overlap: a hidden
// second player pre-joins and swaps in on its first rendered frame (no
// freeze); see switchTo below.
// The default 'auto' option drives the same switch machinery from the
// vendored ABR engine: one rung per decision, fed ~1 Hz from 'stats'.
const rungsParam = new URLSearchParams(location.search).get('rungs') ?? '540p';
const baseStream = new URLSearchParams(location.search).get('stream') ?? 'default';
const qualitySel = document.getElementById('quality') as HTMLSelectElement;
// Ladder top-down = option order after 'auto': the source ('') then the
// rendition suffixes; stepRung walks it by index.
const ladder = [''].concat(rungsParam.split(',').map(s => s.trim()).filter(Boolean));

if (rungsParam === 'none' || rungsParam === '') {
  document.getElementById('quality-ctl')?.remove();
} else {
  for (const suffix of ladder.slice(1)) {
    const opt = document.createElement('option');
    opt.value = suffix;
    opt.textContent = suffix;
    qualitySel.appendChild(opt);
  }
}

// Custom dropdown UI (see index.html): the native select popup would
// freeze the rAF-driven stage while open, so a plain button + popup
// render it. The hidden <select> stays the state holder — value,
// options and disable logic below are unchanged. User picks dispatch
// the same 'change' event with `userPick` set (the custom-control
// replacement for a trusted native event); programmatic switches
// (stepRung, reverts) leave it unset, exactly as untrusted events did.
const qualityBtn = document.getElementById('quality-btn') as HTMLButtonElement;
const qualityPop = document.getElementById('quality-pop') as HTMLDivElement;

let userPick = false;

function syncQualityBtn(): void {
  qualityBtn.textContent = qualitySel.value === '' ? 'source' : qualitySel.value;
}

function setQualitySel(v: string): void {
  qualitySel.value = v;
  syncQualityBtn();
}

function closeQualityPop(): void {
  qualityPop.hidden = true;
  // Drop stale option buttons: a later toggle-close early-returns before
  // rebuilding, and hidden-but-stale buttons are scriptable.
  qualityPop.textContent = '';
}

qualityBtn.addEventListener('click', () => {
  qualityPop.hidden = !qualityPop.hidden;
  if (qualityPop.hidden) return;
  // Rebuilt on every open: option set and disabled flags may have
  // changed (rungs disabled by the watchdog / overlap abort).
  qualityPop.textContent = '';
  for (const opt of qualitySel.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.textContent;
    b.disabled = opt.disabled;
    b.addEventListener('click', () => {
      closeQualityPop();
      if (opt.value === qualitySel.value) return;
      userPick = true;
      qualitySel.value = opt.value;
      qualitySel.dispatchEvent(new Event('change'));
      userPick = false;
      syncQualityBtn();
    });
    qualityPop.appendChild(b);
  }
});

document.addEventListener('click', (e) => {
  if (!qualityPop.hidden && e.target !== qualityBtn && !qualityPop.contains(e.target as Node)) {
    closeQualityPop();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeQualityPop();
});
syncQualityBtn();

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
// Pending overlap switch: the hidden player is pre-joining `target`; its
// 'playing' completes the swap, the 12 s timer aborts a join that never
// rendered (a source-GOP-length join still fits the window).
let pending: { target: string; t0: number; timer: number } | null = null;

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
    setQualitySel(prevValue);
    rung = prevValue;
    players[activeIdx].setStream(prevTarget);
    // In auto mode the revert is engine bookkeeping, not a mode change:
    // the reverted-to stream is what was playing, so just show 'auto'
    // again — no switch follows.
    if (autoMode) setQualitySel('auto');
  }, qualitySel.value === '' ? 12000 : 10000);
}

// The switch funnel shared by manual picks and stepRung. An idle active
// player: serial — setStream records the name for the next connect (no
// overlap needed, nothing is playing). Any target on an ACTIVE player:
// overlap — the hidden player pre-joins while the active one keeps
// playing, so the visible stage never freezes. (The source rung used to
// switch serially for the transcoder's chain offset; with publisher
// simulcast all rungs share one timeline, so it overlaps like the rest.)
function switchTo(value: string) {
  const p = players[activeIdx];
  if (p.state === 'idle') {
    // Nothing is playing: record the name; the next connect() uses it.
    cancelOverlap();
    p.setStream(streamFor(value));
    return;
  }
  if (pending) {
    // A re-pick of the in-flight target is a no-op; any other pick
    // supersedes the pre-join — drop it and start a fresh overlap (the
    // 12 s abort bounds the thrash).
    if (pending.target === value) return;
    cancelOverlap();
  }
  // The overlap owns switch confirmation from here; the serial watchdog
  // would revert the select mid-join, so disarm it for the window.
  clearTimeout(watchdog);
  watchdog = 0;
  const joiner = players[1 - activeIdx];
  pending = { target: value, t0: performance.now(), timer: window.setTimeout(abortOverlap, 12000) };
  // The joiner should be idle between overlaps, but don't race it if it
  // isn't: setStream on an active viewer schedules its OWN reconnect, and
  // the explicit connect() below would double-connect it (two sessions on
  // one rung). Force idle first, then record + connect, exactly once.
  joiner.disconnect();
  joiner.setStream(streamFor(value));
  joiner.connect().catch(() => {});
}

// Drop a pending pre-join without touching the select (a superseding
// serial switch or a manual stop): frees the hidden player's worker.
function cancelOverlap() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
  players[1 - activeIdx].disconnect();
}

// 12 s with no rendered frame from the pre-join: keep the old player
// (it never stopped playing) and mirror the watchdog revert — disable
// the rung that never came up, restore the last confirmed selection.
// No setStream: the old player is already on prevTarget.
function abortOverlap() {
  if (!pending) return;
  const failedRung = pending.target;
  pending = null;
  players[1 - activeIdx].disconnect();
  for (const opt of qualitySel.options) {
    if (opt.value === failedRung) opt.disabled = true;
  }
  setQualitySel(prevValue);
  rung = prevValue;
  if (autoMode) setQualitySel('auto');
}

qualitySel.addEventListener('change', () => {
  // User picks rule the mode: 'auto' engages the engine, any rung parks
  // it. Engine switches and the reverts below dispatch/ride plain
  // writes with userPick unset — neither flips it.
  if (userPick) {
    autoMode = qualitySel.value === 'auto';
    if (autoMode) {
      engine.reset();
      // Engaging auto is an explicit retry — re-enable benched rungs.
      for (const o of qualitySel.options) o.disabled = false;
    }
  }
  if (qualitySel.value === 'auto') {
    // Engaging auto keeps the current stream and rung; nothing is in
    // flight, so disarm instead of watching a no-switch.
    clearTimeout(watchdog);
    watchdog = 0;
    return;
  }
  rung = qualitySel.value;
  switchTo(rung);
});

// 'playing' confirmation shared by every path — initial connect, serial
// switch, overlap swap (the hook below calls it after the canvas swap):
// roll the watchdog window and commit the current selection as the new
// fallback. While the select shows 'auto', the confirmed rung is `rung`.
function commitPlaying() {
  prevValue = qualitySel.value === 'auto' ? rung : qualitySel.value;
  prevTarget = streamFor(prevValue);
  if (autoSwitch) {
    // Engine-initiated switch confirmed: restart its decision window.
    engine.reset();
    autoSwitch = false;
  }
  armWatchdog();
}

// Attached to BOTH players, gated to the active one: while an overlap is
// pending the pre-join owns confirmation, so even the active player's own
// reconnect-'playing' must not commit the unconfirmed selection.
for (const p of players) {
  p.addEventListener('playing', () => {
    if (p !== players[activeIdx] || pending) return;
    commitPlaying();
  });
}

// Overlap hook: a 'playing' from the NON-active player completes the
// pre-join — swap the canvases (no freeze: the joiner is already
// rendering), disconnect the old player to free its worker, carry the
// mute state across, then confirm through the same commit path as a
// serial switch. A stray non-active 'playing' with nothing pending is
// ignored.
for (const p of players) {
  p.addEventListener('playing', () => {
    if (p === players[activeIdx] || !pending) return;
    const from = prevValue;
    const to = pending.target;
    const ms = Math.round(performance.now() - pending.t0);
    clearTimeout(pending.timer);
    pending = null;
    // Flip the stage and the index BEFORE the old player's disconnect —
    // its synchronous 'statechange'→'idle' must land as a non-active
    // event, or it would reset the connect button mid-swap.
    const old = players[activeIdx];
    canvases[activeIdx].style.display = 'none';
    activeIdx = 1 - activeIdx;
    canvases[activeIdx].style.display = 'block';
    old.disconnect();
    p.setMuted(old.muted);
    console.info('abr: overlap swap %s -> %s (join %dms)', from, to, ms);
    commitPlaying();
    // The debug panel re-mounts per active player (chart history resets
    // on a rung swap — new session, new stats).
    if (debugRoot.classList.contains('visible')) {
      debugHandle?.destroy();
      debugHandle = null;
      void mountDebugPanel();
    }
  });
}

// One rung along the ladder (option order: source → 288p → 216p), clamped
// at both ends. Rides the exact manual-switch path: set the select and
// dispatch 'change' (untrusted → the mode holds); a target that never
// comes up reverts (overlap abort, or the watchdog on the serial path).
function stepRung(delta: number) {
  const next = ladder.indexOf(rung) + delta;
  if (next < 0 || next >= ladder.length) return;
  autoSwitch = true;
  setQualitySel(ladder[next]);
  qualitySel.dispatchEvent(new Event('change'));
  // The switch rode the change handler (which started it while the value
  // still named the target rung); re-show 'auto' so the UI keeps saying
  // the engine owns the ladder. Mode never flipped — no userPick.
  setQualitySel('auto');
}

// Feed the engine the ~1 Hz cumulative counters; a decision moves one
// rung. Active player only, and none while an overlap is pending — one
// pre-join at a time (the engine re-baselines on the post-pause tick
// gap, and the swap's commitPlaying resets it on engine-led switches).
for (const p of players) {
  p.addEventListener('stats', (ev) => {
    if (p !== players[activeIdx] || !autoMode || pending) return;
    const { rxData, rxLoss, rxDropped } =
      (ev as CustomEvent<PlayerStatsDetail>).detail.stats;
    const decision = engine.tick({ rxData, rxLoss, rxDropped }, performance.now());
    if (decision === 'down') stepRung(1);
    else if (decision === 'up') stepRung(-1);
  });
}

// --- Player events → UI ---
const buttonLabel: Record<PlayerState, string> = {
  idle: 'connect',
  connecting: 'connecting…',
  connected: 'stop',
  reconnecting: 'connecting…',
  error: 'connect',
};

// Both handles feed the UI; only the active player's events count (the
// pre-join's 'open'/'stats'/… are overlap plumbing, not UI state).
for (const p of players) {
  p.addEventListener('statechange', (ev) => {
    if (p !== players[activeIdx]) return;
    const s = (ev as CustomEvent<PlayerState>).detail;
    connectBtn.textContent = buttonLabel[s];
    if (s === 'idle') {
      muteBtn.disabled = true;
      muteBtn.classList.add('muted');
    }
  });

  p.addEventListener('open', () => {
    if (p !== players[activeIdx]) return;
    muteBtn.disabled = false;
    muteBtn.classList.toggle('muted', p.muted);
  });

  p.addEventListener('playing', () => {
    if (p !== players[activeIdx]) return;
    muteBtn.disabled = false;
    muteBtn.classList.toggle('muted', p.muted);
  });
}

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

// Mount the panel bound to the CURRENT active player — the handle is
// read AFTER the chunk resolves, so a swap during the import binds the
// post-swap player, and the mounting guard collapses concurrent mounts.
async function mountDebugPanel(): Promise<void> {
  if (debugHandle || debugMounting) return;
  debugMounting = true;
  try {
    const { mountDebug } = await import('./vendor/debug');
    // Panel may have been closed while the chunk was loading.
    if (debugRoot.classList.contains('visible')) debugHandle = mountDebug(players[activeIdx], debugRoot);
  } finally {
    debugMounting = false;
  }
}

async function setPanelVisible(visible: boolean): Promise<void> {
  if (visible) {
    debugRoot.classList.add('visible');
    document.body.classList.add('debug-open');
    resizer.classList.add('visible');
    localStorage.setItem('quicsrt-debug-open', '1');
    syncResizerPosition();
    await mountDebugPanel();
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
  players[activeIdx].connect().catch(() => {});
}
