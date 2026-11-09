// video.js Tech for QuicSRT live streams.
//
// Wraps the vendored player SDK (mountPlayer) behind the video.js v8 Tech
// contract: the tech's media element (this.el_) doubles as the SDK's
// <video>-element sink, playback state and events come from the PlayerHandle,
// and the handle's media-element surface (play/pause/volume/duration/
// currentTime/…) is delegated one-to-one. Live-only semantics are preserved:
// duration is Infinity once connected, buffered/seekable stay empty and
// playbackRate is fixed at 1.
//
// Sources:
//   quicsrt://host:port[/stream][?token=..&latency=..]
//       → SDK url https://host:port/wt?stream=<stream>&token=.. (stream
//         defaults to "default", latency maps to latencyMs clamped 20..8000)
//   https://host:port/wt?stream=..&token=..&latency=.. (type application/quicsrt)
//       → passed through as the SDK url option, stream/latency read from query
//
// Tech options live under the player's `quicsrt` key (video.js namespaces
// tech options by tech name): workerUrl, certHash, latencyMs, hwMode, ….
// certHash stays unset unless the embedder overrides it, so the viewer
// resolves window.CERT_HASH from the gateway's /cert-hash.js.

import videojs from 'video.js';
import type TechBase from 'video.js/dist/types/tech/tech';

import { mountPlayer } from '../../vendor/player/index';
import type { PlayerHandle, PlayerOptions } from '../../vendor/player/index';

const Tech = videojs.getTech('Tech') as unknown as typeof TechBase;

interface SourceObject {
  src: string;
  type?: string;
}

/** Options video.js passes to the tech constructor (see Player#loadTech_). */
interface TechInitOptions {
  source?: SourceObject;
  muted?: boolean;
  playsinline?: boolean;
  techId?: string;
  /** Tech-specific options: the player's `quicsrt` option object. */
  quicsrt?: PlayerOptions;
}

interface ResolvedSource {
  /** Full WebTransport endpoint (the SDK `url` option). */
  url: string;
  /** Stream name resolved from the source. */
  stream: string;
  /** Connection identity minus the stream name: url origin + path. */
  endpoint: string;
  token: string | null;
  latencyMs: number | undefined;
}

const MIN_LATENCY_MS = 20;
const MAX_LATENCY_MS = 8000;

function clampLatencyMs(value: number): number {
  return Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, value));
}

function resolveSource(src: string): ResolvedSource | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  const token = u.searchParams.get('token');
  const latencyRaw = u.searchParams.get('latency');
  const latencyMs = latencyRaw !== null && Number.isFinite(+latencyRaw)
    ? clampLatencyMs(+latencyRaw)
    : undefined;

  if (u.protocol === 'quicsrt:') {
    const stream = decodeURIComponent(u.pathname.replace(/^\/+/, '').split('/')[0] || '') || 'default';
    const wt = new URL(`https://${u.host}/wt`);
    wt.searchParams.set('stream', stream);
    if (token !== null) wt.searchParams.set('token', token);
    return { url: wt.href, stream, endpoint: `https://${u.host}/wt`, token, latencyMs };
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    return {
      url: u.href,
      stream: u.searchParams.get('stream') || 'default',
      endpoint: u.origin + u.pathname,
      token,
      latencyMs,
    };
  }
  return null;
}

// Live streams expose no buffer windows; the pre-mount surface reports the
// same frozen empty TimeRanges the SDK handle always reports.
const EMPTY_TIME_RANGES: TimeRanges = Object.freeze({
  length: 0,
  start(index: number): number {
    throw new RangeError(`no time range at index ${index}`);
  },
  end(index: number): number {
    throw new RangeError(`no time range at index ${index}`);
  },
});

export class QuicSrtTech extends Tech {
  private handle: PlayerHandle | null = null;
  private currentSource_: SourceObject | null = null;
  // Identity of the mounted connection (everything but the stream name); a
  // source change that only alters the stream switches in place via
  // setStream(), everything else remounts the pipeline.
  private mountedEndpoint: string | null = null;
  private mountedToken: string | null = null;
  private mountedLatencyMs: number | undefined;
  private readonly techOpts: PlayerOptions;
  private readonly initialMuted: boolean;

  constructor(options: TechInitOptions, ready?: () => void) {
    super(options, ready);
    this.techOpts = options?.quicsrt ?? {};
    this.initialMuted = options?.muted === true;

    // Like Html5, apply a source handed to the constructor directly; further
    // changes arrive via src() while the tech stays loaded.
    if (options?.source) this.setSrc(options.source);
    this.triggerReady();
  }

  createEl(): HTMLVideoElement {
    return videojs.dom.createEl('video', {}, {
      ...(this.options_.techId ? { id: this.options_.techId } : {}),
      class: 'vjs-tech',
      ...(this.options_.playsinline ? { playsinline: 'playsinline' } : {}),
    }) as HTMLVideoElement;
  }

  /** Set or change the source; accepts a SourceObject or a bare URL string. */
  setSrc(source: SourceObject | string): void {
    const src = typeof source === 'string' ? source : source?.src;
    const resolved = src !== undefined ? resolveSource(src) : null;
    if (!resolved) {
      this.ready(() => this.fail(`QuicSRT: unsupported source "${src}" — expected ` +
        'quicsrt://host:port[/stream][?token=..&latency=..] or an https /wt URL'));
      return;
    }
    this.currentSource_ = typeof source === 'string' ? { src } : source;

    if (this.handle && this.mountedEndpoint === resolved.endpoint
        && this.mountedToken === resolved.token
        && this.mountedLatencyMs === resolved.latencyMs) {
      // Same connection, different stream: reconnect in place — no remount,
      // no new loadstart; waiting→loadedmetadata→canplay→playing ride the
      // SDK's reconnect events.
      this.handle.setStream(resolved.stream);
      if (resolved.latencyMs !== undefined) this.handle.setLatencyMs(resolved.latencyMs);
      return;
    }
    this.mount(resolved);
  }

  /** video.js source-change entry point for techs without source handlers. */
  src(src: string): void {
    this.setSrc({ src });
  }

  private mount(resolved: ResolvedSource): void {
    const wasPlaying = this.handle !== null && !this.handle.paused;
    this.handle?.destroy();
    this.handle = null;

    const opts: PlayerOptions = {
      ...this.techOpts,
      video: this.el_ as HTMLVideoElement,
      url: resolved.url,
    };
    if (resolved.latencyMs !== undefined) opts.latencyMs = resolved.latencyMs;
    if (this.options_.muted !== undefined) opts.muted = this.options_.muted;
    const handle = mountPlayer(null, opts);
    this.bridge(handle);
    this.handle = handle;
    this.mountedEndpoint = resolved.endpoint;
    this.mountedToken = resolved.token;
    this.mountedLatencyMs = resolved.latencyMs;

    // Keep playing across a source switch; a paused player stays idle (the
    // next play() connects the new source).
    if (wasPlaying) handle.play().catch(() => {});
  }

  private bridge(handle: PlayerHandle): void {
    for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'play',
      'pause', 'timeupdate', 'volumechange', 'durationchange', 'waiting', 'ended',
      'resize']) {
      handle.addEventListener(type, () => this.trigger(type));
    }
    handle.addEventListener('error', (event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      this.ready(() => this.fail(detail?.message || 'QuicSRT playback error'));
    });
  }

  /** Surface the message as the tech error (Tech#error wraps it in a
   * MediaError and fires 'error'). Deferred via ready() so errors raised
   * during construction are not fired before the player listens. */
  private fail(message: string): void {
    (this.error as (err: unknown) => void)(message);
  }

  static isSupported(): boolean {
    return typeof window !== 'undefined'
      && typeof window.WebTransport === 'function'
      && typeof window.VideoDecoder === 'function'
      && typeof WebAssembly === 'object';
  }

  static canPlayType(type: string): string {
    return typeof type === 'string' && /^(application|video)\/quicsrt(\s*;|$)/i.test(type)
      ? 'probably'
      : '';
  }

  static canPlaySource(srcObj: { type?: string }, _options?: unknown): string {
    return QuicSrtTech.canPlayType(srcObj?.type);
  }

  play(): Promise<void> {
    if (!this.handle) return Promise.reject(new Error('QuicSRT: no source set'));
    // A fresh session's first 'play' never comes from the handle (the SDK
    // emits it only on resumes) — send it ourselves; resumes bridge the
    // handle's own event.
    const established = this.handle.readyState >= 2;
    const p = this.handle.play();
    if (!established) this.trigger('play');
    return p;
  }

  pause(): void { this.handle?.pause(); }
  paused(): boolean { return this.handle ? this.handle.paused : true; }
  ended(): boolean { return this.handle ? this.handle.ended : false; }
  currentTime(): number { return this.handle ? this.handle.currentTime : 0; }
  duration(): number { return this.handle ? this.handle.duration : 0; }

  volume(): number { return this.handle ? this.handle.volume : 1; }
  setVolume(volumeAsPercent: number): void {
    if (this.handle) this.handle.volume = volumeAsPercent;
  }

  muted(): boolean { return this.handle ? this.handle.muted : this.initialMuted; }
  setMuted(muted: boolean): void { this.handle?.setMuted(muted); }

  buffered(): TimeRanges { return this.handle ? this.handle.buffered : EMPTY_TIME_RANGES; }
  seekable(): TimeRanges { return this.handle ? this.handle.seekable : EMPTY_TIME_RANGES; }

  playbackRate(): number { return 1; }
  defaultPlaybackRate(): number { return 1; }
  setPlaybackRate(): void {
    // Live-only: the rate is fixed at 1 (featuresPlaybackRate is false).
  }

  seeking(): boolean { return false; }
  readyState(): number { return this.handle ? this.handle.readyState : 0; }
  networkState(): number {
    // 0 EMPTY, 1 IDLE, 2 LOADING — connect phases read as loading.
    if (!this.handle) return 0;
    const s = this.handle.state;
    return s === 'connecting' || s === 'reconnecting' ? 2 : 1;
  }
  loop(): boolean { return false; }
  preload(): string { return 'none'; }
  playsinline(): boolean { return this.el_.hasAttribute('playsinline'); }
  controls(): boolean { return (this.el_ as HTMLVideoElement).controls; }
  crossOrigin(): string | null { return (this.el_ as HTMLVideoElement).crossOrigin; }
  setCrossOrigin(crossOrigin: string | null): void {
    (this.el_ as HTMLVideoElement).crossOrigin = crossOrigin;
  }
  currentSrc(): string { return this.currentSource_ ? this.currentSource_.src : ''; }
  defaultMuted(): boolean { return this.initialMuted; }

  supportsFullScreen(): boolean {
    // The target browsers all expose the Fullscreen API, which video.js uses
    // on the player element without tech involvement.
    return false;
  }

  requestPictureInPicture(): Promise<PictureInPictureWindow> {
    return (this.el_ as HTMLVideoElement).requestPictureInPicture();
  }

  disablePictureInPicture(): boolean {
    return (this.el_ as HTMLVideoElement).disablePictureInPicture;
  }

  getVideoPlaybackQuality(): VideoPlaybackQuality | undefined {
    const el = this.el_ as HTMLVideoElement & { getVideoPlaybackQuality?: () => VideoPlaybackQuality };
    return el.getVideoPlaybackQuality?.();
  }

  dispose(): void {
    this.handle?.destroy();
    this.handle = null;
    super.dispose();
  }
}

// Feature flags, resolved on the prototype like video.js's own techs — the
// Tech constructor reads them during super(), before instance fields init.
// Volume: real via the handle. Playback rate: fixed at 1. Progress: never
// emitted (empty buffer windows) → video.js's manual progress probing.
// Timeupdate: the SDK emits it at ~4 Hz while playing, so the tech opts out
// of video.js's synthetic 250 ms interval.
QuicSrtTech.prototype.featuresVolumeControl = true;
QuicSrtTech.prototype.featuresPlaybackRate = false;
QuicSrtTech.prototype.featuresProgressEvents = false;
QuicSrtTech.prototype.featuresTimeupdateEvents = true;

// Importing this module is enough — the tech registers itself.
videojs.registerTech('quicsrt', QuicSrtTech);
