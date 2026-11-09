// <quicsrt-video>: the chrome-free QuicSRT web component.
//
// A self-registering CustomElement over the vendored player SDK
// (mountPlayer with the <video>-element sink): it resolves its `src` with
// the shared source parser (page/vendor/source.ts), creates or adopts a
// direct-child <video>, and re-dispatches the handle's media events on
// itself — the moq-js / <mux-player> drop-in shape. Light DOM on purpose
// (hosts can style the child video); no UI beyond the native video
// controls.
//
// Attributes:
//   src         quicsrt://host:port[/stream][?token=..&latency=..] or an
//               https://…/wt?stream=.. URL (same forms the video.js tech
//               accepts). Changing it (or stream/token/worker-url)
//               remounts the pipeline: full teardown, fresh session clock
//               — no in-place setStream() switch here. A playing element
//               resumes on the new source; an idle/paused one stays idle
//               until play().
//   muted       present → starts muted. Absent ALSO starts muted (autoplay-
//               safe default); muted="false" is the declarative opt-out.
//               Live changes mute/unmute at once.
//   autoplay    connect + play once the element is in the document and the
//               entry module finished wiring (see below); without it the
//               element stays idle until play().
//   controls    reflected onto the child <video> (native controls).
//   latency     TSBPD latency in ms (wins over a ?latency= in the source);
//               live changes call setLatencyMs. Takes effect at mount when
//               no session exists yet.
//   stream      fills the stream name when src is a bare
//               quicsrt://host:port (no path); token adds/replaces ?token=
//               on either source form.
//   worker-url  explicit worker URL. Resolution order: this attribute,
//               then the module default (setDefaultWorkerUrl), then the
//               SDK's asset-relative ./worker.js default.
//
// API: play()/pause() (play() mounts the pipeline on first call and
// rejects — after firing 'error' with {message} — when src is set but
// unparseable), readonly paused/currentTime/duration (defaults true/0/0
// before the first mount), volume (setter applies immediately when
// mounted, otherwise at mount), and `player` exposing the PlayerHandle
// for power users (setRungs/qualityLevels/setLatencyMs/…; null before
// the first play()).
//
// Events re-dispatched from the handle, details forwarded: loadstart,
// loadedmetadata, canplay, playing, play, pause, timeupdate (~4 Hz while
// playing), volumechange, durationchange, waiting, ended, resize
// {width,height}, qualitychange {from,to,auto}, error {message}.
//
// The autoplay start is deferred one microtask: entries importing this
// module (which may call setDefaultWorkerUrl or rewrite src) finish their
// synchronous evaluation in the same turn, before playback begins.

import { mountPlayer } from './player/index';
import type { PlayerHandle, PlayerOptions } from './player/index';
import { resolveSource } from './source';
import type { ResolvedSource } from './source';

/** Module-level worker URL every element uses unless its worker-url
 * attribute overrides it. */
let defaultWorkerUrl: string | null = null;

/** Set the worker URL <quicsrt-video> elements fall back to when no
 * worker-url attribute is set. The SDK's own default resolves ./worker.js
 * beside the SDK module — correct for the npm packages, wrong for a page
 * that bundles the worker elsewhere (this repo's pages serve
 * /bundle/worker.js); page entries call this before playback starts. */
export function setDefaultWorkerUrl(url: string): void {
  defaultWorkerUrl = url;
}

/** `stream`/`token` attribute extras folded into the source URL before
 * resolution: stream fills the stream name of a bare quicsrt://host:port
 * (no path), token adds/replaces ?token= on either source form. */
function applyAttrExtras(src: string, stream: string | null, token: string | null): string {
  if (stream === null && token === null) return src;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return src;
  }
  if (stream !== null && u.protocol === 'quicsrt:' && u.pathname.replace(/^\/+/, '') === '') {
    u.pathname = `/${encodeURIComponent(stream)}`;
  }
  if (token !== null) u.searchParams.set('token', token);
  return u.href;
}

const BRIDGED_EVENTS = [
  'loadstart', 'loadedmetadata', 'canplay', 'playing', 'play', 'pause',
  'timeupdate', 'volumechange', 'durationchange', 'waiting', 'ended',
  'resize', 'qualitychange', 'error',
];

export class QuicSrtVideoElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['src', 'muted', 'autoplay', 'controls', 'latency', 'stream', 'token', 'worker-url'];
  }

  private handle: PlayerHandle | null = null;
  private video: HTMLVideoElement | null = null;
  /** Host playback intent — survives disconnects and source remounts. */
  private wantPlaying = false;
  /** Volume set before the first mount, applied once a handle exists. */
  private volumePref = 1;

  connectedCallback(): void {
    this.ensureVideo();
    this.applyControls();
    if (this.hasAttribute('autoplay') || this.wantPlaying) this.scheduleStart();
  }

  disconnectedCallback(): void {
    this.handle?.destroy();
    this.handle = null;
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    switch (name) {
      case 'src':
      case 'stream':
      case 'token':
      case 'worker-url':
        this.remountIfLive();
        break;
      case 'muted':
        this.handle?.setMuted(this.attrMuted());
        break;
      case 'latency': {
        const ms = this.attrLatency();
        if (ms !== undefined) this.handle?.setLatencyMs(ms);
        break;
      }
      case 'autoplay':
        // Fires before connectedCallback during an upgrade of markup that
        // already carries the attribute — the deferred start covers both.
        if (newValue !== null && this.isConnected) this.scheduleStart();
        break;
      case 'controls':
        this.applyControls();
        break;
    }
  }

  /** Start (or resume) playback; mounts the pipeline on first call. */
  play(): Promise<void> {
    this.wantPlaying = true;
    if (this.handle !== null) return this.handle.play();
    const raw = this.getAttribute('src');
    const resolved = this.resolveCurrent();
    if (resolved === null) {
      if (raw !== null && raw !== '') {
        const message = `<quicsrt-video>: unsupported src "${raw}" — expected ` +
          'quicsrt://host:port[/stream][?token=..&latency=..] or an https /wt URL';
        this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
        return Promise.reject(new Error(message));
      }
      return Promise.reject(new Error('<quicsrt-video>: no src set'));
    }
    this.mount(resolved);
    return this.handle!.play();
  }

  pause(): void {
    this.wantPlaying = false;
    this.handle?.pause();
  }

  /** The mounted PlayerHandle (null before the first play()) — direct
   * access to the full SDK surface (setRungs, qualityLevels,
   * setLatencyMs, …). */
  get player(): PlayerHandle | null {
    return this.handle;
  }

  get paused(): boolean {
    return this.handle !== null ? this.handle.paused : true;
  }

  get currentTime(): number {
    return this.handle !== null ? this.handle.currentTime : 0;
  }

  get duration(): number {
    return this.handle !== null ? this.handle.duration : 0;
  }

  get volume(): number {
    return this.handle !== null ? this.handle.volume : this.volumePref;
  }

  set volume(v: number) {
    this.volumePref = v;
    if (this.handle !== null) this.handle.volume = v;
  }

  /** The media sink: adopt a direct-child <video> the host supplied, else
   * create one (playsinline, sized responsively by the component with no
   * stylesheet dependency; an adopted host video is left to the host's
   * own CSS). */
  private ensureVideo(): HTMLVideoElement {
    if (this.video !== null) return this.video;
    this.style.display = 'block';
    let video = Array.from(this.children).find(
      (c): c is HTMLVideoElement => c instanceof HTMLVideoElement,
    );
    if (video === undefined) {
      video = document.createElement('video');
      video.playsInline = true;
      video.className = 'quicsrt-video';
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.style.background = '#000';
      this.appendChild(video);
    }
    this.video = video;
    return video;
  }

  private applyControls(): void {
    if (this.video !== null) this.video.controls = this.hasAttribute('controls');
  }

  /** Defer the start one microtask (see module comment) so entry wiring
   * settles first; the handle guard makes repeated schedules no-ops. */
  private scheduleStart(): void {
    queueMicrotask(() => {
      if (this.isConnected && this.handle === null) this.play().catch(() => {});
    });
  }

  private resolveCurrent(): ResolvedSource | null {
    const raw = this.getAttribute('src');
    if (raw === null || raw === '') return null;
    return resolveSource(applyAttrExtras(raw, this.getAttribute('stream'), this.getAttribute('token')));
  }

  /** Autoplay-safe default: an absent `muted` attribute still starts
   * muted; muted="false" (any case) is the opt-out, plain `muted` or any
   * other value mutes. */
  private attrMuted(): boolean {
    const v = this.getAttribute('muted');
    return v === null ? true : v.toLowerCase() !== 'false';
  }

  private attrLatency(): number | undefined {
    const v = this.getAttribute('latency');
    return v !== null && Number.isFinite(+v) ? +v : undefined;
  }

  /** A source-affecting attribute changed: remount a mounted pipeline
   * (full teardown, fresh session clock). A playing element keeps playing
   * the new source; a paused/idle one stays idle until play(). No-op
   * before the first mount (connectedCallback/play() own the initial
   * setup), and an unparseable/removed src parks the element unmounted —
   * the next play() reports the error. */
  private remountIfLive(): void {
    if (this.handle === null) return;
    const resume = !this.handle.paused;
    const resolved = this.resolveCurrent();
    this.handle.destroy();
    this.handle = null;
    if (resolved === null) return;
    this.mount(resolved);
    if (resume) this.handle!.play().catch(() => {});
  }

  private mount(resolved: ResolvedSource): void {
    const video = this.ensureVideo();
    const opts: PlayerOptions = {
      video,
      url: resolved.url,
      muted: this.attrMuted(),
    };
    const workerUrl = this.getAttribute('worker-url') ?? defaultWorkerUrl ?? undefined;
    if (workerUrl !== undefined) opts.workerUrl = workerUrl;
    const latency = this.attrLatency() ?? resolved.latencyMs;
    if (latency !== undefined) opts.latencyMs = latency;

    this.handle?.destroy();
    const handle = mountPlayer(null, opts);
    // Applied before bridge() so the volumechange it emits finds no
    // listeners yet.
    handle.volume = this.volumePref;
    this.bridge(handle);
    this.handle = handle;
  }

  private bridge(handle: PlayerHandle): void {
    for (const type of BRIDGED_EVENTS) {
      handle.addEventListener(type, (event) => {
        const detail = (event as CustomEvent).detail;
        this.dispatchEvent(detail !== undefined
          ? new CustomEvent(type, { detail })
          : new Event(type));
      });
    }
  }
}

// Importing this module is enough — the element registers itself (mirrors
// the video.js tech adapter's side-effect import).
if (typeof window !== 'undefined' && window.customElements !== undefined) {
  window.customElements.define('quicsrt-video', QuicSrtVideoElement);
}
