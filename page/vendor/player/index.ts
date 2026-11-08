// Framework-agnostic player SDK. Wraps createViewer() in an EventTarget-based
// handle that exposes HTMLMediaElement-like readyState/state plus media events
// (loadstart, loadedmetadata, canplay, playing, waiting, error, …).
// Intentionally free of any UI-framework or diagnostics imports — hosts wire
// those separately.
//
// Media-element surface (adapters target this; live-only caveats):
//   play()/pause()/paused/ended — play() auto-connects an idle player and
//     resolves on the first frame; pause() freezes the canvas on the last
//     frame and suspends audio. Both states survive reconnects. ended marks
//     a permanent stop (terminal error, or a non-manual stop with
//     autoReconnect off); connect()/play() clear it for a new session.
//   volume (real, 0..1 clamped) and setMuted both emit 'volumechange'.
//   duration is 0 before the first connect, Infinity after ('durationchange').
//   currentTime is a 0-based per-connection media clock from the renderer
//     PTS: frozen while paused, reset by every connection (a reconnect
//     starts a new clock), 0 with no renderer (decodeInWorker without a
//     canvas) or before the first frame.
//   buffered/seekable are always empty; playbackRate is fixed at 1 (setter
//     is a documented no-op) — live streams don't seek or trick-play.
//   Extra media events: play, pause, timeupdate (~4 Hz while frames flow),
//     volumechange, durationchange, loadedmetadata (per connection, before
//     canplay), ended.

import { createViewer } from '../shared/viewer';
import type { ViewerHandle, ConnectionState } from '../shared/viewer';
import type { CanvasRenderer } from '../render';
import type { VideoPipeline, OpusAudioPipeline, AacAudioPipeline } from '../decode';
import type { StatsMsg, DemuxStatsMsg } from '../worker';

export interface PlayerOptions {
  host?: string;
  port?: string | number;
  stream?: string;
  token?: string;
  /** DER SHA-256 hex (self-signed pin) | null (PKI/mkcert) | omit = CERT_HASH. */
  certHash?: string | null;
  /** TSBPD latency in ms. Default 120. */
  latencyMs?: number;
  /** PTS-paced canvas presentation. Default true. */
  renderPacing?: boolean;
  /** DTS-paced decode submission. Default false. */
  decodePacing?: boolean;
  /** Initial mute state. Default true (browser autoplay policy). */
  muted?: boolean;
  /** Auto-connect on construction — the host-equivalent of calling connect()
   *  right after mount (as main.ts does manually). Default false. The muted
   *  default still applies. */
  autoplay?: boolean;
  /** Decode in the Web Worker; emit decodedframe/decodedaudio events instead of
   *  owning canvas/audio sinks. Default false. */
  decodeInWorker?: boolean;
  /** VideoDecoder hardwareAcceleration preference. Default 'no-preference'
   *  (the browser falls back to software decode where no hardware decoder
   *  exists). */
  hwMode?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** Sink worker-decoded audio into the viewer's <audio>/mute path (decodeInWorker mode). Default false. */
  workerAudio?: boolean;
  /** Auto-reconnect on disconnect. Default true. Set false for custom reconnection. */
  autoReconnect?: boolean;
  /** Override worker URL for non-Vite embedding. See ViewerConfig.workerUrl. */
  workerUrl?: string;
  /** Full WebTransport endpoint URL. Overrides host/port/stream/token. */
  url?: string;
  /** Direct pcm consumer port or factory — raw pcm messages flow straight
   *  from the receiver worker to this port (control stays on the parent
   *  channel). Pass a factory when autoReconnect is on; the worker is
   *  recreated per connection and a transferred port dies with it.
   *  Default: parent-post path (reference-viewer behavior). */
  pcmPort?: MessagePort | (() => MessagePort);
}

export type PlayerState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface PlayerStatsDetail {
  stats: StatsMsg;
  demux: DemuxStatsMsg | null;
}

export interface PlayerErrorDetail {
  message: string;
}

export interface PlayerResizeDetail {
  width: number;
  height: number;
}

export interface PlayerHandle extends EventTarget {
  // Events (via addEventListener):
  //   'decodedframe'  → CustomEvent<VideoFrame>   (decodeInWorker mode only; host owns lifecycle)
  //   'decodedaudio'  → CustomEvent<AudioData>    (decodeInWorker mode only; host owns lifecycle)
  /** Connect; resolves on first decoded frame, rejects on a terminal error
   *  (or if disconnect()/destroy() interrupts the initial connect). */
  connect(): Promise<void>;
  /** Start playback. Idle player: connects and resolves on the first frame
   *  (rejects on a terminal error, exactly like connect()). Paused player:
   *  resumes at the live edge and resolves immediately after emitting
   *  'play'/'playing' — frames are already flowing, so there is nothing to
   *  wait for. Already playing: resolves immediately. */
  play(): Promise<void>;
  /** Freeze presentation on the last frame (the canvas keeps it visible) and
   *  suspend audio. No-op when destroyed, idle, or already paused. */
  pause(): void;
  disconnect(): void;
  destroy(): void;
  readonly readyState: number;
  readonly state: PlayerState;
  /** Media-element paused: true until the first frame of a session renders,
   *  false while frames flow, true again after pause() or a session stop.
   *  Follows playback output, not the play() call — a host that only calls
   *  connect() never reads as paused. */
  readonly paused: boolean;
  /** True after a permanent stop — a terminal error, or the viewer going
   *  idle without a manual disconnect while autoReconnect is off. Cleared
   *  when connect()/play() starts a new session. */
  readonly ended: boolean;
  readonly muted: boolean;
  /** Audio volume 0..1, clamped (NaN → 0). Emits 'volumechange'. */
  volume: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  /** Live duration: 0 before the first connect, Infinity once connected
   *  ('durationchange' fires on the transition). */
  readonly duration: number;
  /** 0-based session media clock (seconds) from the renderer PTS — the
   *  first presented frame of the current connection is 0. Frozen while
   *  paused (the renderer freezes its clock); reset by every fresh
   *  connection — a reconnect starts a new session clock. Reads 0 with no
   *  renderer (decodeInWorker without a canvas) or before the first frame. */
  readonly currentTime: number;
  /** Always empty — live buffer windows are not exposed. */
  readonly buffered: TimeRanges;
  /** Always empty — live streams are not seekable. */
  readonly seekable: TimeRanges;
  /** Always 1 (live-only); the setter is accepted and ignored. */
  playbackRate: number;
  setMuted(muted: boolean): void;
  setLatencyMs(ms: number): void;
  readonly latencyMs: number;
  /** Switch streams. Reconnects if active and the name changed. */
  setStream(name: string): void;
  setRenderPacing(enabled: boolean): void;
  setDecodePacing(enabled: boolean): void;
  getRenderer(): CanvasRenderer | null;
  getVideo(): VideoPipeline | null;
  getAudio(): OpusAudioPipeline | AacAudioPipeline | null;
  getWorker(): Worker | null;
}

// Live streams expose no buffer windows and are never seekable: both ranges
// are always this frozen empty TimeRanges (start/end throw RangeError per the
// TimeRanges contract, like an out-of-bounds index on a real list).
const EMPTY_TIME_RANGES: TimeRanges = Object.freeze({
  length: 0,
  start(index: number): number {
    throw new RangeError(`no time range at index ${index}`);
  },
  end(index: number): number {
    throw new RangeError(`no time range at index ${index}`);
  },
});

export function mountPlayer(canvas: HTMLCanvasElement | null, opts: PlayerOptions = {}): PlayerHandle {
  return new Player(canvas, opts);
}

class Player extends EventTarget implements PlayerHandle {
  private viewer: ViewerHandle;

  private _state: PlayerState = 'idle';
  private _readyState = 0;
  private _muted: boolean;
  private _volume = 1;
  private _paused = true;
  private _ended = false;
  private _duration = 0;
  private _ptsAnchorUs: number | null = null;
  private _videoWidth = 0;
  private _videoHeight = 0;

  private renderPacingPref: boolean;
  private decodePacingPref: boolean;
  private autoReconnect: boolean;

  private everConnected = false;
  private manualDisconnect = false;
  private destroyed = false;

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;
  private timeupdateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(canvas: HTMLCanvasElement | null, opts: PlayerOptions) {
    super();
    this._muted = opts.muted ?? true;
    this.renderPacingPref = opts.renderPacing ?? true;
    this.decodePacingPref = opts.decodePacing ?? false;
    this.autoReconnect = opts.autoReconnect ?? true;

    this.viewer = createViewer({
      canvas: canvas ?? undefined,
      host: opts.host,
      port: opts.port,
      stream: opts.stream,
      token: opts.token,
      certHash: opts.certHash,
      latencyMs: opts.latencyMs ?? 120,
      decodeInWorker: opts.decodeInWorker ?? false,
      hwMode: opts.hwMode,
      workerAudio: opts.workerAudio,
      autoReconnect: opts.autoReconnect ?? true,
      workerUrl: opts.workerUrl,
      url: opts.url,
      pcmPort: opts.pcmPort,
      ui: {
        log: (msg, cls) => this.onLog(msg, cls),
        setStatus: () => {},
        onStateChange: (s) => this.onViewerState(s),
        onFirstFrame: (w, h) => this.onFirstFrame(w, h),
        onVideoConfigured: () => {},
        onAudioReady: () => this.ensureAudioStarted(),
        onStats: (stats, demux) => this.emit('stats', { stats, demux } satisfies PlayerStatsDetail),
        onDrift: (driftMs) => { if (driftMs !== null) this.emit('drift', driftMs); },
        onDecodedFrame: (frame) => this.emit('decodedframe', frame),
        onDecodedAudio: (data) => this.emit('decodedaudio', data),
        onAudioMeter: (data) => this.emit('audiometer', data),
      },
    });

    if (opts.muted !== undefined) this.viewer.setMuted(opts.muted);

    if (opts.autoplay) {
      // Identical to a host calling connect() right after mount (main.ts
      // does it manually). The muted default keeps autoplay policy happy.
      this.connect().catch(() => {});
    }
  }

  private emit(type: string, detail?: unknown): void {
    this.dispatchEvent(detail !== undefined ? new CustomEvent(type, { detail }) : new CustomEvent(type));
  }

  private setState(s: PlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('statechange', s);
  }

  private onLog(msg: string, cls?: string): void {
    // Reconnect is scheduled with a delay — surface it immediately so the
    // host can show a buffering indicator during the wait.
    if (msg.startsWith('reconnecting in')) {
      this.setState('reconnecting');
      this.stopTimeupdate();
      this.emit('waiting');
      return;
    }
    if (cls === 'err') {
      // Missing cert-hash aborts doConnect() before any worker is created:
      // terminal — reject the pending connect promise, if any.
      if (msg.startsWith('No cert-hash.js')) {
        this.emit('error', { message: msg } satisfies PlayerErrorDetail);
        this.setState('error');
        this.failConnect(new Error(msg));
        this.markEnded();
      } else {
        // Recoverable (worker / WT / SRT) — the viewer will retry.
        this.emit('error', { message: msg } satisfies PlayerErrorDetail);
      }
    }
  }

  private onViewerState(s: ConnectionState): void {
    if (s === 'connecting') {
      if (this.everConnected && !this.manualDisconnect) {
        this.setState('reconnecting');
        this.stopTimeupdate();
        this.emit('waiting');
      } else {
        this.setState('connecting');
        this.emit('loadstart');
        this.emit('connecting');
      }
    } else if (s === 'connected') {
      this.everConnected = true;
      if (this._readyState < 1) this._readyState = 1;
      this.setState('connected');
      this.emit('open');
      // Live media has no end: duration flips 0 → Infinity once per session
      // (on reconnects it is already Infinity — no re-emit).
      if (this._duration !== Infinity) {
        this._duration = Infinity;
        this.emit('durationchange');
      }
    } else {
      // idle (viewer teardown)
      if (this.manualDisconnect) {
        this._readyState = 0;
        this._paused = true;
        this._duration = 0;
        this._ptsAnchorUs = null;
        this.everConnected = false;
        this.stopTimeupdate();
        this.setState('idle');
        this.emit('close');
      } else if (this.everConnected) {
        if (this.autoReconnect) {
          this.setState('reconnecting');
          this.stopTimeupdate();
          this.emit('waiting');
        } else if (!this.connectPromise) {
          // Permanent stop: the viewer went idle without a manual
          // disconnect and will not retry — 'ended' (manual disconnect keeps
          // 'close' as its signal). connectPromise gates out the transient
          // idle a connect() passes through while tearing down.
          this.everConnected = false;
          this.setState('idle');
          this.markEnded();
        }
      } else {
        this.setState('idle');
      }
    }
  }

  private onFirstFrame(w: number, h: number): void {
    // readyState at entry distinguishes a fresh session (≤1: nothing has
    // presented yet) from a reconnect of one that has (4: never reset during
    // reconnects) — a user pause only exists in the latter.
    const hadFrames = this._readyState >= 2;
    const changed = w !== this._videoWidth || h !== this._videoHeight;
    this._videoWidth = w;
    this._videoHeight = h;
    this._readyState = 4;
    if (changed) this.emit('resize', { width: w, height: h } satisfies PlayerResizeDetail);
    // Re-apply pacing preferences to the freshly built pipelines (pacing knobs
    // attach to renderer / decoder instances, which are recreated on connect).
    this.viewer.getRenderer()?.setRenderPacing(this.renderPacingPref);
    this.viewer.getVideo()?.setDecodePacing(this.decodePacingPref);
    // Each connection restarts the 0-based session media clock: the first
    // presented frame of THIS connection is the currentTime anchor. (In
    // decodeInWorker mode this runs before the first draw — the anchor is
    // then captured lazily at the first currentTime read.)
    this._ptsAnchorUs = this.viewer.getRenderer()?.currentPtsUs() ?? null;
    if (this._paused && hadFrames) {
      // Pause survives reconnects: the fresh renderer defaults to live —
      // re-freeze it. Audio suspension persists via the viewer's suspend
      // pref (re-applied at sink creation), no action needed here.
      this.viewer.getRenderer()?.pause();
    } else {
      // Frames render → not paused (a connect()-only host never looks paused).
      this._paused = false;
    }
    // Viewer gap owned here: the <audio> element is created paused and only
    // setMuted(false)/setAudioSuspended(false) ever start it — re-assert the
    // current audio state so an unmuted session actually sounds.
    this.ensureAudioStarted();
    this.emit('loadedmetadata');
    this.emit('canplay');
    this.emit('playing');
    if (!this._paused) this.startTimeupdate();
    if (this.resolveConnect) {
      this.resolveConnect();
      this.connectPromise = null;
      this.resolveConnect = null;
      this.rejectConnect = null;
    }
  }

  private failConnect(e: Error): void {
    if (!this.rejectConnect) return;
    this.rejectConnect(e);
    this.connectPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
  }

  /** Permanent stop (terminal error / no-reconnect idle): reset the session
   *  and fire 'ended' once. connect()/play() clear the flag for a new one. */
  private markEnded(): void {
    if (this._ended) return;
    this._ended = true;
    this._paused = true;
    this._readyState = 0;
    this._duration = 0;
    this._ptsAnchorUs = null;
    this.stopTimeupdate();
    this.emit('ended');
  }

  private startTimeupdate(): void {
    if (this.timeupdateTimer !== null) return;
    this.timeupdateTimer = setInterval(() => this.emit('timeupdate'), 250);
  }

  private stopTimeupdate(): void {
    if (this.timeupdateTimer === null) return;
    clearInterval(this.timeupdateTimer);
    this.timeupdateTimer = null;
  }

  /** Re-assert the player's audio state onto the viewer sinks. The viewer
   *  creates its <audio> element paused and only ever play()s it from
   *  setMuted(false)/setAudioSuspended(false) — so a session that starts (or
   *  reconnects) unmuted would sit silent until the next mute toggle. */
  private ensureAudioStarted(): void {
    this.viewer.setMuted(this._muted);
    this.viewer.setAudioSuspended(this._paused);
  }

  connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('player destroyed'));
    if (this.connectPromise) return this.connectPromise;
    this.manualDisconnect = false;
    // A connect() starts a new session — clears any previous 'ended'.
    this._ended = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.viewer.connect();
    return this.connectPromise;
  }

  disconnect(): void {
    if (this.destroyed) return;
    this.manualDisconnect = true;
    this.failConnect(new Error('disconnected'));
    this.viewer.disconnect();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manualDisconnect = true;
    this.failConnect(new Error('destroyed'));
    this.stopTimeupdate();
    this.viewer.disconnect();
  }

  play(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('player destroyed'));
    if (this._paused && this._readyState >= 2) {
      // Resume an established (possibly reconnecting) session at the live
      // edge. Frames are already flowing (or land with the next keyframe),
      // so resolve immediately after emitting play → playing.
      this._paused = false;
      this.viewer.getRenderer()?.resume();
      this.viewer.setAudioSuspended(false);
      this.emit('play');
      this.startTimeupdate();
      this.emit('playing');
      return Promise.resolve();
    }
    if (!this._paused) return Promise.resolve();
    // Idle / errored / pre-first-frame: play() starts a fresh session and
    // resolves on the first frame (connect() machinery rejects on terminal
    // errors); onFirstFrame flips paused when frames render.
    return this.connect();
  }

  pause(): void {
    if (this.destroyed || this._paused || !this.viewer.isActive()) return;
    this._paused = true;
    // Freeze the canvas on the last frame; suspend the audio element and
    // the PCM AudioContext (the suspend pref persists across reconnects).
    this.viewer.getRenderer()?.pause();
    this.viewer.setAudioSuspended(true);
    this.stopTimeupdate();
    this.emit('pause');
  }

  get readyState(): number { return this._readyState; }
  get state(): PlayerState { return this._state; }
  get paused(): boolean { return this._paused; }
  get ended(): boolean { return this._ended; }
  get muted(): boolean { return this._muted; }
  get latencyMs(): number { return this.viewer.getLatencyMs(); }
  get volume(): number { return this._volume; }
  set volume(v: number) {
    // Clamp silently to 0..1 (NaN → 0), mirroring ViewerHandle.setVolume.
    // HTMLMediaElement.volume throws on out-of-range instead; clamping keeps
    // this setter consistent with the viewer it drives.
    this._volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    this.viewer.setVolume(this._volume);
    this.emit('volumechange');
  }
  get videoWidth(): number { return this._videoWidth; }
  get videoHeight(): number { return this._videoHeight; }
  get duration(): number { return this._duration; }
  get currentTime(): number {
    const pts = this.viewer.getRenderer()?.currentPtsUs() ?? null;
    if (pts === null) return 0;
    // decodeInWorker reaches onFirstFrame before the first draw — anchor
    // lazily at the first observed PTS in that case.
    if (this._ptsAnchorUs === null) this._ptsAnchorUs = pts;
    return Math.max(0, (pts - this._ptsAnchorUs) / 1e6);
  }
  get buffered(): TimeRanges { return EMPTY_TIME_RANGES; }
  get seekable(): TimeRanges { return EMPTY_TIME_RANGES; }
  get playbackRate(): number { return 1; }
  set playbackRate(_rate: number) {
    // Live-only: rate is fixed at 1; accept and ignore any assignment.
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    this.viewer.setMuted(muted);
    // Spec behavior: mute changes fire 'volumechange' too.
    this.emit('volumechange');
  }

  setLatencyMs(ms: number): void { this.viewer.setLatencyMs(ms); }

  setStream(name: string): void { this.viewer.setStream(name); }

  setRenderPacing(enabled: boolean): void {
    // No-op in decodeInWorker mode (no renderer on main thread).
    this.renderPacingPref = enabled;
    this.viewer.getRenderer()?.setRenderPacing(enabled);
  }

  setDecodePacing(enabled: boolean): void {
    // No-op in decodeInWorker mode (decoder lives in worker).
    this.decodePacingPref = enabled;
    this.viewer.getVideo()?.setDecodePacing(enabled);
  }

  getRenderer(): CanvasRenderer | null { return this.viewer.getRenderer(); }
  getVideo(): VideoPipeline | null { return this.viewer.getVideo(); }
  getAudio(): OpusAudioPipeline | AacAudioPipeline | null { return this.viewer.getAudio(); }
  getWorker(): Worker | null { return this.viewer.getWorker(); }
}
