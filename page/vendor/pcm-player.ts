// Phase 0 spike PCM player.
//
// Receives interleaved f32 PCM from the worker (kind=5 events emitted by the
// mpeg2ts-wasm demuxer for SMPTE 302M PIDs), plays it through an AudioWorklet.
//
// Single-PID for the spike. Phase 2 will generalize to a per-PID Map feeding
// the WASM mixer (see audioplan.md).
//
// The worklet is playback-only: it deinterleaves incoming samples into
// per-channel ring buffers and copies them into the AudioWorklet outputs.
// Audio metering (peak/RMS/LUFS/phase/FFT) is computed in WASM (meter.rs) by
// the demuxer, not here.

import type { AudioMeterData } from './shared/types';
import { PCM_PLAYER_WORKLET_FRAMES } from './shared/worklets';

export class PcmPlayer {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private initPromise: Promise<void> | null = null;
  private sampleRate = 48000;
  private droppedPackets = 0;
  private _muted = true;
  private _volume = 1;

  get ready(): boolean {
    return this.workletNode !== null;
  }

  async init(channelCount: number): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit(channelCount);
    return this.initPromise;
  }

  private async doInit(channelCount: number): Promise<void> {
    const Ctx = window.AudioContext
      || (window as unknown as Window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new Ctx({ sampleRate: this.sampleRate });
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume().catch(() => {});
    }
    const blob = new Blob([PCM_PLAYER_WORKLET_FRAMES], { type: 'application/javascript' });
    await this.audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channelCount],
    });
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this._muted ? 0 : this._volume;
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.audioCtx.destination);
  }

  feed(samples: Float32Array, channelCount: number): void {
    if (!this.workletNode) {
      this.droppedPackets++;
      return;
    }
    this.workletNode.port.postMessage({ samples, channelCount });
  }

  /** No-op: metering moved to WASM. Stub kept until viewer.ts is updated. */
  onMeter(_: (data: AudioMeterData) => void): void {}

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.gainNode) this.gainNode.gain.value = muted ? 0 : this._volume;
  }

  /** Volume 0..1. Composes with mute: effective gain is 0 when muted. */
  setVolume(v: number): void {
    this._volume = v;
    if (this.gainNode && !this._muted) this.gainNode.gain.value = v;
  }

  /** No-op: metering moved to WASM. Stub kept until AudioTab is updated. */
  setSelectedChannel(_: number): void {}

  async resume(): Promise<void> {
    if (this.audioCtx?.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  async suspend(): Promise<void> {
    if (this.audioCtx?.state === 'running') {
      await this.audioCtx.suspend();
    }
  }

  dispose(): void {
    try { this.workletNode?.disconnect(); } catch {}
    try { this.audioCtx?.close(); } catch {}
    this.workletNode = null;
    this.audioCtx = null;
    this.initPromise = null;
  }
}
