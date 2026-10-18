// The M5 SMPTE 302M unwrapper. Every quirk below is deliberate and
// pinned by the js/demux_parity.mjs golden-baseline gate:
//
//   - LSB-first bit layout (aes3.rs:59-116, ffmpeg s302m): every data byte
//     is bit-reversed before integer assembly, and the survivor masks are
//     applied BEFORE the reversal (24-bit s2: chunk[6]&0xF0 for the top
//     nibble, chunk[3]&0x0F for the low one; 20-bit: chunk[2]&0xF0 /
//     chunk[5]&0xF0; 16-bit s2: chunk[4]&0xF0). A stereo pair occupies 7
//     bytes at 24-bit, 6 at 20-bit, 5 at 16-bit - the second sample's bits
//     straddle the pair boundary.
//   - Bit-exact by construction (parity-spec 4.1): the decode is stateless
//     per sample - integer assembly (shift/or/mask) plus ONE f32 multiply
//     by SCALE_24=2^-23 / SCALE_20=2^-19 / SCALE_16=2^-15 (aes3.rs:66-68,
//     all exact powers of two). Every decoded integer fits in <= 24
//     significant bits, so the int->f32 conversion and the scaling
//     multiply are exact IEEE ops with zero rounding; no accumulation, no
//     libm, no order dependence. Rust sign-extends through
//     `((u32 as i32) >> k) as f32` / `(u16 as i16) as f32` - the C++
//     mirrors the exact same casts.
//   - chunks_exact drops any trailing partial chunk (aes3.rs:78/91/103,
//     test 279-284): sample counts are deterministic floor(n/chunk) * 2.
//   - Bad frames are not errors (aes3.rs:71-73, test 287-296): a payload
//     shorter than 4 bytes, or a header whose bits_per_sample is not
//     16/20/24 or whose channel_count is not 2/4/6/8, yields an EMPTY
//     vector - the caller (lib.rs:743-752) then emits no pcm event and
//     skips the meter update.
//   - channel_count comes from the header ((bits 15:14)*2+2) and multiplies
//     the pairs per AES3 frame, but the decode itself is pair-agnostic: it
//     just walks consecutive 2-sample chunks, so multi-channel audio is
//     the same interleaved stream (6ch = 3 consecutive pairs per frame).
//     frame_size (bits 31:16) is parsed but never used by the decode.
//   - Sample rate is a constant 48000 (aes3.rs:54) - SMPTE 302M only.

#include "aes3.h"

namespace aes3 {
namespace {

uint8_t ReverseByte(uint8_t b) {
    b = static_cast<uint8_t>(((b & 0xF0) >> 4) | ((b & 0x0F) << 4));
    b = static_cast<uint8_t>(((b & 0xCC) >> 2) | ((b & 0x33) << 2));
    b = static_cast<uint8_t>(((b & 0xAA) >> 1) | ((b & 0x55) << 1));
    return b;
}

constexpr float SCALE_24 = 1.0f / 8388608.0f; // 2^-23
constexpr float SCALE_20 = 1.0f / 524288.0f;  // 2^-19
constexpr float SCALE_16 = 1.0f / 32768.0f;   // 2^-15

} // namespace

bool IsS302mRegistration(const uint8_t* body, size_t len) {
    return len == 4 && (body[0] == 'B' && body[1] == 'S' && body[2] == 'S' && body[3] == 'D');
}

std::optional<Aes3Header> ParseAes3Header(const uint8_t* payload, size_t len) {
    if (len < 4) return std::nullopt;
    const uint32_t h = (static_cast<uint32_t>(payload[0]) << 24) |
                       (static_cast<uint32_t>(payload[1]) << 16) |
                       (static_cast<uint32_t>(payload[2]) << 8) |
                       static_cast<uint32_t>(payload[3]);
    Aes3Header out;
    out.frame_size = static_cast<uint16_t>((h >> 16) & 0xFFFF);
    out.channel_count = static_cast<uint8_t>(((h >> 14) & 0x3) * 2 + 2);
    out.bits_per_sample = static_cast<uint8_t>(((h >> 4) & 0x3) * 4 + 16);
    const bool bits_ok =
        out.bits_per_sample == 16 || out.bits_per_sample == 20 || out.bits_per_sample == 24;
    const bool channels_ok = out.channel_count == 2 || out.channel_count == 4 ||
                             out.channel_count == 6 || out.channel_count == 8;
    if (bits_ok && channels_ok) return out;
    return std::nullopt;
}

std::optional<S302mInfo> S302mInfoFromHeader(const uint8_t* payload, size_t len) {
    const auto header = ParseAes3Header(payload, len);
    if (!header) return std::nullopt;
    S302mInfo info;
    info.channel_count = header->channel_count;
    info.sample_rate = 48000;
    info.bit_depth = header->bits_per_sample;
    return info;
}

std::vector<float> UnwrapSmpte302mPes(const uint8_t* payload, size_t len) {
    const auto header = ParseAes3Header(payload, len);
    if (!header) return {};
    const uint8_t* data = payload + 4;
    const size_t data_len = len - 4;
    std::vector<float> out;
    out.reserve(data_len / 3);
    switch (header->bits_per_sample) {
        case 24:
            for (size_t off = 0; off + 7 <= data_len; off += 7) {
                const uint8_t* c = data + off;
                const uint32_t s1_u32 = (static_cast<uint32_t>(ReverseByte(c[2])) << 24) |
                                        (static_cast<uint32_t>(ReverseByte(c[1])) << 16) |
                                        (static_cast<uint32_t>(ReverseByte(c[0])) << 8);
                const uint32_t s2_u32 = (static_cast<uint32_t>(ReverseByte(c[6] & 0xF0)) << 28) |
                                        (static_cast<uint32_t>(ReverseByte(c[5])) << 20) |
                                        (static_cast<uint32_t>(ReverseByte(c[4])) << 12) |
                                        (static_cast<uint32_t>(ReverseByte(c[3] & 0x0F)) << 4);
                out.push_back(static_cast<float>(static_cast<int32_t>(s1_u32) >> 8) * SCALE_24);
                out.push_back(static_cast<float>(static_cast<int32_t>(s2_u32) >> 8) * SCALE_24);
            }
            break;
        case 20:
            for (size_t off = 0; off + 6 <= data_len; off += 6) {
                const uint8_t* c = data + off;
                const uint32_t s1_u32 = (static_cast<uint32_t>(ReverseByte(c[2] & 0xF0)) << 28) |
                                        (static_cast<uint32_t>(ReverseByte(c[1])) << 20) |
                                        (static_cast<uint32_t>(ReverseByte(c[0])) << 12);
                const uint32_t s2_u32 = (static_cast<uint32_t>(ReverseByte(c[5] & 0xF0)) << 28) |
                                        (static_cast<uint32_t>(ReverseByte(c[4])) << 20) |
                                        (static_cast<uint32_t>(ReverseByte(c[3])) << 12);
                out.push_back(static_cast<float>(static_cast<int32_t>(s1_u32) >> 12) * SCALE_20);
                out.push_back(static_cast<float>(static_cast<int32_t>(s2_u32) >> 12) * SCALE_20);
            }
            break;
        case 16:
            for (size_t off = 0; off + 5 <= data_len; off += 5) {
                const uint8_t* c = data + off;
                const uint16_t s1_u16 = static_cast<uint16_t>(
                    (static_cast<uint16_t>(ReverseByte(c[1])) << 8) |
                    static_cast<uint16_t>(ReverseByte(c[0])));
                const uint16_t s2_u16 = static_cast<uint16_t>(
                    (static_cast<uint16_t>(ReverseByte(c[4] & 0xF0)) << 12) |
                    (static_cast<uint16_t>(ReverseByte(c[3])) << 4) |
                    static_cast<uint16_t>(ReverseByte(c[2]) >> 4));
                out.push_back(static_cast<float>(static_cast<int16_t>(s1_u16)) * SCALE_16);
                out.push_back(static_cast<float>(static_cast<int16_t>(s2_u16)) * SCALE_16);
            }
            break;
        default:
            break;
    }
    return out;
}

} // namespace aes3
