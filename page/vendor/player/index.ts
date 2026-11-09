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
//     (or video-sink) PTS: frozen while paused, reset by every connection (a
//     reconnect starts a new clock), 0 with no renderer or sink
//     (decodeInWorker without a canvas) or before the first frame.
//   buffered/seekable are always empty; playbackRate is fixed at 1 (setter
//     is a documented no-op) — live streams don't seek or trick-play.
//   Extra media events: play, pause, timeupdate (~4 Hz while frames flow),
//     volumechange, durationchange, loadedmetadata (per connection, before
//     canplay), ended.
// Quality ladder / ABR (inert until setRungs()): rungs are rendition
// stream-name suffixes the source publishes as `${base}_${suffix}`;
// qualityLevels() exposes the video.js-shaped level list, and
// qualityLevels().selectedIndex = -1 (the default) lets the built-in ABR
// engine step the ladder off the ~1 Hz 'stats' events. Switches are serial
// setStream reconnects confirmed by 'playing' and bounded by a 12 s
// watchdog; the `seamless` option swaps that for an overlap join (see
// PlayerOptions.seamless). See setRungs()/qualityLevels() below for the
// full contract.

import { createViewer } from '../shared/viewer';
import type { ViewerHandle, ConnectionState } from '../shared/viewer';
import type { AudioMeterData } from '../shared/types';
import type { CanvasRenderer } from '../render';
import type { VideoSink } from '../video-sink';
import type { VideoPipeline, OpusAudioPipeline, AacAudioPipeline } from '../decode';
import type { StatsMsg, DemuxStatsMsg } from '../worker';
import { createAbr } from '../abr';
import type { AbrEngine } from '../abr';
import { createQualityLevelList } from '../quality';
import type { QualityLevelList, QualityLevelListInternal } from '../quality';

export type { QualityLevel, QualityLevelList } from '../quality';

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
  /** <video> element output (opt-in). Decoded frames are written to a video
   *  MediaStreamTrackGenerator and played by the element; audio rides the
   *  same MediaStream (no hidden <audio>). Takes precedence over the canvas
   *  argument; falls back to canvas with a console.warn when unsupported. */
  video?: HTMLVideoElement;
  /** Direct pcm consumer port or factory — raw pcm messages flow straight
   *  from the receiver worker to this port (control stays on the parent
   *  channel). Pass a factory when autoReconnect is on; the worker is
   *  recreated per connection and a transferred port dies with it.
   *  Default: parent-post path (reference-viewer behavior). */
  pcmPort?: MessagePort | (() => MessagePort);
  /** Seamless (freezeless) rung switching on a connected player: instead
   *  of a serial setStream reconnect, a hidden sinkless joiner viewer
   *  pre-connects to the target stream and swaps in on its first decoded
   *  frame — the old stream keeps playing until then. Default false. */
  seamless?: boolean;
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

/** Rung values ('' = source) name the streams; auto marks an engine-initiated
 *  switch (false = host/manual). */
export interface PlayerQualityChangeDetail {
  from: string;
  to: string;
  auto: boolean;
}

export interface PlayerHandle extends EventTarget {
  // Events (via addEventListener):
  //   'decodedframe'  → CustomEvent<VideoFrame>   (decodeInWorker mode only; host owns lifecycle)
  //   'decodedaudio'  → CustomEvent<AudioData>    (decodeInWorker mode only; host owns lifecycle)
  //   'qualitychange' → CustomEvent<PlayerQualityChangeDetail>
  //                     (every applied ladder switch: ABR steps, manual picks,
  //                     setStream() onto a ladder stream, watchdog reverts,
  //                     and with `seamless`, join swaps and join-abort reverts)
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
  /** 0-based session media clock (seconds) from the renderer (or video-sink)
   *  PTS — the first presented frame of the current connection is 0. Frozen
   *  while paused (the renderer/sink freeze their clocks); reset by every
   *  fresh connection — a reconnect starts a new session clock. Reads 0 with
   *  no renderer or sink (decodeInWorker without a canvas) or before the
   *  first frame. */
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
  /** Configure the rendition ladder and arm the quality machinery. `rungs`
   *  is the ordered TOP-DOWN list of rendition stream-name suffixes the
   *  source publishes as `${base}_${suffix}` (e.g. ['540p']); the ladder
   *  prepends the base stream itself as the top rung ('' / source). The
   *  base is the stream the player was constructed with (`stream` option)
   *  or the target of the last setStream() that did not itself name a
   *  rung. `null` tears the ladder back down. Suffixes are trimmed,
   *  empties dropped, duplicates removed. Inert by default: without
   *  setRungs() the level list stays empty and no switching or ABR runs. */
  setRungs(rungs: string[] | null): void;
  /** The live quality-level list (video.js QualityLevelList-shaped; see
   *  page/vendor/quality.ts). Levels carry {id, label, height?, bitrate?}
   *  — id/label are the rung value ('' = source), height parses from
   *  '<n>p' suffixes, bitrate is not derivable in v1 — plus a `selected`
   *  flag naming the rung currently playing. List events: 'change'
   *  (selection moved), 'addqualitylevel'/'removequalitylevel' (setRungs
   *  rebuilds). `selectedIndex` reads -1 while automatic selection (ABR)
   *  owns the ladder — the default; assigning an index switches to that
   *  rung manually and parks the engine, assigning -1 re-engages it.
   *  Rungs whose switch watchdog fires are benched for the session:
   *  skipped by auto stepping, unbenched by re-picking them or by
   *  re-engaging auto. */
  qualityLevels(): QualityLevelList;
  /** Switch streams. Reconnects if active and the name changed. With a
   *  ladder configured, a target naming a rung of the current base
   *  (`${base}` or `${base}_${suffix}`) rides the ladder machinery —
   *  selection follows, the switch is watched and 'qualitychange' fires;
   *  in manual mode the manual pick follows too. Any other target
   *  re-homes the ladder: it becomes the new base with the source rung
   *  selected (no ladder switch is applied). */
  setStream(name: string): void;
  setRenderPacing(enabled: boolean): void;
  setDecodePacing(enabled: boolean): void;
  getRenderer(): CanvasRenderer | null;
  getSink(): VideoSink | null;
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

// A ladder switch must confirm with a 'playing' within this window or the
// watchdog reverts it to the last confirmed rung and benches the failed
// one for the session (mirrors the reference page's watchdog windows).
const QUALITY_SWITCH_TIMEOUT_MS = 12_000;

/** A seamless overlap join in flight: the joiner viewer pre-connects
 *  sinkless to the target stream; its first frame promotes it, the timer
 *  aborts a join that never decoded (bench + revert). `prevStream` is
 *  what the active viewer keeps playing if the join is dropped. */
interface PendingJoin {
  rung: string;
  fromRung: string;
  auto: boolean;
  viewer: ViewerHandle;
  t0: number;
  prevStream: string | undefined;
  timer: ReturnType<typeof setTimeout> | null;
}

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
  private readonly seamless: boolean;
  /** Constructor inputs kept for seamless joiner mounts (same surface and
   *  endpoint config as the primary viewer). */
  private readonly canvasEl: HTMLCanvasElement | null;
  private readonly viewerOpts: PlayerOptions;
  private readonly workerDecode: boolean;
  /** An output surface (canvas or video element) is configured — joiner
   *  attachOutput() is meaningful only then; without one a joiner stays
   *  sinkless forever and frames keep flowing to 'decodedframe'. */
  private readonly hasOutput: boolean;

  private everConnected = false;
  private manualDisconnect = false;
  private destroyed = false;

  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;
  private timeupdateTimer: ReturnType<typeof setInterval> | null = null;

  // --- Quality ladder / ABR (all inert until setRungs() arms it) ---
  private levels: QualityLevelListInternal;
  private abrEngine: AbrEngine | null = null;
  /** Configured rung suffixes, top-down; null = no ladder. */
  private rungs: string[] | null = null;
  /** Base (source) stream name: the `stream` option, or the last host
   *  setStream() target that did not itself name a rung. */
  private baseStream: string | undefined;
  /** The last stream name handed to the viewer. */
  private appliedStream: string | undefined;
  /** The manually picked rung (ladder value); null = automatic. */
  private manualRung: string | null = null;
  /** The rung whose stream the player is on (derived from appliedStream). */
  private currentRung: string | null = null;
  /** The last rung confirmed by a 'playing' — the watchdog fallback. */
  private confirmedRung: string | null = null;
  /** Rungs whose switch watchdog fired this session (skipped by auto). */
  private benched = new Set<string>();
  /** A switch is in flight: applied, awaiting its confirming 'playing'. */
  private inFlight = false;
  /** The in-flight switch was engine-initiated. */
  private pendingAuto = false;
  private qualityTimer: ReturnType<typeof setTimeout> | null = null;
  /** Overlap join in flight (seamless only; null otherwise). */
  private pendingJoin: PendingJoin | null = null;
  /** True between a join swap and the swap frame's onDecodedFrame call:
   *  that frame predates attachOutput(), so it closes instead of emitting
   *  — the attached surface presents from the next frame. */
  private dropSwapFrame = false;

  constructor(canvas: HTMLCanvasElement | null, opts: PlayerOptions) {
    super();
    this._muted = opts.muted ?? true;
    this.renderPacingPref = opts.renderPacing ?? true;
    this.decodePacingPref = opts.decodePacing ?? false;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.seamless = opts.seamless ?? false;
    this.canvasEl = canvas;
    this.viewerOpts = opts;
    this.workerDecode = opts.decodeInWorker ?? false;
    this.hasOutput = !!(canvas || opts.video);
    this.baseStream = opts.stream;
    this.appliedStream = opts.stream;
    this.levels = createQualityLevelList({
      getSelectedIndex: () =>
        this.manualRung === null ? -1 : this.qualityLadder().indexOf(this.manualRung),
      setSelectedIndex: (index) => this.onSelectIndex(index),
    });

    this.viewer = Player.mountViewer(this, canvas, opts, false);

    if (opts.muted !== undefined) this.viewer.setMuted(opts.muted);

    if (opts.autoplay) {
      // Identical to a host calling connect() right after mount (main.ts
      // does it manually). The muted default keeps autoplay policy happy.
      this.connect().catch(() => {});
    }
  }

  /** Single createViewer wiring for the primary viewer and seamless
   *  joiners: every ui callback carries its viewer so the player can
   *  identity-gate callbacks to whichever viewer is active. A joiner
   *  additionally connects sinkless (ViewerConfig.joiner) and never takes
   *  a pcmPort (its pcm drops at the message boundary pre-attach). */
  private static mountViewer(p: Player, canvas: HTMLCanvasElement | null, opts: PlayerOptions, joiner: boolean): ViewerHandle {
    const self = createViewer({
      canvas: canvas ?? undefined,
      video: opts.video,
      host: opts.host,
      port: opts.port,
      stream: opts.stream,
      token: opts.token,
      certHash: opts.certHash,
      latencyMs: joiner ? p.viewer.getLatencyMs() : opts.latencyMs ?? 120,
      decodeInWorker: opts.decodeInWorker ?? false,
      hwMode: opts.hwMode,
      workerAudio: opts.workerAudio,
      joiner,
      autoReconnect: opts.autoReconnect ?? true,
      workerUrl: opts.workerUrl,
      url: opts.url,
      pcmPort: joiner ? undefined : opts.pcmPort,
      ui: {
        log: (msg, cls) => p.onLog(self, msg, cls),
        setStatus: () => {},
        onStateChange: (s) => p.onViewerState(self, s),
        onFirstFrame: (w, h) => p.onFirstFrame(self, w, h),
        onVideoConfigured: () => {},
        onAudioReady: () => p.onAudioReady(self),
        onStats: (stats, demux) => p.onStats(self, stats, demux),
        onDrift: (driftMs) => p.onDrift(self, driftMs),
        onDecodedFrame: (frame) => p.onDecodedFrame(self, frame),
        onDecodedAudio: (data) => p.onDecodedAudio(self, data),
        onAudioMeter: (data) => p.onAudioMeter(self, data),
      },
    });
    return self;
  }

  private emit(type: string, detail?: unknown): void {
    this.dispatchEvent(detail !== undefined ? new CustomEvent(type, { detail }) : new CustomEvent(type));
  }

  private setState(s: PlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('statechange', s);
  }

  /** Reconnect-ish transition: surface 'waiting' and re-baseline the ABR
   *  engine — the fresh connection restarts the cumulative stats counters
   *  at zero, so deltas against the old baseline would be nonsense. */
  private noteWaiting(): void {
    this.setState('reconnecting');
    this.stopTimeupdate();
    this.abrEngine?.reset();
    this.emit('waiting');
  }

  private onLog(sender: ViewerHandle, msg: string, cls?: string): void {
    if (sender !== this.viewer) {
      // Joiner traffic surfaces errors only — its reconnect churn must
      // not flip the still-playing session's state.
      if (cls === 'err') {
        this.emit('error', { message: msg } satisfies PlayerErrorDetail);
      }
      return;
    }
    // Reconnect is scheduled with a delay — surface it immediately so the
    // host can show a buffering indicator during the wait.
    if (msg.startsWith('reconnecting in')) {
      this.noteWaiting();
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

  private onViewerState(sender: ViewerHandle, s: ConnectionState): void {
    // Only the active viewer drives player state (a joiner's transitions
    // stay internal; the old viewer's post-swap teardown is dropped).
    if (sender !== this.viewer) return;
    if (s === 'connecting') {
      if (this.everConnected && !this.manualDisconnect) {
        this.noteWaiting();
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
          this.noteWaiting();
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

  private onFirstFrame(sender: ViewerHandle, w: number, h: number): void {
    if (sender !== this.viewer) {
      // A non-active viewer's first frame is the join swap signal.
      this.onJoinerFirstFrame(sender, w, h);
      return;
    }
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
    this._ptsAnchorUs = this.viewer.getRenderer()?.currentPtsUs() ?? this.viewer.getSink()?.currentPtsUs() ?? null;
    if (this._paused && hadFrames) {
      // Pause survives reconnects: the fresh renderer/sink default to live —
      // re-freeze them. Audio suspension persists via the viewer's suspend
      // pref (re-applied at sink creation), no action needed here; decode
      // suspension persists the same way and is re-asserted below.
      this.viewer.getRenderer()?.pause();
      this.viewer.getSink()?.pause();
      this.viewer.setDecodeSuspended(true);
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
    // The switch window closes right at 'playing': the current rung is
    // confirmed and ABR decisions may resume. A pending join owns that
    // confirmation instead — this frame must not confirm the unconfirmed
    // target.
    if (this.pendingJoin === null) this.onQualityConfirmed();
    this.emit('playing');
    if (!this._paused) this.startTimeupdate();
    if (this.resolveConnect) {
      this.resolveConnect();
      this.connectPromise = null;
      this.resolveConnect = null;
      this.rejectConnect = null;
    }
  }

  private onAudioReady(sender: ViewerHandle): void {
    if (sender !== this.viewer) return;
    this.ensureAudioStarted();
  }

  private onStats(sender: ViewerHandle, stats: StatsMsg, demux: DemuxStatsMsg | null): void {
    // Joiner stats stay dark while the active viewer feeds the ~1 Hz
    // stream; post-promotion the joiner is the feed.
    if (sender !== this.viewer) return;
    this.emit('stats', { stats, demux } satisfies PlayerStatsDetail);
    this.abrTick(stats);
  }

  private onDrift(sender: ViewerHandle, driftMs: number | null): void {
    if (sender !== this.viewer || driftMs === null) return;
    this.emit('drift', driftMs);
  }

  private onDecodedFrame(sender: ViewerHandle, frame: VideoFrame): void {
    if (sender !== this.viewer) {
      // Pre-attach joiner frame — no surface owns it.
      frame.close();
      return;
    }
    if (this.dropSwapFrame) {
      // The frame that triggered the swap predates attachOutput() — the
      // attached surface presents from the next frame.
      this.dropSwapFrame = false;
      frame.close();
      return;
    }
    this.emit('decodedframe', frame);
  }

  private onDecodedAudio(sender: ViewerHandle, data: AudioData): void {
    if (sender !== this.viewer) {
      data.close();
      return;
    }
    this.emit('decodedaudio', data);
  }

  private onAudioMeter(sender: ViewerHandle, data: AudioMeterData): void {
    if (sender !== this.viewer) return;
    this.emit('audiometer', data);
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
    this.cancelJoin();
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
    // The new session plays (pause persists only across automatic
    // reconnects): clear any decode suspension so frames flow and
    // onFirstFrame can fire.
    this.viewer.setDecodeSuspended(false);
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
    this.cancelJoin();
    this.viewer.disconnect();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manualDisconnect = true;
    this.failConnect(new Error('destroyed'));
    this.stopTimeupdate();
    this.disarmQualityWatchdog();
    this.cancelJoin();
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
      this.viewer.getSink()?.resume();
      this.viewer.setAudioSuspended(false);
      this.viewer.setDecodeSuspended(false);
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
    this.viewer.getSink()?.pause();
    this.viewer.setAudioSuspended(true);
    // Suspend decode as well, but only once frames are established: before
    // the first frame, onFirstFrame() must still fire (it resolves connect()
    // and flips a pre-first-frame pause back to playing).
    if (this._readyState >= 2) this.viewer.setDecodeSuspended(true);
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
    const pts = this.viewer.getRenderer()?.currentPtsUs() ?? this.viewer.getSink()?.currentPtsUs() ?? null;
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

  setLatencyMs(ms: number): void {
    // A pending join mounted at the old latency — re-switch so the swap
    // lands at the new one (the viewer-side reconnect this triggers may
    // carry the switch serially; that reconnect freezes anyway).
    const join = this.pendingJoin;
    const changed = join !== null && this.viewer.getLatencyMs() !== ms;
    this.viewer.setLatencyMs(ms);
    if (join !== null && changed) {
      this.cancelJoin();
      this.switchToRung(join.rung, join.auto);
    }
  }

  setStream(name: string): void {
    const rung = this.rungs !== null ? this.rungForStream(name) : null;
    if (rung !== null) {
      // A ladder stream: the switch rides the ladder machinery (selection
      // follows, the watchdog protects it); a manual pick follows the host.
      if (this.manualRung !== null) this.manualRung = rung;
      this.switchToRung(rung, false);
      return;
    }
    // Off-ladder: the pending join's target names the old ladder — drop it.
    this.cancelJoin();
    this.baseStream = name;
    this.appliedStream = name;
    if (this.rungs !== null) {
      // Off-ladder: the name re-homes the ladder — it becomes the base and
      // the source rung ('') names what plays next. No ladder switch.
      this.benched.clear();
      this.currentRung = '';
      this.confirmedRung = '';
      this.levels.select('');
    }
    this.viewer.setStream(name);
  }

  setRungs(rungs: string[] | null): void {
    if (this.destroyed) return;
    this.rungs = rungs === null
      ? null
      : [...new Set(rungs.map((s) => s.trim()).filter((s) => s !== ''))];
    this.benched.clear();
    this.disarmQualityWatchdog();
    this.cancelJoin();
    this.inFlight = false;
    this.pendingAuto = false;
    if (this.rungs === null) {
      this.abrEngine = null;
      this.manualRung = null;
      this.currentRung = null;
      this.confirmedRung = null;
      this.levels.rebuild([]);
      return;
    }
    this.abrEngine = this.abrEngine ?? createAbr();
    const ladder = this.qualityLadder();
    // A reconfigure keeps a manual pick that survives the new ladder and
    // re-derives what is playing from the applied stream.
    this.manualRung = this.manualRung !== null && ladder.includes(this.manualRung) ? this.manualRung : null;
    this.currentRung = this.appliedStream !== undefined ? this.rungForStream(this.appliedStream) : null;
    this.confirmedRung = this.confirmedRung !== null && ladder.includes(this.confirmedRung)
      ? this.confirmedRung
      : this.currentRung;
    this.levels.rebuild(ladder);
    this.levels.select(this.currentRung);
  }

  qualityLevels(): QualityLevelList {
    return this.levels;
  }

  // --- Quality ladder internals ---

  /** The effective ladder: the source rung ('') plus the configured rungs,
   *  top-down; empty while no rungs are configured. */
  private qualityLadder(): string[] {
    return this.rungs !== null ? ['', ...this.rungs] : [];
  }

  private streamForRung(rung: string): string | undefined {
    if (this.baseStream === undefined) return undefined;
    return rung === '' ? this.baseStream : `${this.baseStream}_${rung}`;
  }

  /** The ladder rung a stream name maps to, or null when it is not a
   *  ladder stream of the current base. */
  private rungForStream(name: string): string | null {
    if (this.baseStream === undefined) return null;
    if (name === this.baseStream) return '';
    for (const rung of this.rungs ?? []) {
      if (name === `${this.baseStream}_${rung}`) return rung;
    }
    return null;
  }

  private switchToRung(rung: string, auto: boolean): void {
    const target = this.streamForRung(rung);
    if (target === undefined) return; // no known base to build a target from
    if (this.pendingJoin !== null) {
      // One join at a time: a re-pick of the pending target is a no-op;
      // any other pick supersedes it (the 12 s join window bounds the
      // thrash).
      if (this.pendingJoin.rung === rung) return;
      this.cancelJoin();
    }
    const from = this.currentRung;
    const prevStream = this.appliedStream;
    // An applied switch is an explicit retry of a benched rung.
    this.benched.delete(rung);
    this.currentRung = rung;
    this.levels.select(rung);
    if (target === this.appliedStream) return; // already on it — bookkeeping only
    this.appliedStream = target;
    this.inFlight = true;
    this.pendingAuto = auto;
    if (this.seamless && this.viewer.isActive()) {
      // Overlap join: the old stream keeps playing while the joiner
      // pre-connects; 'qualitychange' fires at the swap (or the abort),
      // when the new rung is actually live.
      this.startJoin(rung, from ?? '', prevStream, auto);
      return;
    }
    this.armQualityWatchdog();
    this.emit('qualitychange', { from: from ?? '', to: rung, auto } satisfies PlayerQualityChangeDetail);
    this.viewer.setStream(target);
  }

  /** One rung along the ladder (down = toward lower quality), clamped at
   *  the ends and skipping rungs benched this session. */
  private stepRung(delta: number): void {
    const ladder = this.qualityLadder();
    let i = this.currentRung === null ? -1 : ladder.indexOf(this.currentRung);
    do {
      i += delta;
      if (i < 0 || i >= ladder.length) return;
    } while (this.benched.has(ladder[i]));
    this.switchToRung(ladder[i], true);
  }

  /** Feed one ~1 Hz stats sample to the ABR engine and apply a decision.
   *  Everything that must not race a switch or a reconnect gates here (the
   *  reference page's rules): manual mode, a switch awaiting its 'playing',
   *  any non-connected state, pause, no known base. */
  private abrTick(stats: StatsMsg): void {
    if (this.rungs === null || this.abrEngine === null) return;
    if (this.manualRung !== null) return;
    if (this.inFlight) return;
    if (this._state !== 'connected') return;
    if (this._paused) return;
    if (this.baseStream === undefined) return;
    const decision = this.abrEngine.tick(
      { rxData: stats.rxData, rxLoss: stats.rxLoss, rxDropped: stats.rxDropped },
      performance.now(),
    );
    if (decision === 'down') this.stepRung(1);
    else if (decision === 'up') this.stepRung(-1);
  }

  private armQualityWatchdog(): void {
    this.disarmQualityWatchdog();
    this.qualityTimer = setTimeout(() => {
      this.qualityTimer = null;
      this.onQualityTimeout();
    }, QUALITY_SWITCH_TIMEOUT_MS);
  }

  private disarmQualityWatchdog(): void {
    if (this.qualityTimer === null) return;
    clearTimeout(this.qualityTimer);
    this.qualityTimer = null;
  }

  /** The switched-to rung never confirmed with a 'playing' inside the
   *  window: bench it for the session and revert to the last confirmed
   *  rung. The revert rides the serial switch path but arms no watchdog of
   *  its own (the reference page behaves the same); its own 'playing'
   *  confirms it. */
  private onQualityTimeout(): void {
    const failed = this.currentRung;
    if (failed !== null) this.benched.add(failed);
    const back = this.confirmedRung ?? '';
    if (this.manualRung === failed) this.manualRung = back;
    this.currentRung = back;
    this.levels.select(back);
    const target = this.streamForRung(back)!;
    this.emit('qualitychange', { from: failed ?? '', to: back, auto: this.pendingAuto } satisfies PlayerQualityChangeDetail);
    this.appliedStream = target;
    // inFlight stays set: decisions stay suspended until the revert's 'playing'.
    this.viewer.setStream(target);
  }

  /** A connection reached its first frame ('playing'): the current rung is
   *  confirmed and the switch window closes. */
  private onQualityConfirmed(): void {
    if (this.rungs === null) return;
    this.disarmQualityWatchdog();
    const wasAuto = this.inFlight && this.pendingAuto;
    this.inFlight = false;
    this.pendingAuto = false;
    this.confirmedRung = this.currentRung;
    if (wasAuto) this.abrEngine?.reset(); // fresh decision window after an ABR step
  }

  // --- Seamless overlap join (seamless option; one in flight at a time) ---

  private startJoin(rung: string, fromRung: string, prevStream: string | undefined, auto: boolean): void {
    // The serial watchdog would revert the unconfirmed selection mid-join;
    // the join window owns confirmation until the swap or the abort.
    this.disarmQualityWatchdog();
    const viewer = Player.mountViewer(this, this.canvasEl, this.viewerOpts, true);
    const join: PendingJoin = {
      rung, fromRung, auto, viewer,
      t0: performance.now(),
      prevStream,
      timer: null,
    };
    join.timer = setTimeout(() => this.onJoinTimeout(), QUALITY_SWITCH_TIMEOUT_MS);
    this.pendingJoin = join;
    const target = this.streamForRung(rung)!;
    viewer.setStream(target); // recorded for the idle connect() below
    viewer.connect();
  }

  /** Drop a pending join without abort semantics (superseded switch,
   *  teardown, ladder reconfigure): frees the joiner's worker and
   *  restores appliedStream to what the active viewer keeps playing. */
  private cancelJoin(): void {
    const join = this.pendingJoin;
    if (join === null) return;
    this.pendingJoin = null;
    if (join.timer !== null) clearTimeout(join.timer);
    join.viewer.disconnect();
    this.appliedStream = join.prevStream;
  }

  /** The 12 s join window closed with no joiner frame: bench the rung and
   *  revert the selection. The old stream never stopped playing, so no
   *  setStream back — the switch window closes here instead. */
  private onJoinTimeout(): void {
    const join = this.pendingJoin;
    if (join === null) return;
    this.pendingJoin = null;
    if (join.timer !== null) clearTimeout(join.timer);
    join.viewer.disconnect();
    this.benched.add(join.rung);
    const back = this.confirmedRung ?? '';
    if (this.manualRung === join.rung) this.manualRung = back;
    this.currentRung = back;
    this.levels.select(back);
    this.appliedStream = this.streamForRung(back)!;
    this.emit('qualitychange', { from: join.rung, to: back, auto: join.auto } satisfies PlayerQualityChangeDetail);
    this.onQualityConfirmed();
  }

  /** The joiner decoded its first frame — the swap signal. Promote the
   *  joiner to the active viewer, retire the old one, and carry the
   *  player state across so the swap presents without a blip. */
  private onJoinerFirstFrame(sender: ViewerHandle, w: number, h: number): void {
    const join = this.pendingJoin;
    if (join === null || join.viewer !== sender) return; // stray frame — ignore
    this.pendingJoin = null;
    if (join.timer !== null) clearTimeout(join.timer);
    const old = this.viewer;
    // Read before the disconnect — the old viewer's idle transition resets
    // _paused.
    const wasPaused = this._paused;
    // Promote before the disconnect so the old viewer's teardown callbacks
    // land as non-active (identity-gated) and surface no churn.
    this.viewer = sender;
    old.disconnect();
    // Replay the player state BEFORE the attach: the attach builds the
    // surface with the viewer-side prefs applied (muted/volume/suspend).
    sender.setMuted(this._muted);
    sender.setVolume(this._volume);
    sender.setAudioSuspended(wasPaused);
    sender.setDecodeSuspended(wasPaused);
    if (this.hasOutput) {
      // Main mode: the sinkless-path frame that triggered this swap
      // re-enters onDecodedFrame after the attach — close it there.
      this.dropSwapFrame = !this.workerDecode;
      sender.attachOutput();
    }
    if (wasPaused) {
      sender.getRenderer()?.pause();
      sender.getSink()?.pause();
    }
    sender.getRenderer()?.setRenderPacing(this.renderPacingPref);
    sender.getVideo()?.setDecodePacing(this.decodePacingPref);
    // A rung swap starts a new session clock (reconnect parity).
    this._ptsAnchorUs = null;
    const changed = w !== this._videoWidth || h !== this._videoHeight;
    this._videoWidth = w;
    this._videoHeight = h;
    if (changed) this.emit('resize', { width: w, height: h } satisfies PlayerResizeDetail);
    if (this._state !== 'connected') {
      // The old viewer dropped mid-join (its reconnect surfaced 'waiting')
      // — the joiner is connected: pair it back up.
      this.setState('connected');
      this.emit('open');
    }
    this.emit('loadedmetadata');
    this.emit('canplay');
    this.onQualityConfirmed();
    this.emit('playing');
    if (!this._paused) this.startTimeupdate();
    console.info('abr: seamless switch %s -> %s (join %dms)', join.fromRung, join.rung, Math.round(performance.now() - join.t0));
    this.emit('qualitychange', { from: join.fromRung, to: join.rung, auto: join.auto } satisfies PlayerQualityChangeDetail);
  }

  /** list.selectedIndex assignment: -1 re-engages auto (an explicit retry —
   *  benched rungs are unbenched); a valid index is a manual pick, an
   *  invalid one is ignored. */
  private onSelectIndex(index: number): void {
    if (this.destroyed) return;
    if (index === -1) {
      if (this.manualRung === null) return;
      this.manualRung = null;
      this.benched.clear();
      this.abrEngine?.reset();
      return;
    }
    const ladder = this.qualityLadder();
    if (!Number.isInteger(index) || index < 0 || index >= ladder.length) return;
    this.manualRung = ladder[index];
    this.switchToRung(this.manualRung, false);
  }

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
  getSink(): VideoSink | null { return this.viewer.getSink(); }
  getVideo(): VideoPipeline | null { return this.viewer.getVideo(); }
  getAudio(): OpusAudioPipeline | AacAudioPipeline | null { return this.viewer.getAudio(); }
  getWorker(): Worker | null { return this.viewer.getWorker(); }
}
