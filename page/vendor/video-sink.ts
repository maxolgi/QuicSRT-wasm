// <video> element output sink. Decoded VideoFrames are written to a video
// MediaStreamTrackGenerator whose track plays in the host's <video> element
// (srcObject), compositing GPU-side — hardware-decoded frames skip the
// per-frame GPU→CPU readback that drawing into a 2D canvas forces.
//
// Frame lifecycle follows the audio MSTG pattern (decode.ts): the generator
// closes every frame it accepts, and the sink closes a frame only on a failed
// write or when discarding it while paused — each frame is closed exactly
// once. There is no presentation ring: frames are written as they arrive and
// the element presents them, so PTS pacing and ring accounting do not apply.

export class VideoSink {
  private generator: MediaStreamTrackGenerator | null = null;
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private stream: MediaStream | null = null;
  private paused = false;
  private frameCount = 0;
  private droppedWhilePaused = 0;
  private lastWrittenPtsUs: number | null = null;
  private _width = 0;
  private _height = 0;

  constructor(video: HTMLVideoElement) {
    const MTG = VideoSink.mtgConstructor();
    if (!MTG) throw new Error('video MediaStreamTrackGenerator unsupported');
    this.generator = new MTG({ kind: 'video' });
    this.writer = this.generator.writable.getWriter();
    this.stream = new MediaStream([this.generator]);
    video.srcObject = this.stream;
  }

  /** True when this browser can construct video MediaStreamTrackGenerators. */
  static supports(): boolean {
    return VideoSink.mtgConstructor() !== null;
  }

  private static mtgConstructor(): (new (init: { kind: string }) => MediaStreamTrackGenerator) | null {
    if (typeof window === 'undefined') return null;
    return (window as unknown as {
      MediaStreamTrackGenerator?: new (init: { kind: string }) => MediaStreamTrackGenerator;
    }).MediaStreamTrackGenerator ?? null;
  }

  /** Add an audio track to the sink's stream — the element then plays A+V. */
  addTrack(track: MediaStreamTrack): void {
    this.stream?.addTrack(track);
  }

  /** Write a decoded frame to the element's track. */
  feed(frame: VideoFrame): void {
    if (this.paused) {
      // Discard arrivals; the element holds the last written frame.
      this.droppedWhilePaused++;
      frame.close();
      return;
    }
    if (frame.displayWidth !== this._width || frame.displayHeight !== this._height) {
      this._width = frame.displayWidth;
      this._height = frame.displayHeight;
    }
    this.lastWrittenPtsUs = frame.timestamp;
    this.frameCount++;
    if (this.writer) {
      // On success the generator owns (and closes) the frame; close only on
      // a failed write.
      this.writer.write(frame).catch(() => { try { frame.close(); } catch {} });
    } else {
      frame.close();
    }
  }

  /** Freeze output: incoming frames are closed on arrival without being
   *  written; the element holds the last written frame. */
  pause(): void {
    this.paused = true;
  }

  /** Un-freeze output; the next arriving frame continues at the live edge. */
  resume(): void {
    this.paused = false;
  }

  /** PTS of the last written frame in microseconds, or null before the first. */
  currentPtsUs(): number | null {
    return this.lastWrittenPtsUs;
  }

  /** Display width of the last written frame (0 before the first). */
  get width(): number { return this._width; }

  /** Display height of the last written frame (0 before the first). */
  get height(): number { return this._height; }

  getStats(): import('./shared/types').VideoSinkStats {
    return {
      frameCount: this.frameCount,
      droppedWhilePaused: this.droppedWhilePaused,
      currentPtsUs: this.lastWrittenPtsUs,
      width: this._width,
      height: this._height,
    };
  }

  /** Close the writer and release the generator track. The element keeps
   *  presenting the last written frame (canvas parity) until a new sink or
   *  the host reassigns srcObject. */
  destroy(): void {
    if (this.writer) { try { this.writer.close(); } catch {} this.writer = null; }
    this.generator = null;
    this.stream = null;
  }
}
