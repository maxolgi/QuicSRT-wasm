// The M7 muxer port: crates/ts-muxer-wasm/src/lib.rs (shim) over native
// crates/ts-muxer/src/lib.rs + aes3.rs, behind the tsm_* C ABI of
// ts_muxer.h. The Rust IS the spec - every quirk is mirrored, not
// fixed (native line cites below). Byte-identical poll() output vs the
// oracle is the gate (js/muxer_parity.mjs, zero exclusions).
//
// Port notes, keyed to the native source:
//   - us_to_90k = (us.max(0.0) * 9.0 / 100.0) as u64 (n:586-588):
//     clamp, then the (v*9)/100 double chain, then truncation toward
//     zero - identical arithmetic in C++.
//   - Timestamp/ClockReference byte layouts (mpeg2ts fork time.rs):
//     5-byte PTS/DTS with marker bits and the 4-bit check prefix; PCR =
//     (pts_90k & 0x1FFFFFFFF) * 300 written 33-bit base + '111111'
//     reserved + 9-bit extension (extension always 0 here).
//   - The pcr field (n:202, 279) is write-only in the oracle (written
//     by push_video/push_pcm_stream, never read - the AF PCR comes from
//     the packetize pcr_base argument); kept for structural fidelity.
//   - aes3 wrap: only the 24-bit arm is reachable through this ABI
//     (the sole call site hardcodes bit_depth 24, n:345); the 16/20-bit
//     arms of aes3.rs are dead here and not ported.
//   - Sparse: silence = every |s| <= 1e-6 (f32 compare, n:590-597);
//     suppress when silence_ms > threshold (STRICT, n:303); CC is NOT
//     reset across suppression (n:83-84 doc comment is stale,
//     sparse_resume_keeps_cc_continuous n:910-948 wins).

#include "ts_muxer.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// ---- constants (native lib.rs:13-33) --------------------------------------------

constexpr size_t TS_PACKET_SIZE = 188;
constexpr uint16_t PAT_PID = 0x0000;
constexpr uint16_t DEFAULT_VIDEO_PID = 0x100;
constexpr uint16_t DEFAULT_AUDIO_PID = 0x101;
constexpr uint16_t PMT_PID = 0x1000;

constexpr uint8_t STREAM_TYPE_H264 = 0x1B;
constexpr uint8_t STREAM_TYPE_HEVC = 0x24;
constexpr uint8_t STREAM_TYPE_PRIVATE = 0x06;

constexpr uint8_t AV1_DESCRIPTOR[] = {0x05, 0x04, 0x41, 0x56, 0x30, 0x31};
constexpr uint8_t OPUS_DESCRIPTOR[] = {0x05, 0x04, 0x4F, 0x70, 0x75, 0x73, 0x7F, 0x02, 0x80, 0x02};
constexpr uint8_t S302M_DESCRIPTOR[] = {0x05, 0x04, 0x42, 0x53, 0x53, 0x44};

constexpr uint8_t SYNC_BYTE = 0x47;

constexpr float SILENCE_THRESHOLD = 1e-6f; // f32, like the Rust const
constexpr uint32_t PMT_RESEND_COUNT = 10;
// Minimum PTS interval between periodic PAT/PMT emissions in push_pcm
// (9000 ticks at 90 kHz = 100 ms).
constexpr uint64_t PSI_INTERVAL_TICKS = 9000;

constexpr uint64_t TIMESTAMP_MAX = (1ULL << 33) - 1; // mpeg2ts Timestamp::MAX

const uint8_t kNoBytes[1] = {0}; // stand-in for NULL data + len 0

enum class AudioKind { Opus, Smpte302m };

struct AudioStream {
    uint16_t pid;
    uint8_t cc;
    AudioKind kind;
    uint8_t channel_count;
    double silence_ms;
    bool suppressed;

    uint8_t stream_type() const { return STREAM_TYPE_PRIVATE; }
    std::vector<uint8_t> descriptor() const {
        const uint8_t* d;
        size_t n;
        switch (kind) {
            case AudioKind::Opus: d = OPUS_DESCRIPTOR; n = sizeof(OPUS_DESCRIPTOR); break;
            case AudioKind::Smpte302m: d = S302M_DESCRIPTOR; n = sizeof(S302M_DESCRIPTOR); break;
        }
        return std::vector<uint8_t>(d, d + n);
    }
};

AudioKind CodecToAudioKind(const char* codec) {
    // n:144-153 / 155-170: only "s302m" selects 302M, everything else
    // (including "opus" and unknown strings) is Opus.
    return std::strcmp(codec, "s302m") == 0 ? AudioKind::Smpte302m : AudioKind::Opus;
}

// ---- CRC-32/MPEG-2 (mpeg2ts fork crc.rs; same table the demux port uses) --------

class Crc32 {
public:
    Crc32() : v_(0xFFFFFFFFu) {}
    void Update(const uint8_t* p, size_t n) {
        for (size_t i = 0; i < n; i++) {
            v_ = kTable[static_cast<uint8_t>(v_) ^ p[i]] ^ (v_ >> 8);
        }
    }
    uint32_t Value() const { // swap_bytes
        return ((v_ & 0x000000FFu) << 24) | ((v_ & 0x000000FF00u) << 8) |
               ((v_ & 0x00FF0000u) >> 8) | (v_ >> 24);
    }

private:
    uint32_t v_;
    static const uint32_t kTable[256];
};

const uint32_t Crc32::kTable[256] = {
    0x00000000, 0xB71DC104, 0x6E3B8209, 0xD926430D, 0xDC760413, 0x6B6BC517, 0xB24D861A, 0x0550471E,
    0xB8ED0826, 0x0FF0C922, 0xD6D68A2F, 0x61CB4B2B, 0x649B0C35, 0xD386CD31, 0x0AA08E3C, 0xBDBD4F38,
    0x70DB114C, 0xC7C6D048, 0x1EE09345, 0xA9FD5241, 0xACAD155F, 0x1BB0D45B, 0xC2969756, 0x758B5652,
    0xC836196A, 0x7F2BD86E, 0xA60D9B63, 0x11105A67, 0x14401D79, 0xA35DDC7D, 0x7A7B9F70, 0xCD665E74,
    0xE0B62398, 0x57ABE29C, 0x8E8DA191, 0x39906095, 0x3CC0278B, 0x8BDDE68F, 0x52FBA582, 0xE5E66486,
    0x585B2BBE, 0xEF46EABA, 0x3660A9B7, 0x817D68B3, 0x842D2FAD, 0x3330EEA9, 0xEA16ADA4, 0x5D0B6CA0,
    0x906D32D4, 0x2770F3D0, 0xFE56B0DD, 0x494B71D9, 0x4C1B36C7, 0xFB06F7C3, 0x2220B4CE, 0x953D75CA,
    0x28803AF2, 0x9F9DFBF6, 0x46BBB8FB, 0xF1A679FF, 0xF4F63EE1, 0x43EBFFE5, 0x9ACDBCE8, 0x2DD07DEC,
    0x77708634, 0xC06D4730, 0x194B043D, 0xAE56C539, 0xAB068227, 0x1C1B4323, 0xC53D002E, 0x7220C12A,
    0xCF9D8E12, 0x78804F16, 0xA1A60C1B, 0x16BBCD1F, 0x13EB8A01, 0xA4F64B05, 0x7DD00808, 0xCACDC90C,
    0x07AB9778, 0xB0B6567C, 0x69901571, 0xDE8DD475, 0xDBDD936B, 0x6CC0526F, 0xB5E61162, 0x02FBD066,
    0xBF469F5E, 0x085B5E5A, 0xD17D1D57, 0x6660DC53, 0x63309B4D, 0xD42D5A49, 0x0D0B1944, 0xBA16D840,
    0x97C6A5AC, 0x20DB64A8, 0xF9FD27A5, 0x4EE0E6A1, 0x4BB0A1BF, 0xFCAD60BB, 0x258B23B6, 0x9296E2B2,
    0x2F2BAD8A, 0x98366C8E, 0x41102F83, 0xF60DEE87, 0xF35DA999, 0x4440689D, 0x9D662B90, 0x2A7BEA94,
    0xE71DB4E0, 0x500075E4, 0x892636E9, 0x3E3BF7ED, 0x3B6BB0F3, 0x8C7671F7, 0x555032FA, 0xE24DF3FE,
    0x5FF0BCC6, 0xE8ED7DC2, 0x31CB3ECF, 0x86D6FFCB, 0x8386B8D5, 0x349B79D1, 0xEDBD3ADC, 0x5AA0FBD8,
    0xEEE00C69, 0x59FDCD6D, 0x80DB8E60, 0x37C64F64, 0x3296087A, 0x858BC97E, 0x5CAD8A73, 0xEBB04B77,
    0x560D044F, 0xE110C54B, 0x38368646, 0x8F2B4742, 0x8A7B005C, 0x3D66C158, 0xE4408255, 0x535D4351,
    0x9E3B1D25, 0x2926DC21, 0xF0009F2C, 0x471D5E28, 0x424D1936, 0xF550D832, 0x2C769B3F, 0x9B6B5A3B,
    0x26D61503, 0x91CBD407, 0x48ED970A, 0xFFF0560E, 0xFAA01110, 0x4DBDD014, 0x949B9319, 0x2386521D,
    0x0E562FF1, 0xB94BEEF5, 0x606DADF8, 0xD7706CFC, 0xD2202BE2, 0x653DEAE6, 0xBC1BA9EB, 0x0B0668EF,
    0xB6BB27D7, 0x01A6E6D3, 0xD880A5DE, 0x6F9D64DA, 0x6ACD23C4, 0xDDD0E2C0, 0x04F6A1CD, 0xB3EB60C9,
    0x7E8D3EBD, 0xC990FFB9, 0x10B6BCB4, 0xA7AB7DB0, 0xA2FB3AAE, 0x15E6FBAA, 0xCCC0B8A7, 0x7BDD79A3,
    0xC660369B, 0x717DF79F, 0xA85BB492, 0x1F467596, 0x1A163288, 0xAD0BF38C, 0x742DB081, 0xC3307185,
    0x99908A5D, 0x2E8D4B59, 0xF7AB0854, 0x40B6C950, 0x45E68E4E, 0xF2FB4F4A, 0x2BDD0C47, 0x9CC0CD43,
    0x217D827B, 0x9660437F, 0x4F460072, 0xF85BC176, 0xFD0B8668, 0x4A16476C, 0x93300461, 0x242DC565,
    0xE94B9B11, 0x5E565A15, 0x87701918, 0x306DD81C, 0x353D9F02, 0x82205E06, 0x5B061D0B, 0xEC1BDC0F,
    0x51A69337, 0xE6BB5233, 0x3F9D113E, 0x8880D03A, 0x8DD09724, 0x3ACD5620, 0xE3EB152D, 0x54F6D429,
    0x7926A9C5, 0xCE3B68C1, 0x171D2BCC, 0xA000EAC8, 0xA550ADD6, 0x124D6CD2, 0xCB6B2FDF, 0x7C76EEDB,
    0xC1CBA1E3, 0x76D660E7, 0xAFF023EA, 0x18EDE2EE, 0x1DBDA5F0, 0xAAA064F4, 0x738627F9, 0xC49BE6FD,
    0x09FDB889, 0xBEE0798D, 0x67C63A80, 0xD0DBFB84, 0xD58BBC9A, 0x62967D9E, 0xBBB03E93, 0x0CADFF97,
    0xB110B0AF, 0x060D71AB, 0xDF2B32A6, 0x6836F3A2, 0x6D66B4BC, 0xDA7B75B8, 0x035D36B5, 0xB440F7B1,
};

// ---- mpeg2ts time.rs byte layouts ------------------------------------------------

// Timestamp::to_bytes (time.rs:64-86): 5 bytes, big-endian, marker bits
// at 32/16/0 and the 4-bit check_bits prefix ('0010' lone PTS,
// '0011'/'0001' PTS/DTS pairs).
void TimestampToBytes(uint8_t out[5], uint64_t t, uint8_t check_bits) {
    const uint64_t n0 = check_bits;
    const uint64_t n1 = t >> 30;
    const uint64_t n2 = (t >> 15) & ((1 << 15) - 1);
    const uint64_t n3 = t & ((1 << 15) - 1);
    const uint64_t n = (n0 << 36) | (n1 << 33) | (1ULL << 32) | (n2 << 17) | (1ULL << 16) | (n3 << 1) | 1;
    for (int i = 0; i < 5; i++) out[i] = static_cast<uint8_t>(n >> (8 * (4 - i)));
}

// ClockReference::pcr_to_bytes (time.rs:145-156): 33-bit base, 6
// reserved bits '111111' (0x7E), 9-bit extension.
void PcrToBytes(uint8_t out[6], uint64_t v) {
    const uint64_t base = v / 300;
    const uint64_t ext = v % 300;
    out[0] = static_cast<uint8_t>(base >> 25);
    out[1] = static_cast<uint8_t>(base >> 17);
    out[2] = static_cast<uint8_t>(base >> 9);
    out[3] = static_cast<uint8_t>(base >> 1);
    out[4] = static_cast<uint8_t>(((base & 1) << 7) | 0x7E | (ext >> 8));
    out[5] = static_cast<uint8_t>(ext & 0xFF);
}

// ---- free helpers (native lib.rs:425-597) -----------------------------------------

// packetize_psi (n:432-463): one PSI section across N packets; first
// packet PUSI + pointer_field 0x00, continuation packets raw section
// bytes, final packet 0xFF-stuffed.
void PacketizePsi(std::vector<uint8_t>& output, uint16_t pid, uint8_t* cc, const uint8_t* section, size_t len) {
    size_t offset = 0;
    bool first = true;
    while (offset < len) {
        const size_t overhead = first ? 1 : 0;
        const size_t payload_room = TS_PACKET_SIZE - 4 - overhead;
        const size_t chunk = std::min(len - offset, payload_room);

        uint8_t pkt[TS_PACKET_SIZE] = {0};
        pkt[0] = SYNC_BYTE;
        pkt[1] = (first ? 0x40 : 0x00) | static_cast<uint8_t>((pid >> 8) & 0x1F);
        pkt[2] = static_cast<uint8_t>(pid & 0xFF);
        pkt[3] = 0x10 | (*cc & 0x0F);
        *cc = (*cc + 1) & 0x0F;

        size_t pos = 4;
        if (first) {
            pkt[pos] = 0x00; // pointer_field: section starts right here
            pos += 1;
        }
        std::memcpy(pkt + pos, section + offset, chunk);
        std::memset(pkt + pos + chunk, 0xFF, TS_PACKET_SIZE - pos - chunk);
        output.insert(output.end(), pkt, pkt + TS_PACKET_SIZE);

        offset += chunk;
        first = false;
    }
}

// packetize (n:466-540): PES bytes into TS packets; PCR (8-B AF) on the
// first packet when pcr_base is set, 0x40 random_access flag on the
// first packet of a keyframe video PES, 0xFF AF stuffing for short
// final packets. Never emits null packets.
void Packetize(std::vector<uint8_t>& output, uint16_t pid, uint8_t* cc, const uint8_t* data, size_t total,
               bool has_pcr_base, uint64_t pcr_base, bool random_access) {
    if (total == 0) {
        return;
    }

    size_t offset = 0;
    bool first = true;
    while (offset < total) {
        const bool pcr_on_this = first && has_pcr_base;
        const size_t pcr_overhead = pcr_on_this ? 8 : 0;
        const size_t payload_room = TS_PACKET_SIZE - 4 - pcr_overhead;

        const size_t remaining = total - offset;
        const size_t chunk = std::min(remaining, payload_room);
        const bool is_last = offset + chunk == total;
        const bool needs_stuffing = is_last && chunk < payload_room;

        uint8_t pkt[TS_PACKET_SIZE] = {0};
        pkt[0] = SYNC_BYTE;
        pkt[1] = (first ? 0x40 : 0x00) | static_cast<uint8_t>((pid >> 8) & 0x1F);
        pkt[2] = static_cast<uint8_t>(pid & 0xFF);

        size_t pos = 4;
        if (pcr_overhead > 0 || needs_stuffing) {
            pkt[3] = 0x30 | (*cc & 0x0F);
            *cc = (*cc + 1) & 0x0F;

            const size_t af_total = TS_PACKET_SIZE - 4 - chunk;
            const size_t af_length = af_total - 1;
            pkt[pos] = static_cast<uint8_t>(af_length);
            pos += 1;

            if (af_length >= 1) {
                uint8_t flags = 0;
                if (pcr_overhead > 0) {
                    flags |= 0x10;
                }
                if (first && random_access) {
                    flags |= 0x40;
                }
                pkt[pos] = flags;
                pos += 1;

                if (pcr_overhead > 0) {
                    uint8_t pcr[6];
                    // ClockReference::new((pcr_base & Timestamp::MAX) * 300)
                    PcrToBytes(pcr, (pcr_base & TIMESTAMP_MAX) * 300);
                    std::memcpy(pkt + pos, pcr, 6);
                    pos += 6;
                }
                std::memset(pkt + pos, 0xFF, TS_PACKET_SIZE - chunk - pos);
            }
            pos = TS_PACKET_SIZE - chunk;
        } else {
            pkt[3] = 0x10 | (*cc & 0x0F);
            *cc = (*cc + 1) & 0x0F;
        }

        std::memcpy(pkt + pos, data + offset, chunk);
        output.insert(output.end(), pkt, pkt + TS_PACKET_SIZE);

        offset += chunk;
        first = false;
    }
}

// build_pes_video (n:542-565): unbounded PES_packet_length (0x0000),
// PTS always, DTS only when dts != pts.
std::vector<uint8_t> BuildPesVideo(const uint8_t* data, size_t len, uint64_t pts_90k, uint64_t dts_90k) {
    const bool has_dts = dts_90k != pts_90k;
    const uint8_t flags2 = has_dts ? 0xC0 : 0x80;
    const uint8_t header_len = has_dts ? 10 : 5;
    const uint8_t pts_prefix = has_dts ? 0b0011 : 0b0010;

    std::vector<uint8_t> pes;
    pes.reserve(9 + header_len + len);
    const uint8_t head[] = {0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, flags2, header_len};
    pes.insert(pes.end(), head, head + sizeof(head));
    uint8_t ts[5];
    TimestampToBytes(ts, pts_90k & TIMESTAMP_MAX, pts_prefix);
    pes.insert(pes.end(), ts, ts + 5);
    if (has_dts) {
        TimestampToBytes(ts, dts_90k & TIMESTAMP_MAX, 0b0001);
        pes.insert(pes.end(), ts, ts + 5);
    }
    pes.insert(pes.end(), data, data + len);
    return pes;
}

// build_pes_audio (n:567-584): bounded PES_packet_length = 3+5+len
// (16-bit WRAP - the oracle's debug_assert is compiled out of the
// release pkg, and the parity harness pins the wrap), PTS only.
std::vector<uint8_t> BuildPesAudio(const uint8_t* data, size_t len, uint64_t pts_90k) {
    const uint16_t pes_packet_length = static_cast<uint16_t>(3 + 5 + len);
    std::vector<uint8_t> pes;
    pes.reserve(9 + 5 + len);
    pes.push_back(0x00);
    pes.push_back(0x00);
    pes.push_back(0x01);
    pes.push_back(0xC0);
    pes.push_back(static_cast<uint8_t>(pes_packet_length >> 8));
    pes.push_back(static_cast<uint8_t>(pes_packet_length & 0xFF));
    pes.push_back(0x80);
    pes.push_back(0x80);
    pes.push_back(0x05);
    uint8_t ts[5];
    TimestampToBytes(ts, pts_90k & TIMESTAMP_MAX, 0b0010);
    pes.insert(pes.end(), ts, ts + 5);
    pes.insert(pes.end(), data, data + len);
    return pes;
}

// us_to_90k (n:586-588): clamp negatives, (v*9)/100, truncate.
uint64_t UsTo90k(double us) {
    const double v = us > 0.0 ? us : 0.0;
    return static_cast<uint64_t>(v * 9.0 / 100.0);
}

// is_silent (n:590-597): every |s| <= 1e-6 (f32).
bool IsSilent(const float* samples, size_t count) {
    for (size_t i = 0; i < count; i++) {
        if (std::fabs(samples[i]) > SILENCE_THRESHOLD) {
            return false;
        }
    }
    return true;
}

// ---- aes3.rs: wrap_smpte302m_pes, 24-bit arm (the only reachable one) ------------

float ClipF32(float s) { // aes3.rs clamp(-1.0, 0.99999994)
    return std::min(std::max(s, -1.0f), 0.99999994f);
}

uint8_t ReverseByte(uint8_t b) {
    b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
    b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
    b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
    return b;
}

// 4-byte AES3 header (aes3.rs:10-15): frame_size | ch_idx<<14 |
// bits_idx<<4, big-endian. ch_idx = (ch-2)/2, bits_idx = (bits-16)/4.
void BuildAes3Header(uint8_t out[4], uint16_t frame_size, uint8_t channel_count, uint8_t bits_per_sample) {
    const uint32_t ch_idx = ((static_cast<uint32_t>(channel_count) - 2) / 2) & 0x3;
    const uint32_t bits_idx = ((static_cast<uint32_t>(bits_per_sample) - 16) / 4) & 0x3;
    const uint32_t h = (static_cast<uint32_t>(frame_size) << 16) | (ch_idx << 14) | (bits_idx << 4);
    out[0] = static_cast<uint8_t>(h >> 24);
    out[1] = static_cast<uint8_t>(h >> 16);
    out[2] = static_cast<uint8_t>(h >> 8);
    out[3] = static_cast<uint8_t>(h);
}

// wrap_smpte302m_pes(samples, ch, 24) (aes3.rs:24-61): 4-B header +
// bit-reversed AES3 data, 7 B per stereo pair; invalid channel counts
// return an empty payload (n:25-27) - the caller still PES-wraps it.
std::vector<uint8_t> WrapSmpte302mPes(const float* samples, size_t count, uint8_t channel_count) {
    if (channel_count != 2 && channel_count != 4 && channel_count != 6 && channel_count != 8) {
        return {};
    }
    constexpr size_t kBlockSize = 7; // 24-bit
    const size_t pairs = count / 2;
    const size_t data_len = pairs * kBlockSize;
    std::vector<uint8_t> out;
    out.reserve(4 + data_len);
    uint8_t hdr[4];
    BuildAes3Header(hdr, static_cast<uint16_t>(data_len), channel_count, 24);
    out.insert(out.end(), hdr, hdr + 4);

    for (size_t p = 0; p < pairs; p++) {
        const float* pair = samples + p * 2;
        const uint32_t s1 = static_cast<uint32_t>(static_cast<int32_t>(ClipF32(pair[0]) * 8388608.0f)) & 0xFFFFFF;
        const uint32_t s2 = static_cast<uint32_t>(static_cast<int32_t>(ClipF32(pair[1]) * 8388608.0f)) & 0xFFFFFF;
        const uint32_t s1_u32 = s1 << 8;
        const uint32_t s2_u32 = s2 << 8;
        out.push_back(ReverseByte(static_cast<uint8_t>(s1_u32 >> 8)));
        out.push_back(ReverseByte(static_cast<uint8_t>(s1_u32 >> 16)));
        out.push_back(ReverseByte(static_cast<uint8_t>(s1_u32 >> 24)));
        const uint8_t s2_top = static_cast<uint8_t>((s2_u32 >> 28) & 0x0F);
        const uint8_t s2_b = static_cast<uint8_t>((s2_u32 >> 20) & 0xFF);
        const uint8_t s2_c = static_cast<uint8_t>((s2_u32 >> 12) & 0xFF);
        const uint8_t s2_bot = static_cast<uint8_t>((s2_u32 >> 8) & 0x0F);
        out.push_back(ReverseByte(s2_bot) >> 4);
        out.push_back(ReverseByte(s2_c));
        out.push_back(ReverseByte(s2_b));
        out.push_back(ReverseByte(s2_top));
    }
    return out;
}

// ---- the muxer state machine (native lib.rs:64-423) -------------------------------

struct TsmState {
    bool video_enabled = true;
    uint16_t video_pid = DEFAULT_VIDEO_PID;
    uint8_t video_cc = 0;
    uint8_t video_stream_type = STREAM_TYPE_H264;
    std::vector<uint8_t> video_descriptor;

    std::vector<AudioStream> audio_streams; // starts with the default Opus/0x101

    uint16_t pmt_pid = PMT_PID;
    uint8_t pat_cc = 0;
    uint8_t pmt_cc = 0;
    uint64_t pcr = 0; // write-only in the oracle (kept for fidelity)
    std::vector<uint8_t> output;
    bool pat_pmt_emitted = false;
    uint64_t last_psi_pts_90k = 0;
    bool sparse_enabled = false;
    double sparse_threshold_ms = 300.0;
    bool pmt_dirty = false;
    uint32_t pmt_resend_count = 0;
    // Increments (5 bits, ISO 13818-1 2.4.4.9) on every PMT content
    // change (sparse PID drop/re-add).
    uint8_t pmt_version = 0;

    TsmState() {
        audio_streams.push_back(AudioStream{
            DEFAULT_AUDIO_PID, 0, AudioKind::Opus, 2, 0.0, false,
        });
    }

    // pcr_pid (n:183-194): video pid when video is enabled, else the
    // first non-suppressed audio pid (fallback the default audio pid).
    uint16_t PcrPid() const {
        if (video_enabled) {
            return video_pid;
        }
        for (const AudioStream& s : audio_streams) {
            if (!(sparse_enabled && s.suppressed)) {
                return s.pid;
            }
        }
        return DEFAULT_AUDIO_PID;
    }

    void WritePat() { // n:358-366
        uint8_t section[] = {
            0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00,
            0, 0, 0, 0, // CRC32 appended below
        };
        Crc32 crc;
        crc.Update(section, 12);
        const uint32_t v = crc.Value();
        section[12] = static_cast<uint8_t>(v >> 24);
        section[13] = static_cast<uint8_t>(v >> 16);
        section[14] = static_cast<uint8_t>(v >> 8);
        section[15] = static_cast<uint8_t>(v);
        PacketizePsi(output, PAT_PID, &pat_cc, section, sizeof(section));
    }

    void WritePmt() { // n:368-422
        const uint16_t pcr_pid = PcrPid();

        struct Entry {
            uint8_t stream_type;
            uint16_t pid;
            const std::vector<uint8_t>* descriptor;
        };
        std::vector<Entry> entries;
        if (video_enabled) {
            entries.push_back({video_stream_type, video_pid, &video_descriptor});
        }
        std::vector<std::vector<uint8_t>> audio_descriptors; // keeps the temporaries alive
        audio_descriptors.reserve(audio_streams.size());     // stable &addresses for entries below
        for (const AudioStream& s : audio_streams) {
            if (sparse_enabled && s.suppressed) {
                continue;
            }
            audio_descriptors.push_back(s.descriptor());
            entries.push_back({s.stream_type(), s.pid, &audio_descriptors.back()});
        }

        size_t entries_esil = 0;
        for (const Entry& e : entries) entries_esil += e.descriptor->size();
        // section_length: program_number(2) + version(1) + section(1) +
        // last_section(1) + PCR_PID(2) + program_info_length(2) +
        // entries + CRC32(4) = 13 + entries + descriptors.
        const uint16_t section_length =
            static_cast<uint16_t>(13 + entries.size() * 5 + entries_esil);

        std::vector<uint8_t> s;
        s.reserve(32 + section_length);
        s.push_back(0x02);
        s.push_back(0xB0 | static_cast<uint8_t>((section_length >> 8) & 0x0F));
        s.push_back(static_cast<uint8_t>(section_length & 0xFF));
        s.push_back(0x00);
        s.push_back(0x01);
        s.push_back(0xC1 | static_cast<uint8_t>(pmt_version << 1));
        s.push_back(0x00);
        s.push_back(0x00);
        s.push_back(static_cast<uint8_t>((pcr_pid >> 8) | 0xE0));
        s.push_back(static_cast<uint8_t>(pcr_pid & 0xFF));
        s.push_back(0xF0);
        s.push_back(0x00);

        for (const Entry& e : entries) {
            s.push_back(e.stream_type);
            s.push_back(static_cast<uint8_t>((e.pid >> 8) | 0xE0));
            s.push_back(static_cast<uint8_t>(e.pid & 0xFF));
            const uint16_t esil = static_cast<uint16_t>(e.descriptor->size());
            s.push_back(0xF0 | static_cast<uint8_t>((esil >> 8) & 0x0F));
            s.push_back(static_cast<uint8_t>(esil & 0xFF));
            s.insert(s.end(), e.descriptor->begin(), e.descriptor->end());
        }

        Crc32 crc;
        crc.Update(s.data(), s.size());
        const uint32_t v = crc.Value();
        s.push_back(static_cast<uint8_t>(v >> 24));
        s.push_back(static_cast<uint8_t>(v >> 16));
        s.push_back(static_cast<uint8_t>(v >> 8));
        s.push_back(static_cast<uint8_t>(v));
        PacketizePsi(output, pmt_pid, &pmt_cc, s.data(), s.size());
    }

    // Shared PCM push path (n:277-356): AES3 wrap, PES on the target
    // stream's PID, per-stream CC + sparse accounting, PSI emission.
    void PushPcmStream(size_t idx, const float* samples, size_t count, double pts_us) {
        const uint64_t pts_90k = UsTo90k(pts_us);
        pcr = pts_90k * 300; // wrapping_mul on u64 (identical mod 2^64)

        const uint16_t pid = audio_streams[idx].pid;
        const uint8_t channel_count = audio_streams[idx].channel_count;

        if (!pat_pmt_emitted) {
            WritePat();
            WritePmt();
            pat_pmt_emitted = true;
            last_psi_pts_90k = pts_90k;
        }

        if (sparse_enabled) {
            const bool silent = IsSilent(samples, count);
            const double frame_ms = static_cast<double>(count / channel_count) / 48.0;
            AudioStream& stream = audio_streams[idx];
            if (silent) {
                stream.silence_ms += frame_ms;
            } else {
                stream.silence_ms = 0.0;
            }

            if (stream.silence_ms > sparse_threshold_ms && !stream.suppressed) {
                stream.suppressed = true;
                pmt_dirty = true;
                pmt_resend_count = PMT_RESEND_COUNT;
                pmt_version = (pmt_version + 1) & 0x1F;
            } else if (!silent && stream.suppressed) {
                stream.suppressed = false;
                pmt_dirty = true;
                pmt_resend_count = PMT_RESEND_COUNT;
                pmt_version = (pmt_version + 1) & 0x1F;
            }
        }

        if (pmt_dirty) {
            WritePat();
            WritePmt();
            pmt_dirty = false;
            last_psi_pts_90k = pts_90k;
        }
        if (pmt_resend_count > 0) {
            WritePat();
            WritePmt();
            pmt_resend_count -= 1;
            last_psi_pts_90k = pts_90k;
        }

        // Periodic PAT/PMT so mid-stream joiners can tune without
        // waiting for a sparse transition. Runs before the suppression
        // early-return to keep PSI flowing during silent gaps.
        const uint64_t since = last_psi_pts_90k > pts_90k ? 0 : pts_90k - last_psi_pts_90k; // saturating_sub
        if (since >= PSI_INTERVAL_TICKS) {
            WritePat();
            WritePmt();
            last_psi_pts_90k = pts_90k;
        }

        const bool suppressed = audio_streams[idx].suppressed;
        if (sparse_enabled && suppressed) {
            return;
        }

        const bool is_pcr = pid == PcrPid();
        std::vector<uint8_t> aes3_payload = WrapSmpte302mPes(samples, count, channel_count);
        std::vector<uint8_t> pes = BuildPesAudio(aes3_payload.data(), aes3_payload.size(), pts_90k);
        Packetize(output, pid, &audio_streams[idx].cc, pes.data(), pes.size(),
                  is_pcr, pts_90k, false);
    }
};

} // namespace

// ---- extern "C" (the tsd_* pattern of ts_demux.h, muxer flavor) -------------------

struct TsmMuxer {
    TsmState st;
    std::vector<uint8_t> drained; // the mem::take target, handed out by tsm_poll
};

extern "C" {

TsmMuxer* tsm_new(void) {
    return new TsmMuxer();
}

void tsm_free(TsmMuxer* m) {
    delete m;
}

void tsm_set_video_codec(TsmMuxer* m, const char* codec) {
    if (m == nullptr || codec == nullptr) return;
    TsmState& st = m->st;
    if (std::strcmp(codec, "av1") == 0) {
        st.video_stream_type = STREAM_TYPE_PRIVATE;
        st.video_descriptor.assign(AV1_DESCRIPTOR, AV1_DESCRIPTOR + sizeof(AV1_DESCRIPTOR));
    } else if (std::strcmp(codec, "hevc") == 0) {
        st.video_stream_type = STREAM_TYPE_HEVC;
        st.video_descriptor.clear();
    } else {
        st.video_stream_type = STREAM_TYPE_H264;
        st.video_descriptor.clear();
    }
}

void tsm_set_video_enabled(TsmMuxer* m, int enabled) {
    if (m == nullptr) return;
    m->st.video_enabled = enabled != 0;
}

void tsm_set_audio_codec(TsmMuxer* m, const char* codec, uint8_t channel_count) {
    if (m == nullptr || codec == nullptr) return;
    // Retargets stream[0] ONLY (n:144-153).
    if (!m->st.audio_streams.empty()) {
        m->st.audio_streams[0].kind = CodecToAudioKind(codec);
        m->st.audio_streams[0].channel_count = channel_count;
    }
}

void tsm_add_audio_pid(TsmMuxer* m, uint16_t pid, const char* codec, uint8_t channel_count) {
    if (m == nullptr || codec == nullptr) return;
    TsmState& st = m->st;
    for (const AudioStream& s : st.audio_streams) {
        if (s.pid == pid) return; // dedup by pid - including the default 0x101
    }
    st.audio_streams.push_back(AudioStream{pid, 0, CodecToAudioKind(codec), channel_count, 0.0, false});
}

void tsm_set_sparse_enabled(TsmMuxer* m, int enabled) {
    if (m == nullptr) return;
    m->st.sparse_enabled = enabled != 0;
}

void tsm_set_sparse_threshold(TsmMuxer* m, double ms) {
    if (m == nullptr) return;
    m->st.sparse_threshold_ms = ms;
}

void tsm_push_video(TsmMuxer* m, const uint8_t* data, int len, double pts_us, double dts_us, int is_keyframe) {
    if (m == nullptr) return;
    TsmState& st = m->st;
    if (!st.video_enabled) {
        return;
    }
    const uint8_t* bytes = data != nullptr ? data : kNoBytes;
    const size_t n = len > 0 ? static_cast<size_t>(len) : 0;
    const uint64_t pts_90k = UsTo90k(pts_us);
    const uint64_t dts_90k = UsTo90k(dts_us);
    st.pcr = pts_90k * 300; // wrapping_mul

    if (is_keyframe != 0) {
        st.WritePat();
        st.WritePmt();
        st.pat_pmt_emitted = true;
        st.last_psi_pts_90k = pts_90k;
    }

    std::vector<uint8_t> pes = BuildPesVideo(bytes, n, pts_90k, dts_90k);
    Packetize(st.output, st.video_pid, &st.video_cc, pes.data(), pes.size(),
              true, pts_90k, is_keyframe != 0);
}

void tsm_push_audio(TsmMuxer* m, const uint8_t* data, int len, double pts_us) {
    if (m == nullptr) return;
    TsmState& st = m->st;
    const uint8_t* bytes = data != nullptr ? data : kNoBytes;
    const size_t n = len > 0 ? static_cast<size_t>(len) : 0;
    const uint64_t pts_90k = UsTo90k(pts_us);
    // First Opus-kind stream; unwrap_or(0) quirk: no Opus stream =>
    // stream[0]'s pid regardless of kind (n:222-245).
    size_t idx = 0;
    for (size_t i = 0; i < st.audio_streams.size(); i++) {
        if (st.audio_streams[i].kind == AudioKind::Opus) {
            idx = i;
            break;
        }
    }
    const uint16_t pid = st.audio_streams[idx].pid;
    const bool is_pcr = pid == st.PcrPid();
    uint8_t payload[2] = {0x7F, 0xE0}; // AU header prefix
    std::vector<uint8_t> buf;
    buf.reserve(2 + n);
    buf.insert(buf.end(), payload, payload + 2);
    buf.insert(buf.end(), bytes, bytes + n);
    std::vector<uint8_t> pes = BuildPesAudio(buf.data(), buf.size(), pts_90k);
    Packetize(st.output, pid, &st.audio_streams[idx].cc, pes.data(), pes.size(),
              is_pcr, pts_90k, false);
}

void tsm_push_pcm(TsmMuxer* m, const float* samples, int count, double pts_us) {
    if (m == nullptr) return;
    TsmState& st = m->st;
    // First s302m-kind stream; unwrap_or(0) quirk (n:247-254).
    size_t idx = 0;
    for (size_t i = 0; i < st.audio_streams.size(); i++) {
        if (st.audio_streams[i].kind == AudioKind::Smpte302m) {
            idx = i;
            break;
        }
    }
    st.PushPcmStream(idx, samples, count > 0 ? static_cast<size_t>(count) : 0, pts_us);
}

void tsm_push_pcm_pid(TsmMuxer* m, uint16_t pid, const float* samples, int count, double pts_us) {
    if (m == nullptr) return;
    TsmState& st = m->st;
    for (size_t i = 0; i < st.audio_streams.size(); i++) {
        if (st.audio_streams[i].pid == pid) {
            if (st.audio_streams[i].kind == AudioKind::Smpte302m) {
                st.PushPcmStream(i, samples, count > 0 ? static_cast<size_t>(count) : 0, pts_us);
            }
            return; // unknown pid OR non-s302m pid: no-op (n:259-267)
        }
    }
}

int tsm_poll(TsmMuxer* m, const uint8_t** out) {
    if (m == nullptr || out == nullptr) return 0;
    // mem::take: the drained buffer is released (its capacity returns to
    // the output side) and handed out; valid until the next tsm_poll.
    m->drained.clear();
    m->drained.swap(m->st.output);
    *out = m->drained.empty() ? nullptr : m->drained.data();
    return static_cast<int>(m->drained.size());
}

} // extern "C"
