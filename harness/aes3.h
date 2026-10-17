// The M5 SMPTE 302M (AES3-in-MPEG-2-TS) unwrapper: WebSRT
// crates/mpeg2ts-wasm/src/aes3.rs (the oracle) ported 1:1 - extracts PCM
// samples from AES3 frames packed in PES payloads, matching FFmpeg's s302m
// byte layout. Internal helper of the demux port (ts_demux.cpp calls it
// from finalize_pes exactly where lib.rs:741-753 unwraps): the Rust module
// is crate-internal API, NOT wasm ABI, so nothing here is exported through
// the tsd_* C ABI (abi-census.md header note). Decode quirks are documented
// in aes3.cpp.

#ifndef SRTW_AES3_H
#define SRTW_AES3_H

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace aes3 {

struct Aes3Header {
    uint16_t frame_size = 0;
    uint8_t channel_count = 0;
    uint8_t bits_per_sample = 0;
};

struct S302mInfo {
    uint8_t channel_count = 0;
    uint32_t sample_rate = 48000;
    uint8_t bit_depth = 0;
};

constexpr uint8_t S302M_STREAM_TYPE = 0x06;
constexpr uint8_t REGISTRATION_DESC_TAG = 0x05;
// SMPTE 302M registration identifier (4-byte body of
// registration_descriptor). Per SMPTE ST 302M and ffmpeg's s302m muxer:
// "BSSD" (Broadcast Serial Sound Data).
constexpr uint8_t S302M_REGISTRATION_ID[4] = {'B', 'S', 'S', 'D'};

bool IsS302mRegistration(const uint8_t* body, size_t len);

std::optional<Aes3Header> ParseAes3Header(const uint8_t* payload, size_t len);
std::optional<S302mInfo> S302mInfoFromHeader(const uint8_t* payload, size_t len);

// Decode an AES3 PES payload to interleaved f32 PCM ([-1,1), 48 kHz).
// Returns an empty vector when the header is invalid or no whole data
// chunk fits - never throws, never partial (aes3.rs:70-116).
std::vector<float> UnwrapSmpte302mPes(const uint8_t* payload, size_t len);

} // namespace aes3

#endif // SRTW_AES3_H
