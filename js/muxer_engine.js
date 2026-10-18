// muxer_engine.js - the M7 JS wrapper around the emcc module's muxer C
// ABI (build/srt_engine.mjs: harness/ts_muxer.{h,cpp}).
//
// It exports the wasm-bindgen-style surface the vendored stream worker
// consumes, exactly like js/demux_engine.js mirrors the demuxer:
//
//   import init, { TsMuxer } from './muxer_engine.js';
//
// Mirrored surface (names in/out; the C ABI is the contract):
//
//   default export init()                     async, idempotent module load
//   class TsMuxer
//     new TsMuxer()
//     setVideoCodec(codec)                    'av1' | 'hevc' | else -> H.264
//     setVideoEnabled(enabled)
//     setAudioCodec(codec, channel_count)
//     addAudioPid(pid, codec, channel_count)
//     setSparseEnabled(enabled)
//     setSparseThreshold(ms)
//     push_video(data, pts_us, dts_us, is_keyframe)
//     push_audio(data, pts_us)
//     push_pcm(samples, pts_us)
//     push_pcm_pid(pid, samples, pts_us)
//     poll() -> Uint8Array                    fresh copy (COPY contract -
//                                             census §4), whole 188-B packets
//     free()
//
// Note the naming split wasm-bindgen produced (and consumers depend on):
// camelCase for the js_name setters, snake_case for push_video/
// push_audio/push_pcm/push_pcm_pid (their js_name attributes literally
// set the snake_case form).
//
// Deltas vs the wasm-bindgen glue (documented, none consumer-visible):
//   1. No FinalizationRegistry - free() is the only release path
//      (stream-worker.ts:294 calls it in doStop; the rust glue's
//      finalizer only ever ran under GC pressure anyway).
//   2. poll() hands out a slice() copy of the drain buffer, so the
//      consumer may hold it indefinitely - same ownership as the
//      wasm-bindgen Vec<u8> return.

import { loadEngineModule } from './engine_module.js';

let modulePromise = null;
let M = null; // the resolved emcc module instance

export default function init() {
    if (!modulePromise) {
        modulePromise = (async () => {
            M = await loadEngineModule();
            return M;
        })();
    }
    return modulePromise;
}

function requireModule() {
    if (!M) {
        throw new Error('muxer_engine: call init() first');
    }
    return M;
}

const UTF8 = new TextEncoder();

// tsm_poll's const uint8_t** out-parameter scratch (4 bytes, wasm32).
// One module-wide buffer: poll is synchronous and single-threaded.
let pollPtrBuf = 0;

export class TsMuxer {
    constructor() {
        const m = requireModule();
        if (pollPtrBuf === 0) {
            pollPtrBuf = m._malloc(4);
        }
        this._m = m._tsm_new();
        if (!this._m) {
            throw new Error('TsMuxer: tsm_new failed');
        }
        this._freed = false;
    }

    setVideoCodec(codec) {
        this._codecCall((ptr) => M._tsm_set_video_codec(this._m, ptr), codec);
    }

    setVideoEnabled(enabled) {
        M._tsm_set_video_enabled(this._m, enabled ? 1 : 0);
    }

    setAudioCodec(codec, channel_count) {
        this._codecCall((ptr) => M._tsm_set_audio_codec(this._m, ptr, channel_count), codec);
    }

    addAudioPid(pid, codec, channel_count) {
        this._codecCall((ptr) => M._tsm_add_audio_pid(this._m, pid, ptr, channel_count), codec);
    }

    setSparseEnabled(enabled) {
        M._tsm_set_sparse_enabled(this._m, enabled ? 1 : 0);
    }

    setSparseThreshold(ms) {
        M._tsm_set_sparse_threshold(this._m, ms);
    }

    // H.264/HEVC = Annex B NAL units, AV1 = OBUs; opaque bytes to the
    // muxer. pts/dts in µs (converted to 90 kHz internally).
    push_video(data, pts_us, dts_us, is_keyframe) {
        if (this._freed) return;
        if (!(data instanceof Uint8Array)) {
            throw new TypeError('TsMuxer.push_video: expected a Uint8Array');
        }
        const ptr = M._malloc(Math.max(1, data.length));
        M.HEAPU8.set(data, ptr);
        M._tsm_push_video(this._m, ptr, data.length, pts_us, dts_us, is_keyframe ? 1 : 0);
        M._free(ptr);
    }

    // Opus packet (the 0x7F 0xE0 AU header is prepended inside).
    push_audio(data, pts_us) {
        if (this._freed) return;
        if (!(data instanceof Uint8Array)) {
            throw new TypeError('TsMuxer.push_audio: expected a Uint8Array');
        }
        const ptr = M._malloc(Math.max(1, data.length));
        M.HEAPU8.set(data, ptr);
        M._tsm_push_audio(this._m, ptr, data.length, pts_us);
        M._free(ptr);
    }

    // Interleaved f32 PCM ([-1,1), 48 kHz); AES3-wrapped as s302m.
    push_pcm(samples, pts_us) {
        this._pcmCall((ptr, n) => M._tsm_push_pcm(this._m, ptr, n, pts_us), samples);
    }

    push_pcm_pid(pid, samples, pts_us) {
        this._pcmCall((ptr, n) => M._tsm_push_pcm_pid(this._m, pid, ptr, n, pts_us), samples);
    }

    // Drains all accumulated TS output (may be empty; always a whole
    // number of 188-B packets). Returns a fresh JS-owned copy.
    poll() {
        if (this._freed) return new Uint8Array(0);
        const len = M._tsm_poll(this._m, pollPtrBuf);
        if (len === 0) return new Uint8Array(0);
        const ptr = M.HEAPU32[pollPtrBuf >> 2];
        return M.HEAPU8.slice(ptr, ptr + len);
    }

    free() {
        if (!this._freed) {
            this._freed = true;
            M._tsm_free(this._m);
        }
    }

    /** @internal codec strings are tiny; copy in, NUL-terminate, call. */
    _codecCall(call, codec) {
        if (this._freed) return;
        const bytes = UTF8.encode(String(codec));
        const ptr = M._malloc(bytes.length + 1);
        M.HEAPU8.set(bytes, ptr);
        M.HEAPU8[ptr + bytes.length] = 0;
        call(ptr);
        M._free(ptr);
    }

    /** @internal f32 sample block copied into the shared heap. */
    _pcmCall(call, samples) {
        if (this._freed) return;
        if (!(samples instanceof Float32Array)) {
            throw new TypeError('TsMuxer.push_pcm: expected a Float32Array');
        }
        const ptr = M._malloc(Math.max(4, samples.length * 4));
        M.HEAPF32.set(samples, ptr >> 2);
        call(ptr, samples.length);
        M._free(ptr);
    }
}
