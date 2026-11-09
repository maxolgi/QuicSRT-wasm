// Viewer lifecycle factory. Consumed by the framework-agnostic player SDK
// (web/src/player/index.ts → mountPlayer), which wraps it in a PlayerHandle
// (EventTarget) and translates the ViewerUi callbacks into standard media
// events. Host pages wire their own UI through the SDK; ViewerUi is the
// internal hook surface.

import { VideoPipeline, OpusAudioPipeline, AacAudioPipeline } from '../decode';
import { PcmPlayer } from '../pcm-player';
import { CanvasRenderer } from '../render';
import { VideoSink } from '../video-sink';
import type { WorkerMsg, StatsMsg, DemuxStatsMsg } from '../worker';
import type { AudioMeterData } from './types';

export type ConnectionState = 'idle' | 'connecting' | 'connected';

export interface ViewerUi {
  /** Push a log line. `cls` is optional CSS class / severity. */
  log(msg: string, cls?: string): void;
  /** Set the one-line status text. */
  setStatus(s: string): void;
  /** Connection state transitioned. */
  onStateChange(s: ConnectionState): void;
  /** A video frame decoded for the first time. */
  onFirstFrame(width: number, height: number): void;
  /** VideoDecoder configured. */
  onVideoConfigured(info: { profile: number; level: number }): void;
  /** Audio pipeline became ready. */
  onAudioReady(): void;
  /** Periodic stats (worker → main). Optional — entrypoints that don't
   *  render stats in this path can omit. */
  onStats?(stats: StatsMsg, demux: DemuxStatsMsg | null): void;
  /** A/V drift sample (or null when either side has no PTS yet). */
  onDrift?(driftMs: number | null): void;
  /** Cert mode determined from cert-hash.js. Optional. */
  onCertMode?(mode: 'self' | 'mkcert'): void;
  /** Called after the `init` message is posted to a (fresh or reused) worker.
    *  Useful for posting follow-up commands like `debug-rate`. */
  onWorkerReady?(worker: Worker): void;
  /** Decoded video frame (decodeInWorker mode, or any sinkless joiner — see
   *  ViewerConfig.joiner). Host owns lifecycle — must call frame.close(). */
  onDecodedFrame?(frame: VideoFrame): void;
  /** Decoded audio data (decodeInWorker mode only). Host owns lifecycle — must call data.close(). */
  onDecodedAudio?(data: AudioData): void;
  /** Per-channel PCM audio metering (peaks/rms/clips/lufs/etc.) at ~30fps
   *  from the PcmPlayer worklet. Optional — omit when no meter UI is attached. */
  onAudioMeter?(data: AudioMeterData): void;
}

export interface ViewerConfig {
  /** Canvas element to render into. Required when decodeInWorker is false
   *  and no `video` element is supplied; unused (may be omitted) when
   *  decodeInWorker is true. */
  canvas?: HTMLCanvasElement;
  /** Video element output (opt-in). When supplied and the browser supports
   *  video MediaStreamTrackGenerator, decoded frames are written to a
   *  generator track and the element plays A+V — the audio track rides the
   *  same MediaStream (no hidden <audio> is created; PCM audio stays on
   *  WebAudio). Takes precedence over `canvas`; falls back to canvas with a
   *  console.warn when unsupported. In decodeInWorker mode frames go to the
   *  sink instead of the ui.onDecodedFrame callback. */
  video?: HTMLVideoElement;
  /** Latency input element (millisecond slider/input). Optional for embedders
   *  that drive latency via `setLatencyMs()` instead. */
  latencyInput?: HTMLInputElement;
  /** Mute button (text + disabled state managed by the viewer). Optional for
   *  embedders that drive mute via `setMuted()` instead. */
  muteBtn?: HTMLButtonElement;
  /** Initial TSBPD latency in ms. Used when `latencyInput` is absent; defaults
   *  to 120 when neither `latencyInput` nor `latencyMs` is supplied. */
  latencyMs?: number;
  /** Cert hash override. `string` = DER SHA-256 hex (self-signed, pinned via
   *  WebTransport `serverCertificateHashes`); `null` = PKI/mkcert (no pinning);
   *  omitted = fall back to `(window as any).CERT_HASH` (set by cert-hash.js). */
  certHash?: string | null;
  /** WebTransport host. Overrides `?host=`; defaults to the page host. */
  host?: string;
  /** WebTransport port. Overrides `?port=`; defaults to '4433'. */
  port?: string | number;
  /** Stream name. Overrides `?stream=` (and is overridden by `getStreamName`). */
  stream?: string;
  /** Auth token. Overrides `?token=`. */
  token?: string;
  /** UI sinks for log/status/state/etc. */
  ui: ViewerUi;
  /** Base reconnect backoff (ms). Defaults to 2000. */
  baseReconnectDelayMs?: number;
  /** Max reconnect backoff (ms). Defaults to 30000. */
  maxReconnectDelayMs?: number;
  /** Stream name resolver. When provided, overrides the URL `?stream=` param. */
  getStreamName?(): string;
  /** When true, the worker handles decode and transfers decoded VideoFrame/AudioData
   *  to main. The SDK does NOT create a CanvasRenderer, VideoPipeline, or <audio> element.
   *  The host receives frames via the ViewerUi.onDecodedFrame / onDecodedAudio callbacks. */
  decodeInWorker?: boolean;
  /** VideoDecoder hardwareAcceleration preference forwarded to the worker's
   *  pipeline (decodeInWorker mode only; main-thread decode keeps the
   *  localStorage 'quicsrt-hw-mode' default). Default 'no-preference' (the
   *  browser falls back to software decode where no hardware decoder
   *  exists). */
  hwMode?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** In decodeInWorker mode, sink worker-decoded audio (AudioData) through a
   *  MediaStreamTrackGenerator into the viewer's standard <audio>/mute path
   *  instead of emitting onDecodedAudio (default — host owns the AudioData
   *  lifecycle). No effect when decodeInWorker is false. */
  workerAudio?: boolean;
  /** When true (default), auto-reconnect with exponential backoff on disconnect.
   *  Set to false for apps that manage their own reconnection lifecycle. */
  autoReconnect?: boolean;
  /** Override the worker script URL. Defaults to the asset-relative
   *  './worker.js' beside the SDK module (npm package / CDN); bundlers
   *  resolve it as an asset reference. Set this to point at your own
   *  worker output (e.g. '/bundle/worker.js') when serving it yourself. */
  workerUrl?: string;
  /** Full WebTransport endpoint URL (e.g. 'https://host:4433/wt'). When set,
   *  overrides host/port/stream/token construction. Stream name and token
   *  are appended as query params if not already present in the URL. */
  url?: string;
  /** Sinkless connection for seamless rung switching: when true, connect
   *  builds no output — no VideoSink, no renderer, no <audio> element, no
   *  element play()/muted. Video frames surface via ui.onDecodedFrame (host
   *  MUST close() them); audio/PCM is dropped closed at the message
   *  boundary. onFirstFrame still fires; attachOutput() swaps the surface
   *  in, after which (reconnects included) the viewer behaves normally. */
  joiner?: boolean;
  /** Direct pcm consumer port (or a factory for one). When provided, raw pcm
   *  messages (with schedUs/relUs release telemetry) flow directly from the
   *  receiver worker to this port instead of the parent postMessage channel;
   *  control/stats messages keep using the parent channel. The viewer
   *  terminates and recreates the worker on every (re)connect, and a
   *  transferred port dies with its worker — so pass a FACTORY returning a
   *  fresh port when autoReconnect is on. The factory is called each time the
   *  worker is created, before the session starts. A static port works only
   *  for single-shot connections (autoReconnect: false). Default: parent-post
   *  path (unchanged reference-viewer behavior). */
  pcmPort?: MessagePort | (() => MessagePort);
}

export interface ViewerHandle {
  /** Initiate a connection. Teardown any existing connection first. */
  connect(): void;
  /** Disconnect and stop. Marks as manual so no reconnect fires. */
  disconnect(): void;
  /** Set TSBPD latency (ms). Reconnects if active and the value changed,
   *  mirroring the `latencyInput` change handler. Works without any DOM. */
  setLatencyMs(ms: number): void;
  /** Current TSBPD latency in milliseconds. */
  getLatencyMs(): number;
  /** Set the stream name. Reconnects if active and the name changed;
   *  recorded for the next connect() when idle. */
  setStream(name: string): void;
  /** Mute or unmute audio. Works without any DOM element. */
  setMuted(muted: boolean): void;
  /** Set audio volume 0..1 (clamped). Persists across reconnects and applies
   *  to the <audio> element and the PCM gain node. Internal — the Player
   *  layer exposes this as media-element `volume`. */
  setVolume(v: number): void;
  /** Suspend or resume audio output: <audio> element pause/play + PCM
   *  AudioContext suspend/resume. Persists across reconnects. Internal —
   *  the Player layer drives it from play()/pause(). */
  setAudioSuspended(suspended: boolean): void;
  /** Suspend or resume the decode path (player pause): pipelines drop
   *  encoded media before decode (main mode) and worker-decoded frames /
   *  audio are closed at the message boundary (worker mode). Persists
   *  across reconnects. Internal — the Player layer drives it from
   *  play()/pause(). */
  setDecodeSuspended(suspended: boolean): void;
  /** Late-attach the output surface (joiner mode only): constructs the
   *  VideoSink on the configured <video> (or CanvasRenderer on the canvas
   *  when no video element was given), applies persisted element state,
   *  and feeds decoded frames to it from then on instead of
   *  ui.onDecodedFrame. Idempotent; no-op with a console.warn outside
   *  joiner mode, with no active connection, or with no output configured. */
  attachOutput(): void;
  /** Tab visibility changed (drives worker visibility message). */
  onVisibilityChange(visible: boolean): void;
  /** Get the current video pipeline (or null). */
  getVideo(): VideoPipeline | null;
  /** Get the current audio pipeline (or null). */
  getAudio(): OpusAudioPipeline | AacAudioPipeline | null;
  /** Get the current renderer (or null — always null in video-element mode). */
  getRenderer(): CanvasRenderer | null;
  /** Get the current video-element sink (or null — always null in canvas mode). */
  getSink(): VideoSink | null;
  /** Get the current worker (or null). */
  getWorker(): Worker | null;
  /** True if connected or connecting. */
  isActive(): boolean;
}

export function createViewer(config: ViewerConfig): ViewerHandle {
  const {
    canvas,
    video: videoEl,
    latencyInput,
    muteBtn,
    latencyMs: initialLatencyMs,
    certHash,
    host,
    port,
    stream,
    token,
    ui,
    baseReconnectDelayMs = 2000,
    maxReconnectDelayMs = 30000,
    getStreamName,
    decodeInWorker = false,
    hwMode,
    workerAudio = false,
    joiner = false,
    autoReconnect = true,
    workerUrl,
    url: configUrl,
    pcmPort: configPcmPort,
  } = config;

  // Video-element output mode, resolved once. An unsupported browser (or a
  // missing element) renders to canvas — video output must never break
  // playback.
  const videoSinkMode = !!videoEl && VideoSink.supports();
  if (videoEl && !videoSinkMode) {
    console.warn('QuicSRT: MediaStreamTrackGenerator video output unsupported — rendering to canvas');
  }

  // Direct pcm channel: normalized to a per-worker factory. A transferred
  // MessagePort dies with the worker, so static ports are single-shot and
  // reconnecting embedders pass a factory returning a fresh port.
  let pcmPortSpent = false;
  const nextPcmPort = (): MessagePort | null => {
    if (!configPcmPort) return null;
    if (typeof configPcmPort === 'function') return configPcmPort();
    if (pcmPortSpent) {
      log('pcmPort: static port already consumed by a previous worker — pass a factory when autoReconnect is on', 'err');
      return null;
    }
    pcmPortSpent = true;
    return configPcmPort;
  };

  // --- closure state (was module-level `let` in the entrypoints) ---
  let worker: Worker | null = null;
  let video: VideoPipeline | null = null;
  let audio: OpusAudioPipeline | AacAudioPipeline | null = null;
  let pcmPlayer: PcmPlayer | null = null;
  let activePcmPid: number | null = null;
  let renderer: CanvasRenderer | null = null;
  let videoSink: VideoSink | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let audioReady = false;
  let workerAudioWriter: WritableStreamDefaultWriter<AudioData> | null = null;
  let workerAudioFailed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let manualDisconnect = false;
  let firstFrame = true;
  let connState: ConnectionState = 'idle';
  let driftTimer: ReturnType<typeof setInterval> | null = null;
  let latestDriftMs: number | null = null;
  let currentLatencyMs: number = initialLatencyMs ?? (latencyInput ? (+latencyInput.value || 120) : 120);
  let appliedLatencyMs = currentLatencyMs;
  let streamOverride: string | null = null;
  let appliedStream: string | null = null;
  let mutedState = true;
  // Persisted audio prefs. The sinks (audio element, PCM player) are recreated
  // per connection, so these are re-applied at each creation site.
  let volumePref = 1;
  let audioSuspendedPref = false;
  // Same persistence for decode suspension: main-mode pipelines are recreated
  // per connection, and worker-decoded frames are gated at the message
  // boundary.
  let decodeSuspendedPref = false;
  // Joiner output latch: a joiner connects sinkless until its first
  // attachOutput(); from then on (reconnects included) it is a normal
  // viewer.
  let outputAttached = false;

  function log(msg: string, cls = '') {
    ui.log(msg, cls);
  }

  function setStatus(s: string) {
    ui.setStatus(s);
  }

  function setConnState(s: ConnectionState) {
    connState = s;
    ui.onStateChange(s);
  }

  // True while a joiner connection has no output surface yet: every
  // per-connect creation path and the worker message boundary consults
  // this.
  function sinkless() {
    return joiner && !outputAttached;
  }

  const audioCb = {
    onError: (e: unknown) => log(`audio err: ${e}`, 'err'),
    onReady: () => {
      audioReady = true;
      wireAudio();
      ui.onAudioReady();
    },
  };

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    const delay = Math.min(baseReconnectDelayMs * 2 ** reconnectAttempts, maxReconnectDelayMs);
    reconnectAttempts++;
    log(`reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${reconnectAttempts})…`, 'info');
    setStatus(`reconnecting in ${(delay / 1000).toFixed(0)}s`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      doConnect();
    }, delay);
  }

  function cancelReconnect() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function teardown() {
    cancelReconnect();
    stopDriftMonitor();
    setConnState('idle');
    if (worker) {
      worker.postMessage({ cmd: 'stop' });
      worker.terminate();
      worker = null;
    }
    video = null;
    audio = null;
    pcmPlayer?.dispose();
    pcmPlayer = null;
    activePcmPid = null;
    renderer?.destroy();
    renderer = null;
    videoSink?.destroy();
    videoSink = null;
    try { workerAudioWriter?.close(); } catch {}
    workerAudioWriter = null;
    if (audioEl) { try { audioEl.pause(); } catch {} audioEl.srcObject = null; audioEl.remove(); }
    audioEl = null;
    audioReady = false;
    if (muteBtn) { muteBtn.disabled = true; muteBtn.classList.add('muted'); }
  }

  function startDriftMonitor() {
    if (driftTimer !== null) clearInterval(driftTimer);
    driftTimer = setInterval(() => {
      const videoPts = renderer?.currentPtsUs() ?? videoSink?.currentPtsUs() ?? null;
      const audioPts = audio?.audioPlayheadUs() ?? null;
      if (videoPts === null || audioPts === null) {
        latestDriftMs = null;
        ui.onDrift?.(null);
        return;
      }
      const driftMs = (videoPts - audioPts) / 1000;
      latestDriftMs = driftMs;
      ui.onDrift?.(driftMs);
    }, 2000);
  }

  function stopDriftMonitor() {
    if (driftTimer !== null) {
      clearInterval(driftTimer);
      driftTimer = null;
    }
    latestDriftMs = null;
    ui.onDrift?.(null);
  }

  // Re-apply persisted audio prefs to the <audio> element. It is recreated
  // per connection (wireAudio / workerAudio sink), so volume and the suspend
  // state must be re-applied at each creation site.
  function applyAudioElPrefs() {
    if (!audioEl) return;
    audioEl.volume = volumePref;
    if (audioSuspendedPref) audioEl.pause();
  }

  // The element the audio controls (mute/volume/suspend) target: the hidden
  // <audio>, or the host <video> while a video sink is attached — its stream
  // carries the audio track, so element-level audio state applies there.
  function audioOutputEl(): HTMLMediaElement | null {
    if (audioEl) return audioEl;
    return videoSink ? videoEl! : null;
  }

  // Start the host <video> for a fresh connection: muted flag, persisted
  // volume/suspend prefs, and an autoplay attempt (muted by default) — a
  // paused element presents no frames.
  function startVideoEl() {
    const el = videoEl!;
    el.muted = mutedState;
    el.volume = volumePref;
    if (audioSuspendedPref) el.pause();
    // Rejection here is a benign race (e.g. play() interrupted by a pause()
    // or a srcObject swap during reconnect), not a playback failure.
    else el.play().catch((e) => log(`video play failed: ${e}`, 'info'));
  }

  function wireAudio() {
    if (!audio || !audioReady) return;
    const track = audio.track;
    if (track) {
      if (videoSink) {
        // Video-element mode: the audio track rides the sink's stream — the
        // element plays A+V. Muted/volume/suspend state already lives on it
        // (startVideoEl / audioOutputEl).
        videoSink.addTrack(track);
        log(mutedState ? 'audio ready (muted — click to unmute)' : 'audio ready', 'info');
      } else {
        if (!audioEl) {
          audioEl = document.createElement('audio');
          document.body.appendChild(audioEl);
        }
        audioEl.srcObject = new MediaStream([track]);
        audioEl.muted = mutedState;
        applyAudioElPrefs();
        log(mutedState ? 'audio ready (muted — click to unmute)' : 'audio ready', 'info');
      }
      if (muteBtn) { muteBtn.disabled = false; muteBtn.classList.toggle('muted', mutedState); }
    } else {
      if (muteBtn) { muteBtn.disabled = false; muteBtn.classList.toggle('muted', mutedState); }
    }
  }

  // Mute toggle. Identical in both entrypoints; lives here since the viewer
  // owns audioEl and manages muteBtn text/disabled state. Only wired when an
  // embedder supplies a muteBtn; otherwise mute is driven via setMuted().
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const el = audioOutputEl();
      if (!el) return;
      setMuted(!el.muted);
    });
  }

  function hexToBytes(hex: string): Uint8Array {
    const clean = hex.replace(/[:\s]/g, '');
    if (clean.length !== 64) {
      throw new Error(`expected 32-byte (64 hex char) hash, got ${clean.length} hex chars`);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function formatLatency(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
  }

  function doConnect() {
    teardown();
    manualDisconnect = false;
    setConnState('connecting');

    if (!decodeInWorker && !videoSinkMode && !canvas) {
      log('canvas element required when decodeInWorker is false', 'err');
      return;
    }

    const hashHex = certHash !== undefined
      ? certHash
      : (window as any).CERT_HASH as string | null | undefined;
    if (hashHex === undefined) {
      log('No cert-hash.js — is the gateway running?', 'err');
      return;
    }
    ui.onCertMode?.(hashHex ? 'self' : 'mkcert');

    firstFrame = true;
    if (videoSinkMode && !sinkless()) {
      // Video-element output replaces the canvas renderer in both decode
      // paths: decoded frames go to the sink's generator track. A sinkless
      // joiner defers this to attachOutput().
      videoSink = new VideoSink(videoEl!);
      startVideoEl();
    }
    if (!decodeInWorker) {
      // The guard above guarantees a canvas whenever !decodeInWorker and no
      // video element is active; TS cannot carry that relational narrowing,
      // hence the assertion. A sinkless joiner defers the renderer to
      // attachOutput().
      if (!videoSinkMode && !sinkless()) renderer = new CanvasRenderer(canvas!);
      video = new VideoPipeline({
        onFrame: (frame) => {
          // Sinkless joiner: no surface owns the frame. Dims first — the
          // host callback may close() it — then ownership passes to the
          // host, as the worker 'videoFrame' boundary does.
          if (sinkless()) {
            if (firstFrame) {
              firstFrame = false;
              ui.onFirstFrame(frame.displayWidth, frame.displayHeight);
            }
            ui.onDecodedFrame?.(frame);
            return;
          }
          if (videoSink) videoSink.feed(frame);
          else renderer?.draw(frame);
          if (firstFrame) {
            firstFrame = false;
            ui.onFirstFrame(frame.displayWidth, frame.displayHeight);
          }
        },
        onError: (e) => log(`video err: ${e}`, 'err'),
        onConfigured: (info) => ui.onVideoConfigured(info),
      });
      // Pipelines are recreated per connect — re-apply the persisted state.
      video.setDecodeSuspended(decodeSuspendedPref);
    } else {
      // Worker-decode mode: no main-side pipeline. With a canvas the
      // transferred frames render locally (renderer owns the frames);
      // without one they go raw to the host via ui.onDecodedFrame.
      if (canvas && !videoSinkMode && !sinkless()) {
        renderer = new CanvasRenderer(canvas!);
      }
    }

    const authToken = token ?? new URLSearchParams(location.search).get('token') ?? undefined;
    const streamName = streamOverride ?? getStreamName?.() ?? stream ?? new URLSearchParams(location.search).get('stream') ?? 'default';
    appliedStream = streamName;
    let wtUrl: string;
    if (configUrl) {
      const parsed = new URL(configUrl);
      if (!parsed.searchParams.has('stream')) parsed.searchParams.set('stream', streamName);
      if (authToken && !parsed.searchParams.has('token')) parsed.searchParams.set('token', authToken);
      wtUrl = parsed.toString();
    } else {
      const pageHost = location.hostname || '127.0.0.1';
      const urlParams = new URLSearchParams(location.search);
      const wtHost = host ?? urlParams.get('host') ?? (pageHost === 'localhost' ? '127.0.0.1' : pageHost);
      const wtPort = (port ?? urlParams.get('port') ?? (window as any).WT_PORT ?? '4433').toString();
      const qp = new URLSearchParams({ stream: streamName });
      if (authToken) qp.set('token', authToken);
      wtUrl = `https://${wtHost}:${wtPort}/wt?${qp}`;
    }

    const latencyMs = latencyInput ? +latencyInput.value : currentLatencyMs;
    appliedLatencyMs = latencyMs;
    log(`TSBPD latency: ${formatLatency(latencyMs)}`, 'info');

    const hashBytes = hashHex ? hexToBytes(hashHex) : null;
    const hashLabel = hashHex ? `self-signed, hash ${hashHex.slice(0, 8)}…` : 'mkcert/PKI';
    log(`connecting to ${wtUrl} (${hashLabel}) …`, 'info');

    if (!worker) {
      if (workerUrl) {
        worker = new Worker(workerUrl, { type: 'module' });
      } else {
        // Asset-relative default: resolves the packaged worker that ships
        // beside this module (npm package / CDN). Bundlers recognize
        // new URL(..., import.meta.url) as an asset reference.
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      }
      worker.onmessage = (e: MessageEvent) => handleWorkerMsg(e.data as WorkerMsg);
      worker.onerror = (e) => {
        log(`worker error: ${e.message}`, 'err');
        if (!manualDisconnect && autoReconnect) scheduleReconnect();
      };
      // Arm the direct pcm channel on every (re)created worker. A transferred
      // port dies with the worker that received it, so reconnecting sessions
      // must supply a factory; a static port is consumed once.
      const directPort = nextPcmPort();
      if (directPort) worker.postMessage({ cmd: 'pcm-port', port: directPort }, [directPort]);
    }

    worker.postMessage(
      {
        cmd: 'init',
        url: wtUrl,
        certHash: hashBytes,
        latencyMs,
        decodeInWorker,
        hwMode,
        // Workers cannot read localStorage — forward the debug flag.
        verbose: typeof localStorage !== 'undefined' && localStorage.getItem('quicsrt-debug') === '1',
      },
      hashBytes ? [hashBytes.buffer as ArrayBuffer] : [],
    );
    ui.onWorkerReady?.(worker);

    if (!decodeInWorker) startDriftMonitor();
  }

  function handleWorkerMsg(msg: WorkerMsg) {
    if (msg.type === 'batch') {
      for (const m of msg.msgs) handleWorkerMsg(m);
      return;
    }
    switch (msg.type) {
      case 'log':
        log(msg.msg, msg.cls);
        break;
      case 'handshakeComplete':
        log('SRT handshake complete ✓', 'ok');
        reconnectAttempts = 0;
        setStatus('SRT connected; awaiting video stream');
        break;
      case 'pmt':
        // PMT always precedes PES — set the codec hint before any videoPes
        // arrives so VideoPipeline routes AV1 OBU payloads correctly.
        if (!decodeInWorker) {
          if (msg.videoPid >= 0) {
            video?.setCodecHint(msg.videoCodec);
          }
          if (msg.audioPid >= 0 && msg.audioStreamType >= 0 && !audio && !sinkless()) {
            // A sinkless joiner builds no audio pipeline (audioPes then
            // drops at the boundary); PMTs repeat, so one still appears
            // after a mid-session attachOutput().
            const isOpus = msg.audioStreamType === 0x06;
            log(`audio PID ${msg.audioPid}: ${isOpus ? 'Opus' : 'AAC'} (stream type 0x${msg.audioStreamType.toString(16)})`, 'info');
            audio = isOpus
              ? new OpusAudioPipeline(audioCb)
              : new AacAudioPipeline(audioCb);
            audio.setDecodeSuspended(decodeSuspendedPref);
          }
        }
        break;
      case 'videoFrame':
        if (firstFrame) {
          firstFrame = false;
          ui.onFirstFrame(msg.frame.displayWidth, msg.frame.displayHeight);
        }
        if (decodeSuspendedPref) {
          // Decode suspended (paused): the frame arrived already decoded —
          // release it here instead of feeding the sink/renderer (same
          // close-on-discard discipline the sink applies while paused).
          msg.frame.close();
          break;
        }
        if (videoSink) videoSink.feed(msg.frame);
        else if (renderer) renderer.draw(msg.frame); // worker-render mode: renderer owns the frame
        else ui.onDecodedFrame?.(msg.frame);
        break;
      case 'audioData':
        if (decodeSuspendedPref) {
          // Decode suspended (paused): release worker-decoded audio before
          // the sink path (which would otherwise also create it lazily).
          msg.data.close();
          break;
        }
        if (sinkless()) {
          // Sinkless joiner: no audio sinks exist — release the data at
          // the boundary.
          msg.data.close();
          break;
        }
        if (workerAudio) {
          if (!audioReady && !workerAudioFailed) {
            // Lazy sink, mirroring wireAudio(): MSTG audio track → element →
            // mute path. The pipeline vars stay null in worker mode.
            try {
              const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
              workerAudioWriter = gen.writable.getWriter();
              if (videoSink) {
                // Video-element mode: the audio track rides the sink's stream.
                videoSink.addTrack(gen);
              } else {
                if (!audioEl) {
                  audioEl = document.createElement('audio');
                  document.body.appendChild(audioEl);
                }
                audioEl.srcObject = new MediaStream([gen]);
                audioEl.muted = mutedState;
                applyAudioElPrefs();
              }
              log(mutedState ? 'audio ready (muted — click to unmute)' : 'audio ready', 'info');
              if (muteBtn) { muteBtn.disabled = false; muteBtn.classList.toggle('muted', mutedState); }
              audioReady = true;
              ui.onAudioReady();
            } catch (e) {
              // e.g. no MediaStreamTrackGenerator in old browsers: log once,
              // fall back to closing the data, never retry.
              workerAudioFailed = true;
              log(`worker audio sink failed: ${e}`, 'err');
            }
          }
          if (workerAudioWriter) {
            // On success the generator owns the data; close only on failure.
            workerAudioWriter.write(msg.data).catch(() => { try { msg.data.close(); } catch {} });
          } else {
            msg.data.close();
          }
        } else {
          ui.onDecodedAudio?.(msg.data);
        }
        break;
      case 'videoPes':
        video?.feed(msg.data, msg.pts, msg.isKeyframe, msg.dts, msg.nalOffsets, msg.nalTypes);
        break;
      case 'audioPes':
        audio?.feed(msg.data, msg.pts);
        break;
      case 'pcm': {
        // Sinkless joiner: no PcmPlayer — drop at the boundary. The next
        // message after attachOutput() builds it (lazy creation below).
        if (sinkless()) break;
        if (activePcmPid === null) {
          activePcmPid = msg.pid;
          log(`PCM active PID ${msg.pid}: ${msg.channelCount}ch SMPTE 302M`, 'info');
        }
        if (msg.pid !== activePcmPid) break;
        if (!pcmPlayer) {
          pcmPlayer = new PcmPlayer();
          pcmPlayer.setMuted(mutedState);
          pcmPlayer.setVolume(volumePref);
          if (ui.onAudioMeter) pcmPlayer.onMeter(ui.onAudioMeter);
        }
        if (!pcmPlayer.ready) {
          void pcmPlayer.init(msg.channelCount).then(() => {
            // init() resumes the AudioContext; re-suspend when the pref says so.
            if (audioSuspendedPref) void pcmPlayer?.suspend();
            else void pcmPlayer?.resume();
            pcmPlayer?.feed(msg.samples, msg.channelCount);
            if (muteBtn) { muteBtn.disabled = false; muteBtn.classList.toggle('muted', mutedState); }
          });
        } else {
          pcmPlayer.feed(msg.samples, msg.channelCount);
        }
        break;
      }
      case 'meter': {
        ui.onAudioMeter?.(msg.meter);
        break;
      }
      case 'wtReady':
        log('WT ready ✓', 'ok');
        setStatus('WT ready; awaiting SRT handshake');
        setConnState('connected');
        break;
      case 'wtClosed':
        if (msg.error) log(`WT closed (err): ${msg.error}`, 'err');
        else log('WT closed', 'info');
        setStatus('closed');
        if (!manualDisconnect && autoReconnect) scheduleReconnect();
        break;
      case 'stats':
        ui.onStats?.(msg.stats, msg.demux ?? null);
        break;
      case 'close':
        log('SRT closed', 'err');
        setStatus('closed');
        if (!manualDisconnect && autoReconnect) scheduleReconnect();
        break;
    }
  }

  function doDisconnect() {
    manualDisconnect = true;
    reconnectAttempts = 0;
    teardown();
  }

  // Late output attach (joiner mode): build the surface the connect path
  // skipped. Reassigning srcObject is intended — the caller is retiring
  // the session that owned the element.
  function attachOutput() {
    if (!joiner) {
      console.warn('QuicSRT: attachOutput() ignored — viewer is not in joiner mode');
      return;
    }
    if (outputAttached) return;
    if (connState === 'idle') {
      console.warn('QuicSRT: attachOutput() ignored — no active connection');
      return;
    }
    if (videoSinkMode) {
      videoSink = new VideoSink(videoEl!);
      startVideoEl();
    } else if (canvas) {
      renderer = new CanvasRenderer(canvas);
    } else {
      console.warn('QuicSRT: attachOutput() ignored — no video element or canvas configured');
      return;
    }
    outputAttached = true;
  }

  function setLatencyMs(ms: number) {
    currentLatencyMs = ms;
    if (latencyInput) latencyInput.value = String(ms);
    if (connState !== 'idle' && ms !== appliedLatencyMs) {
      doDisconnect();
      setTimeout(() => doConnect(), 100);
    }
  }

  function setStream(name: string) {
    streamOverride = name;
    if (connState !== 'idle' && name !== appliedStream) {
      doDisconnect();
      setTimeout(() => doConnect(), 100);
    }
  }

  function setMuted(muted: boolean) {
    mutedState = muted;
    const el = audioOutputEl();
    if (el) {
      el.muted = muted;
      // A suspended element stays paused; unmuting alone must not restart it.
      if (!muted && !audioSuspendedPref) el.play().catch((e) => log(`audio play failed: ${e}`, 'err'));
    }
    pcmPlayer?.setMuted(muted);
    if (muteBtn) muteBtn.classList.toggle('muted', muted);
  }

  function setVolume(v: number) {
    // Clamp 0..1 (HTMLMediaElement.volume throws on NaN/out-of-range).
    volumePref = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    const el = audioOutputEl();
    if (el) el.volume = volumePref;
    pcmPlayer?.setVolume(volumePref);
  }

  function setAudioSuspended(suspended: boolean) {
    audioSuspendedPref = suspended;
    const el = audioOutputEl();
    if (suspended) {
      el?.pause();
      void pcmPlayer?.suspend();
    } else {
      if (el) el.play().catch((e) => log(`audio play failed: ${e}`, 'err'));
      void pcmPlayer?.resume();
    }
  }

  // Suspend the decode path alongside the audio-output suspend above: the
  // main-mode pipelines drop encoded media, and in worker-decode mode the
  // pref gates decoded frames/audio at the message boundary (the worker's
  // own pipelines keep decoding — nothing tells them to stop).
  function setDecodeSuspended(suspended: boolean) {
    decodeSuspendedPref = suspended;
    video?.setDecodeSuspended(suspended);
    audio?.setDecodeSuspended(suspended);
  }

  return {
    connect: doConnect,
    disconnect: doDisconnect,
    setLatencyMs,
    getLatencyMs: () => currentLatencyMs,
    setStream,
    setMuted,
    setVolume,
    setAudioSuspended,
    setDecodeSuspended,
    attachOutput,
    onVisibilityChange(visible: boolean) {
      worker?.postMessage({ cmd: 'visibility', visible });
    },
    getVideo: () => video,
    getAudio: () => audio,
    getRenderer: () => renderer,
    getSink: () => videoSink,
    getWorker: () => worker,
    isActive: () => connState !== 'idle',
  };
}
