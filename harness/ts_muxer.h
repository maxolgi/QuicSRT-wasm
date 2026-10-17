// The M7 muxer C ABI: the ts-muxer-wasm oracle surface (WebSRT
// crates/ts-muxer-wasm/src/lib.rs, a thin shim over native
// crates/ts-muxer/src/lib.rs + its aes3.rs encoder; mpeg2ts fork
// checkout 9a1efaf for Crc32 / Timestamp / ClockReference) ported to
// C++ behind extern "C", exported from the same emcc module as the
// receiver and the demuxer (build/srt_engine.mjs). The JS wrapper
// (js/muxer_engine.js) mirrors the wasm-bindgen naming exactly -
// camelCase setters (setVideoCodec/setVideoEnabled/setAudioCodec/
// addAudioPid/setSparseEnabled/setSparseThreshold) beside the
// snake_case pushers (push_video/push_audio/push_pcm/push_pcm_pid) and
// poll - so the vendored stream-worker keeps a one-line import swap at
// the M7 cutover (plan-notes/abi-census.md §2 is the port contract).
//
//   tsm_new / tsm_free                  muxer lifecycle
//   tsm_set_video_codec                 "av1" | "hevc" | else -> H.264
//   tsm_set_video_enabled               drop video ES + ignore push_video
//   tsm_set_audio_codec                 retarget stream[0] only
//   tsm_add_audio_pid                   append stream (dedup by pid)
//   tsm_set_sparse_enabled              opt-in silence suppression
//   tsm_set_sparse_threshold            default 300 ms
//   tsm_push_video / _push_audio        elementary input (copied in)
//   tsm_push_pcm / _push_pcm_pid        f32 PCM in, AES3-wrapped 24-bit
//   tsm_poll                            drain accumulated TS output
//
// tsm_poll returns a whole number of 188-B packets (0 allowed). The
// data pointer is owned by the muxer and stays valid until the NEXT
// tsm_poll on that muxer (drain = mem::take, native lib.rs:269-271);
// the JS wrapper copies it out fresh, matching wasm-bindgen's Vec<u8>.
//
// Mirrored oracle behavior (the Rust IS the spec - quirks included,
// see the parity harness js/muxer_parity.mjs): PAT/PMT before every
// keyframe video PES and on the first PCM push, periodic PSI every
// 9000 90-kHz ticks on the PCM path, sparse transitions rewrite the
// PMT (version_number +1 mod 32) and arm a 10x resend burst; CC
// CONTINUES mod 16 across suppression resume (the shim's "resets CC"
// doc comments are stale - tests win); PCR = pts_90k*300 in the AF of
// the first packet of a PES only when the pushed pid == pcr_pid();
// short final PES packets are 0xFF-stuffed through the adaptation
// field (never null packets); push_audio never emits PSI;
// push_audio/push_pcm with no matching-kind stream fall back to
// stream[0]'s pid (unwrap_or(0)); audio PES_packet_length is taken
// mod 2^16 (the oracle's debug_assert is compiled out of the release
// pkg, and the harness pins the wrap).

#ifndef SRTW_TS_MUXER_H
#define SRTW_TS_MUXER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TsmMuxer TsmMuxer;

TsmMuxer* tsm_new(void);
void tsm_free(TsmMuxer* m);

void tsm_set_video_codec(TsmMuxer* m, const char* codec);
void tsm_set_video_enabled(TsmMuxer* m, int enabled);
void tsm_set_audio_codec(TsmMuxer* m, const char* codec, uint8_t channel_count);
void tsm_add_audio_pid(TsmMuxer* m, uint16_t pid, const char* codec, uint8_t channel_count);
void tsm_set_sparse_enabled(TsmMuxer* m, int enabled);
void tsm_set_sparse_threshold(TsmMuxer* m, double ms);

// data/samples are copied in before the call returns (may be NULL when
// len/count is 0; push_video with len 0 still emits a PES-header-only
// packet, exactly like the oracle).
void tsm_push_video(TsmMuxer* m, const uint8_t* data, int len,
                    double pts_us, double dts_us, int is_keyframe);
void tsm_push_audio(TsmMuxer* m, const uint8_t* data, int len, double pts_us);
void tsm_push_pcm(TsmMuxer* m, const float* samples, int count, double pts_us);
void tsm_push_pcm_pid(TsmMuxer* m, uint16_t pid, const float* samples, int count, double pts_us);

// Drain: returns the byte count (always a multiple of 188) and stores
// the output pointer into *out (NULL when the drain is empty). The
// buffer is owned by the muxer and valid until the next tsm_poll.
int tsm_poll(TsmMuxer* m, const uint8_t** out);

#ifdef __cplusplus
}
#endif

#endif // SRTW_TS_MUXER_H
