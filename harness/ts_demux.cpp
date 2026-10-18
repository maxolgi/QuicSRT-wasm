// The M5 demux port: an MPEG-2 TS demuxer behind the tsd_* C ABI of
// ts_demux.h. Every quirk below is deliberate and pinned by the
// js/demux_parity.mjs golden-baseline gate:
//
//   - Byte-exact parse cursor. Reads go through nested
//     io::Take-style bounds over one shared cursor, so a parse error
//     leaves the cursor mid-packet wherever the reads died (a
//     misaligned feed therefore errors PER BYTE on the sync check).
//     Takes are modeled as absolute region ends on one cursor, which
//     reproduces the consumption exactly.
//   - Error text. Canonical form is "ts parse: {Kind}: {reason}" - the
//     machine-specific location suffix is omitted, and the parity
//     harness canonicalizes it away on the baseline side, so texts
//     match.
//   - Pid-kind dispatch: PAT registers PMT pids, PMT
//     registers ES pids as PES, everything unknown is Raw (never an
//     error); a PMT whose section spans packets fails the in-packet
//     cursor parse and falls back to Raw, where it is reassembled
//     (assemble_psi).
//
// NAL scanning lives in harness/nal.{h,cpp}; finalize_pes
// scans start codes once per reassembled PES on video PIDs (stream_type
// 0x1B/0x24) and feeds the event's nal tables, the per-PID nalStats and
// the ring's per-row NAL summaries. SMPTE
// 302M lives in harness/aes3.{h,cpp}; finalize_pes decodes
// BSSD PIDs' PES payloads to f32 and emits a kind-5 pcm event right
// after the pes event. The audio metering
// DSP lives in harness/meter.{h,cpp}: finalize_pes drives
// meter_state.Update with the decoded samples/channel count/pts, and
// tsd_meter_snapshot runs the full MUTATING
// MeterState::Snapshot (window latch/reset + phase ring push).

#include "ts_demux.h"

#include "aes3.h"
#include "meter.h"
#include "nal.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

// ---- constants (lib.rs:29-56) -------------------------------------------------

constexpr size_t TS_PACKET_SIZE = 188;
constexpr size_t PACKET_RING_CAP = 500;
constexpr size_t RECENT_ERRORS_CAP = 20;
constexpr size_t BYTES_WINDOW_BUCKETS = 100; // 100 x ~100ms = 10s rolling window
constexpr double BYTES_WINDOW_BUCKET_MS = 100.0;
constexpr uint64_t PTS_JUMP_90K = 90000; // >1s delta in 90kHz units flags a jump

// PacketEntry.kind values mirrored into the snapshot ring (lib.rs:37-43).
constexpr uint8_t KIND_PAT = 0;
constexpr uint8_t KIND_PMT = 1;
constexpr uint8_t KIND_PES = 2;
constexpr uint8_t KIND_RA = 3;
constexpr uint8_t KIND_ERROR = 4;
constexpr uint8_t KIND_OTHER = 255;

constexpr size_t HEX_CAP_BYTES = 512; // ring hex cap (lib.rs:47)

std::string HexPrefix(const uint8_t* p, size_t n) {
    n = std::min(n, HEX_CAP_BYTES);
    static const char* kDigits = "0123456789abcdef";
    std::string s;
    s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) {
        s.push_back(kDigits[p[i] >> 4]);
        s.push_back(kDigits[p[i] & 0xF]);
    }
    return s;
}

std::string Dec(uint64_t n) { return std::to_string(n); }

// lib.rs finalize_pes saturating_add on the u32 NAL counters (719-727).
uint32_t SatAddU32(uint32_t a, uint32_t b) {
    return b > UINT32_MAX - a ? UINT32_MAX : a + b;
}
std::string Hex2(uint8_t b) {
    static const char* d = "0123456789abcdef";
    return {d[b >> 4], d[b & 0xF]};
}
std::string Hex6(uint64_t v) {
    static const char* d = "0123456789abcdef";
    std::string s(6, '0');
    for (int i = 5; i >= 0; i--) {
        s[i] = d[v & 0xF];
        v >>= 4;
    }
    return s;
}

// ---- errors (fork error.rs Display: "{Kind}: {reason} (at ...)") ----------------
//
// Propagated as exceptions (the engine module builds with -fexceptions),
// mirroring Rust's `?` - caught at exactly the two places the fork turns
// them into values: read_ts_packet's caller (one error event per failed
// read, lib.rs:515-520) and the PMT cursor fallback (swallowed into Raw,
// reader.rs:108-110).

struct TsError : std::runtime_error {
    const char* kind; // "InvalidInput" | "Unsupported" | "Other"
    explicit TsError(const char* k, std::string reason)
        : std::runtime_error(std::move(reason)), kind(k) {}
};

[[noreturn]] void InvalidInput(std::string reason) {
    throw TsError("InvalidInput", std::move(reason));
}
[[noreturn]] void Unsupported(std::string reason) {
    throw TsError("Unsupported", std::move(reason));
}
// io::Error conversions surface as kind Other with std's read_exact
// message; reads can only starve at a region boundary here.
[[noreturn]] void IoEof() {
    throw TsError("Other", "failed to fill whole buffer");
}

// ---- cursor: io::Read/Take semantics over one buffer ---------------------------
//
// Src is the shared cursor (the FeedBuf); Rd is a bounded view ("take").
// A take's end is an absolute offset, so nested takes compose exactly like
// the fork's Take<&mut Take<...>> chain: reads advance the shared cursor,
// and a read starving its region end is an EOF (read returning Ok(0)).

struct Src {
    const uint8_t* base = nullptr;
    size_t end = 0;  // absolute end of available data
    size_t pos = 0;  // absolute cursor
};

// ---- CRC-32/MPEG-2 (fork crc.rs - table verbatim; the fork's trailing
// spare entry is a sentinel that is never indexed) --------------------------------

class Crc32 {
public:
    Crc32() : v_(0xFFFFFFFFu) {}
    void Update(const uint8_t* p, size_t n) {
        for (size_t i = 0; i < n; i++) {
            v_ = kTable[static_cast<uint8_t>(v_) ^ p[i]] ^ (v_ >> 8);
        }
    }
    uint32_t Value() const { // swap_bytes
        return ((v_ & 0x000000FFu) << 24) | ((v_ & 0x0000FF00u) << 8) |
               ((v_ & 0x00FF0000u) >> 8) | (v_ >> 24);
    }

private:
    uint32_t v_;
    static const uint32_t kTable[256];
};

struct Rd {
    Src* src;
    size_t end; // absolute region end (nested takes narrow it)
    Crc32* crc = nullptr;

    size_t Avail() const {
        const size_t cap = std::min(end, src->end);
        return cap <= src->pos ? 0 : cap - src->pos;
    }
    size_t Limit() const { return Avail(); } // bytes left in the region

    size_t Read(uint8_t* out, size_t want) {
        const size_t n = std::min(want, Avail());
        if (n != 0) {
            std::memcpy(out, src->base + src->pos, n);
            src->pos += n;
            if (crc != nullptr) crc->Update(out, n);
        }
        return n;
    }

    Rd Take(size_t n) const {
        Rd r = *this;
        r.end = std::min(end, src->pos + n);
        return r;
    }

    std::vector<uint8_t> ReadToEnd() {
        std::vector<uint8_t> out(Avail());
        if (!out.empty()) {
            std::memcpy(out.data(), src->base + src->pos, out.size());
            if (crc != nullptr) crc->Update(out.data(), out.size());
            src->pos += out.size();
        }
        return out;
    }

    void ReadExact(uint8_t* out, size_t n) {
        size_t got = 0;
        while (got < n) {
            const size_t r = Read(out + got, n - got);
            if (r == 0) IoEof();
            got += r;
        }
    }

    uint8_t U8() {
        uint8_t b;
        ReadExact(&b, 1);
        return b;
    }
    uint16_t U16() {
        uint8_t b[2];
        ReadExact(b, 2);
        return static_cast<uint16_t>((b[0] << 8) | b[1]);
    }
    uint32_t U32() {
        uint8_t b[4];
        ReadExact(b, 4);
        return (static_cast<uint32_t>(b[0]) << 24) | (static_cast<uint32_t>(b[1]) << 16) |
               (static_cast<uint32_t>(b[2]) << 8) | b[3];
    }
    uint64_t UIntN(int bytes) { // big-endian low bytes of u64 (read_uint::<N>)
        uint64_t v = 0;
        for (int i = 0; i < bytes; i++) v = (v << 8) | U8();
        return v;
    }
};

// fork util.rs consume_stuffing_bytes: read the region dry; non-0xFF errors.
void ConsumeStuffing(Rd r) {
    uint8_t b;
    while (r.Read(&b, 1) == 1) {
        if (b != 0xFF) InvalidInput("Expected stuffing byte 0xFF");
    }
}

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

// ---- fork value types ----------------------------------------------------------

struct PesHeader {
    uint8_t stream_id = 0;
    bool priority = false;
    bool data_alignment = false;
    bool copyright = false;
    bool original_or_copy = false;
    std::optional<uint64_t> pts;
    std::optional<uint64_t> dts;
    std::optional<uint64_t> escr;

    // fork pes/packet.rs optional_header_len
    size_t OptionalHeaderLen() const {
        return 3 + (pts ? 5 : 0) + (dts ? 5 : 0) + (escr ? 6 : 0);
    }
    // fork PesHeader::es_payload_len. Err means malformed, and lib.rs:922-925
    // treats Err as unbounded exactly like Ok(None) - the caller catches.
    std::optional<size_t> EsPayloadLen(uint16_t pes_packet_len) const {
        if (pes_packet_len == 0) return std::nullopt;
        const size_t ohl = OptionalHeaderLen();
        if (pes_packet_len < ohl) {
            InvalidInput("pes.pes_packet_len=" + Dec(pes_packet_len) +
                         ", optional_header_len=" + Dec(ohl));
        }
        return static_cast<size_t>(pes_packet_len) - ohl;
    }
};

struct AdaptationField {
    bool discontinuity = false;
    bool random_access = false;
    std::optional<uint64_t> pcr;
};

struct PatEntry {
    uint16_t program_num;
    uint16_t pmt_pid;
};

struct Descriptor {
    uint8_t tag;
    std::vector<uint8_t> data;
};

struct PmtEs {
    uint8_t stream_type;
    uint16_t pid;
    std::vector<Descriptor> descriptors;
};

struct Pmt {
    std::vector<PmtEs> es_info;
};

// ---- fork time.rs ----------------------------------------------------------------

// Timestamp::read_from: 5 bytes, check_bits prefix, three marker bits.
uint64_t ReadTimestamp(Rd r, uint8_t check_bits) {
    const uint64_t n = r.UIntN(5);
    if (static_cast<uint8_t>(n >> 36) != check_bits) {
        InvalidInput("Expected check_bits: " + Dec(check_bits) +
                     ", got: " + Dec(static_cast<uint8_t>(n >> 36)));
    }
    if ((n & 1) == 0) InvalidInput("Unexpected marker bit");
    if (((n >> 16) & 1) == 0) InvalidInput("Unexpected marker bit");
    if (((n >> 32) & 1) == 0) InvalidInput("Unexpected marker bit");
    const uint64_t n0 = (n >> 33) & 0x7;
    const uint64_t n1 = (n >> 17) & 0x7FFF;
    const uint64_t n2 = (n >> 1) & 0x7FFF;
    return (n0 << 30) | (n1 << 15) | n2;
}

// ClockReference::read_pcr_from: 6 bytes, 33-bit base + 9-bit extension.
uint64_t ReadPcr(Rd r) {
    const uint64_t n = r.UIntN(6);
    return (n >> 15) * 300 + (n & 0x1FF);
}

// ClockReference::read_escr_from.
uint64_t ReadEscr(Rd r) {
    uint64_t n = r.UIntN(6);
    if (n >> 46 != 0) InvalidInput("Expected zero in reserved bits");
    if ((n & 1) != 1) InvalidInput("Unexpected marker bit");
    const uint64_t extension = (n >> 1) & 0x1FF;
    n >>= 10;
    if ((n & 1) != 1) InvalidInput("Unexpected marker bit");
    if (((n >> 16) & 1) != 1) InvalidInput("Unexpected marker bit");
    if (((n >> 32) & 1) != 1) InvalidInput("Unexpected marker bit");
    const uint64_t n0 = (n >> 1) & 0x7FFF;
    const uint64_t n1 = (n >> 17) & 0x7FFF;
    const uint64_t n2 = (n >> 33) & 0x7;
    return (n0 | (n1 << 15) | (n2 << 30)) * 300 + extension;
}

// ---- fork adaptation_field.rs -----------------------------------------------------

std::optional<AdaptationField> ReadAdaptationField(Rd r) {
    const uint8_t af_len = r.U8();
    if (af_len == 0) return std::nullopt; // consumed the length byte only
    Rd inner = r.Take(af_len);

    AdaptationField af;
    const uint8_t b = inner.U8();
    af.discontinuity = (b & 0x80) != 0;
    af.random_access = (b & 0x40) != 0;
    const bool pcr_flag = (b & 0x10) != 0;
    const bool opcr_flag = (b & 0x08) != 0;
    const bool splicing_flag = (b & 0x04) != 0;
    const bool private_flag = (b & 0x02) != 0;
    const bool extension_flag = (b & 0x01) != 0;

    if (pcr_flag) af.pcr = ReadPcr(inner);
    if (opcr_flag) ReadPcr(inner); // opcr parsed (error parity), value unused
    if (splicing_flag) inner.U8(); // splice_countdown
    if (private_flag) {
        const uint8_t len = inner.U8();
        std::vector<uint8_t> buf(len);
        inner.ReadExact(buf.data(), len);
    }
    if (extension_flag) {
        // AdaptationExtensionField::read_from
        const uint8_t ext_len = inner.U8();
        Rd ext = inner.Take(ext_len);
        const uint8_t eb = ext.U8();
        if (eb & 0x80) ext.U16();    // legal_time_window
        if (eb & 0x40) ext.UIntN(3); // piecewise_rate
        if (eb & 0x20) ext.UIntN(5); // seamless_splice
        if (ext.Limit() != 0) InvalidInput("Unexpected data in adaptation extension field");
    }
    ConsumeStuffing(inner);
    return af;
}

// ---- fork psi.rs / pat.rs / pmt.rs --------------------------------------------------

struct PsiTable {
    uint8_t table_id;
    bool private_bit;
    bool has_syntax = false;
    uint16_t ext = 0;
    uint8_t version = 0;
    bool current_next = false;
    uint8_t section_number = 0;
    uint8_t last_section_number = 0;
    std::vector<uint8_t> table_data;
};

PsiTable ReadPsiTable(Rd r, uint8_t peek) {
    Crc32 crc; // WithCrc32 over peek.chain(reader): the peek feeds the CRC
    crc.Update(&peek, 1);
    Rd cr = r;
    cr.crc = &crc;

    PsiTable t;
    t.table_id = peek;
    const uint16_t n = cr.U16();
    const bool indicator = (n & 0x8000) != 0;
    t.private_bit = (n & 0x4000) != 0;
    if ((n & 0x3000) != 0x3000) InvalidInput("Unexpected reserved bits");
    if ((n & 0x0C00) != 0) InvalidInput("Unexpected section length unused bits");
    const uint16_t sec_len = n & 0x03FF;
    if (sec_len > 1021) InvalidInput("Syntax section length exceeds maximum");
    if (indicator && sec_len == 0) {
        InvalidInput("Syntax section length cannot be 0 when indicator is set");
    }
    if (sec_len > 0) {
        if (sec_len < 4) InvalidInput("Syntax section length must be at least 4");
        Rd sr = cr.Take(sec_len - 4);
        t.has_syntax = true;
        t.ext = sr.U16();
        const uint8_t b = sr.U8();
        if ((b & 0xC0) != 0xC0) InvalidInput("Unexpected reserved bits");
        t.version = (b & 0x3E) >> 1; // 5 bits, VersionNumber::from_u8 cannot fail
        t.current_next = (b & 0x01) != 0;
        t.section_number = sr.U8();
        t.last_section_number = sr.U8();
        t.table_data = sr.ReadToEnd();
        const uint32_t computed = crc.Value();
        const uint32_t expected = cr.U32();
        if (computed != expected) InvalidInput("CRC32 mismatch");
    }
    return t;
}

std::vector<PsiTable> ReadPsi(Rd r) {
    const uint8_t pointer = r.U8();
    if (pointer != 0) Unsupported("Pointer field must be 0");
    std::vector<PsiTable> tables;
    for (;;) {
        uint8_t peek;
        if (r.Read(&peek, 1) == 0) break;
        if (!tables.empty() && peek == 0xFF) {
            ConsumeStuffing(r);
            break;
        }
        tables.push_back(ReadPsiTable(r, peek));
    }
    return tables;
}

// Pid::read_from (fork types.rs): top 3 bits must be 0b111.
uint16_t ReadPidWithReserved(Rd r) {
    const uint16_t n = r.U16();
    if ((n & 0xE000) != 0xE000) InvalidInput("Unexpected reserved bits");
    return n & 0x1FFF;
}

void CheckSingleTable(const std::vector<PsiTable>& tables, uint8_t table_id) {
    if (tables.size() != 1) InvalidInput("Expected exactly one PSI table");
    const PsiTable& t = tables[0];
    if (t.table_id != table_id) {
        InvalidInput("Expected table_id " + Dec(table_id) + ", got " + Dec(t.table_id));
    }
    if (t.private_bit) InvalidInput("Unexpected private_bit");
    if (!t.has_syntax) InvalidInput("Expected table syntax");
    if (t.section_number != 0) InvalidInput("Expected section_number 0");
    if (t.last_section_number != 0) InvalidInput("Expected last_section_number 0");
    if (!t.current_next) InvalidInput("Expected current_next_indicator to be true");
}

Src CursorOver(const std::vector<uint8_t>& v) {
    return Src{v.data(), v.size(), 0};
}

std::vector<PatEntry> ReadPat(Rd r) {
    const std::vector<PsiTable> tables = ReadPsi(r);
    CheckSingleTable(tables, 0);
    Src src = CursorOver(tables[0].table_data);
    Rd td{&src, src.end};
    std::vector<PatEntry> table;
    while (td.Limit() > 0) {
        PatEntry pa;
        pa.program_num = td.U16();
        pa.pmt_pid = ReadPidWithReserved(td);
        table.push_back(pa);
    }
    return table;
}

bool KnownStreamType(uint8_t n) {
    switch (n) {
        case 0x01: case 0x02: case 0x03: case 0x04: case 0x05: case 0x06:
        case 0x07: case 0x08: case 0x09: case 0x0A: case 0x0B: case 0x0C:
        case 0x0D: case 0x0E: case 0x0F: case 0x10: case 0x11: case 0x12:
        case 0x13: case 0x14: case 0x15: case 0x16: case 0x17: case 0x18:
        case 0x19: case 0x1A: case 0x1B: case 0x24: case 0x42: case 0x80:
        case 0x81: case 0x82: case 0x83: case 0x84: case 0x85: case 0x86:
        case 0x87: case 0x90: case 0x91: case 0xC0: case 0xC1: case 0xC2:
        case 0xCF: case 0xD1: case 0xDB: case 0xEA:
            return true;
        default:
            return false;
    }
}

Descriptor ReadDescriptor(Rd r) {
    Descriptor d;
    d.tag = r.U8();
    const uint8_t len = r.U8();
    d.data.resize(len);
    r.ReadExact(d.data.data(), len);
    return d;
}

Pmt ReadPmt(Rd r) {
    const std::vector<PsiTable> tables = ReadPsi(r);
    CheckSingleTable(tables, 2);
    Src src = CursorOver(tables[0].table_data);
    Rd td{&src, src.end};

    ReadPidWithReserved(td); // pcr_pid (0x1FFF = none; unused by the demuxer)

    const uint16_t n = td.U16();
    if ((n & 0xF000) != 0xF000) InvalidInput("Unexpected reserved bits");
    if ((n & 0x0C00) != 0) InvalidInput("Unexpected program info length unused bits");
    const uint16_t program_info_len = n & 0x03FF;
    // Rust's slice split_at panics when program_info_len exceeds the data
    // (malformed section); the corpus never hits it - clamp instead of
    // crashing the module.
    Rd pi = td.Take(std::min<size_t>(program_info_len, td.Limit()));
    while (pi.Limit() > 0) ReadDescriptor(pi); // program descriptors, unused

    Pmt pmt;
    while (td.Limit() > 0) {
        PmtEs es;
        es.stream_type = td.U8();
        if (!KnownStreamType(es.stream_type)) {
            InvalidInput("Unknown stream type: " + Dec(es.stream_type));
        }
        es.pid = ReadPidWithReserved(td);
        const uint16_t en = td.U16();
        if ((en & 0xF000) != 0xF000) InvalidInput("Unexpected reserved bits");
        if ((en & 0x0C00) != 0) InvalidInput("Unexpected ES info length unused bits");
        Rd dr = td.Take(en & 0x03FF);
        while (dr.Limit() > 0) es.descriptors.push_back(ReadDescriptor(dr));
        if (dr.Limit() != 0) InvalidInput("Unexpected remaining data");
        pmt.es_info.push_back(std::move(es));
    }
    return pmt;
}

// ---- fork pes/packet.rs --------------------------------------------------------

// Stream ids whose PES headers carry no optional part (pes/packet.rs:92-99).
bool HeaderlessStreamId(uint8_t id) {
    switch (id) {
        case 0xBC: case 0xBE: case 0xBF: case 0xF0: case 0xF1: case 0xF2:
        case 0xF8: case 0xFF:
            return true;
        default:
            return false;
    }
}

PesHeader ReadPesHeader(Rd r, uint16_t* pes_packet_len) {
    const uint64_t prefix = r.UIntN(3);
    if (prefix != 0x000001) {
        InvalidInput("Expected packet start code prefix 0x000001, got 0x" + Hex6(prefix));
    }
    PesHeader h;
    h.stream_id = r.U8();
    *pes_packet_len = r.U16();
    if (HeaderlessStreamId(h.stream_id)) return h;

    const uint8_t b = r.U8();
    if ((b & 0xC0) != 0x80) InvalidInput("Unexpected marker bits");
    const uint8_t scrambling = (b & 0x30) >> 4;
    h.priority = (b & 0x08) != 0;
    h.data_alignment = (b & 0x04) != 0;
    h.copyright = (b & 0x02) != 0;
    h.original_or_copy = (b & 0x01) != 0;
    if (scrambling != 0) Unsupported("Scrambling control is not supported");

    const uint8_t f = r.U8();
    const bool pts_flag = (f & 0x80) != 0;
    const bool dts_flag = (f & 0x40) != 0;
    if (!pts_flag && dts_flag) InvalidInput("DTS cannot be present without PTS");
    const bool escr_flag = (f & 0x20) != 0;
    if (f & 0x10) Unsupported("ES rate flag is not supported");
    if (f & 0x08) Unsupported("DSM trick mode flag is not supported");
    if (f & 0x04) Unsupported("Additional copy info flag is not supported");
    if (f & 0x02) Unsupported("CRC flag is not supported");
    if (f & 0x01) Unsupported("Extension flag is not supported");

    const uint8_t pes_header_len = r.U8();
    Rd inner = r.Take(pes_header_len);
    if (pts_flag) h.pts = ReadTimestamp(inner, dts_flag ? 3 : 2);
    if (dts_flag) h.dts = ReadTimestamp(inner, 1);
    if (escr_flag) h.escr = ReadEscr(inner);
    ConsumeStuffing(inner);
    return h;
}

// ---- lib.rs support bits -----------------------------------------------------------

// extract_format_id (lib.rs:527-540): first registration descriptor with a
// UTF-8-clean first 4 bytes; invalid UTF-8 continues the search (find_map).
bool IsValidUtf8(const uint8_t* p, size_t n) {
    size_t i = 0;
    while (i < n) {
        const uint8_t b = p[i];
        if (b < 0x80) {
            i += 1;
        } else if (b >= 0xC2 && b <= 0xDF) {
            if (i + 1 >= n || (p[i + 1] & 0xC0) != 0x80) return false;
            i += 2;
        } else if (b == 0xE0) {
            if (i + 2 >= n || p[i + 1] < 0xA0 || p[i + 1] > 0xBF || (p[i + 2] & 0xC0) != 0x80) {
                return false;
            }
            i += 3;
        } else if ((b >= 0xE1 && b <= 0xEC) || b == 0xEE || b == 0xEF) {
            if (i + 2 >= n || (p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80) return false;
            i += 3;
        } else if (b == 0xED) {
            if (i + 2 >= n || p[i + 1] < 0x80 || p[i + 1] > 0x9F || (p[i + 2] & 0xC0) != 0x80) {
                return false;
            }
            i += 3;
        } else if (b == 0xF0) {
            if (i + 3 >= n || p[i + 1] < 0x90 || p[i + 1] > 0xBF || (p[i + 2] & 0xC0) != 0x80 ||
                (p[i + 3] & 0xC0) != 0x80) {
                return false;
            }
            i += 4;
        } else if (b >= 0xF1 && b <= 0xF3) {
            if (i + 3 >= n || (p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80 ||
                (p[i + 3] & 0xC0) != 0x80) {
                return false;
            }
            i += 4;
        } else if (b == 0xF4) {
            if (i + 3 >= n || p[i + 1] < 0x80 || p[i + 1] > 0x8F || (p[i + 2] & 0xC0) != 0x80 ||
                (p[i + 3] & 0xC0) != 0x80) {
                return false;
            }
            i += 4;
        } else {
            return false; // C0, C1 (overlong), F5-FF
        }
    }
    return true;
}

std::string ExtractFormatId(const std::vector<Descriptor>& descriptors) {
    for (const Descriptor& d : descriptors) {
        if (d.tag == aes3::REGISTRATION_DESC_TAG && d.data.size() >= 4 &&
            IsValidUtf8(d.data.data(), 4)) {
            return std::string(reinterpret_cast<const char*>(d.data.data()), 4);
        }
    }
    return "";
}

} // namespace

// ---- TsEvent (lib.rs:198-423) — the ABI's opaque event type ----------------------

struct TsEvent {
    uint8_t kind = 0;
    uint16_t pid = 0;
    int64_t pts = -1;
    int64_t dts = -1;
    uint8_t stream_type = 0;
    std::vector<uint8_t> data;
    std::string text;
    uint16_t program_num = 0;
    bool random_access = false;
    std::vector<std::string> pmt_format_ids;
    std::vector<uint32_t> nal_offsets; // flat [off, len, ...] relative to data (video pids)
    std::vector<uint8_t> nal_types;    // NAL type per NALU (video pids only)
    std::vector<float> samples;        // decoded PCM (kind-5 pcm events only)

    static TsEvent Pat(uint16_t program_num, uint16_t pmt_pid) {
        TsEvent e;
        e.kind = 0;
        e.pid = pmt_pid; // kind-0 pid is the PMT pid (lib.rs:310)
        e.program_num = program_num;
        return e;
    }
    static TsEvent Pmt(const std::vector<std::pair<uint16_t, uint8_t>>& entries,
                       const std::vector<std::string>& format_ids) {
        TsEvent e;
        e.kind = 1; // pid stays 0 (lib.rs:335)
        e.pmt_format_ids = format_ids;
        e.data.reserve(entries.size() * 4); // LE u16 [pid, st] pairs
        for (const auto& [pid, st] : entries) {
            e.data.push_back(pid & 0xFF);
            e.data.push_back(pid >> 8);
            e.data.push_back(st);
            e.data.push_back(0);
        }
        return e;
    }
    static TsEvent Pes(uint16_t pid, const PesHeader& h, std::vector<uint8_t> payload, bool ra,
                       std::vector<uint32_t> nal_offsets, std::vector<uint8_t> nal_types) {
        TsEvent e;
        e.kind = 2;
        e.pid = pid;
        e.pts = h.pts ? static_cast<int64_t>(*h.pts) : -1;
        e.dts = h.dts ? static_cast<int64_t>(*h.dts) : -1;
        e.data = std::move(payload);
        e.random_access = ra;
        e.nal_offsets = std::move(nal_offsets);
        e.nal_types = std::move(nal_types);
        return e;
    }
    static TsEvent RandomAccess(uint16_t pid) {
        TsEvent e;
        e.kind = 3;
        e.pid = pid;
        e.random_access = true;
        return e;
    }
    static TsEvent Error(std::string text) {
        TsEvent e;
        e.kind = 4;
        e.text = std::move(text);
        return e;
    }
    // lib.rs:406-422: program_num carries the channel count (overloaded),
    // stream_type the constant 0x06, dts -1, everything else empty/false.
    static TsEvent Pcm(uint16_t pid, int64_t pts, uint8_t channel_count,
                       std::vector<float> samples) {
        TsEvent e;
        e.kind = 5;
        e.pid = pid;
        e.pts = pts;
        e.dts = -1;
        e.stream_type = aes3::S302M_STREAM_TYPE;
        e.program_num = channel_count;
        e.samples = std::move(samples);
        return e;
    }
};

// ---- lib.rs: demuxer state ---------------------------------------------------------

struct PmtEntry {
    uint16_t pid;
    uint8_t stream_type;
    std::string format_id;
};

struct PidStats {
    uint64_t pes_count = 0;
    uint64_t bytes_total = 0;
    std::deque<uint64_t> bytes_window;
    uint64_t bytes_window_current = 0;
    std::optional<std::chrono::steady_clock::time_point> bytes_window_start;
    uint64_t ra_count = 0;
    int64_t last_pts = -1;
    int64_t last_dts = -1;
    int64_t max_pts_delta = 0;
    uint32_t pts_jumps = 0;
    uint32_t cc_errors = 0;
    uint32_t tei_count = 0;
    uint32_t pusi_count = 0;
    uint32_t scrambling_counts[4] = {0, 0, 0, 0};
    uint32_t af_control_counts[4] = {0, 0, 0, 0};
};

struct PcrStats {
    uint64_t last_27mhz = 0; // 0 = no PCR seen yet (a literal PCR of 0 too)
    double interval_ms = 0.0;
    double jitter_ms_ema = 0.0;
};

struct PacketEntry {
    double t_ms = 0.0;
    uint16_t pid = 0;
    uint8_t kind = KIND_OTHER;
    int64_t pts = -1;
    int64_t dts = -1;
    uint32_t size = 0;
    bool ra = false;
    std::vector<uint8_t> nal_summary; // pes rows: that PES's nalTypes; else empty
    bool tei = false;
    bool pusi = false;
    std::string hex;
};

struct PartialPes {
    std::optional<PesHeader> header;
    std::optional<size_t> declared_len;
    std::vector<uint8_t> buf;
    bool ra = false;
};

struct PartialPsi {
    std::vector<uint8_t> buf; // [0x00 fake pointer] + section bytes
    size_t section_total = 0;
};

// ---- fork reader.rs: pid-kind dispatch --------------------------------------------

enum PidKind : uint8_t { kPidPmt = 0, kPidPes = 1 };

struct TsPacket {
    // TsHeader
    bool tei = false;
    bool pusi = false; // header bit (drives PesStart vs PesContinuation)
    uint16_t pid = 0;
    uint8_t scrambling = 0; // discriminants 0/2/3 (0b01 is rejected)
    uint8_t afc = 0;
    uint8_t cc = 0;
    // adaptation field (present only when afc says so AND af_len > 0)
    bool has_af = false;
    AdaptationField af;
    // payload variant
    enum Payload : uint8_t { kNone, kPat, kPmt, kPesStart, kPesCont, kRaw, kNull } payload = kNone;
    std::vector<PatEntry> pat;
    Pmt pmt;
    PesHeader pes_header;
    uint16_t pes_packet_len = 0;
    std::vector<uint8_t> pes_data; // PesStart payload bytes
    std::vector<uint8_t> bytes;    // PesContinuation / Raw payload bytes
};

// Returns false on "no full packet left" (Ok(None)); throws TsError on a
// parse failure with the cursor left wherever the reads died. `kinds` is
// the reader's persistent pid map.
bool ReadTsPacket(Src& src, std::unordered_map<uint16_t, uint8_t>& kinds, TsPacket* out) {
    const size_t start = src.pos;
    Rd r{&src, std::min(src.end, start + TS_PACKET_SIZE)};
    uint8_t peek;
    if (r.Read(&peek, 1) == 0) return false;

    // TsHeader::read_from(peek.chain(reader))
    if (peek != 0x47) {
        InvalidInput("Expected sync byte 0x47, got 0x" + Hex2(peek));
    }
    const uint16_t n = r.U16();
    out->tei = (n & 0x8000) != 0;
    out->pusi = (n & 0x4000) != 0;
    out->pid = n & 0x1FFF; // Pid::new(masked) cannot fail
    const uint8_t b = r.U8();
    out->scrambling = b >> 6;
    if (out->scrambling == 0x1) InvalidInput("Reserved for future use"); // TSC 0b01
    out->afc = (b >> 4) & 0x3;
    if (out->afc == 0x0) InvalidInput("Reserved for future use"); // AFC 0b00
    out->cc = b & 0x0F;

    if (out->afc != 0x1) { // has_adaptation_field (not PayloadOnly)
        const auto af = ReadAdaptationField(r);
        if (af) {
            out->has_af = true;
            out->af = *af;
        }
    }
    if (out->afc != 0x2) { // has_payload (not AdaptationFieldOnly)
        const uint16_t pid = out->pid;
        if (pid == 0x0000) { // PAT
            out->pat = ReadPat(r);
            for (const PatEntry& pa : out->pat) kinds[pa.pmt_pid] = kPidPmt;
            out->payload = TsPacket::kPat;
        } else if (pid == 0x1FFF) { // null
            r.ReadToEnd();          // Null::read_from consumes the bytes
            out->payload = TsPacket::kNull;
        } else if ((pid >= 0x01 && pid <= 0x1F) || pid == 0x1FFB) {
            out->bytes = r.ReadToEnd();
            out->payload = TsPacket::kRaw;
        } else {
            const auto it = kinds.find(pid);
            if (it == kinds.end()) {
                out->bytes = r.ReadToEnd();
                out->payload = TsPacket::kRaw;
            } else if (it->second == kPidPmt) {
                // Read the payload first so a PSI section spanning packets
                // can fall back to Raw (reader.rs:95-111).
                std::vector<uint8_t> payload_buf = r.ReadToEnd();
                bool ok = false;
                try {
                    Src mem = CursorOver(payload_buf);
                    Rd pr{&mem, mem.end};
                    out->pmt = ReadPmt(pr);
                    ok = true;
                } catch (const TsError&) {
                    // swallowed - Raw fallback below
                }
                if (ok) {
                    for (const PmtEs& es : out->pmt.es_info) kinds[es.pid] = kPidPes;
                    out->payload = TsPacket::kPmt;
                } else {
                    out->bytes = std::move(payload_buf);
                    out->payload = TsPacket::kRaw;
                }
            } else { // Pes
                if (out->pusi) {
                    out->pes_header = ReadPesHeader(r, &out->pes_packet_len);
                    out->pes_data = r.ReadToEnd();
                    out->payload = TsPacket::kPesStart;
                } else {
                    out->bytes = r.ReadToEnd();
                    out->payload = TsPacket::kPesCont;
                }
            }
        }
    }
    if (src.pos - start != TS_PACKET_SIZE) {
        InvalidInput("Unexpected remaining data in TS packet");
    }
    return true;
}

// ---- the ABI's opaque snapshot types -----------------------------------------------

struct TsdSnapshot {
    int32_t program_num = -1;
    int32_t pmt_pid = -1;
    std::vector<uint16_t> pmt_pids;
    std::vector<uint8_t> pmt_stream_types;
    std::vector<std::string> pmt_format_ids;
    std::vector<const char*> pmt_format_ids_p;

    std::vector<uint16_t> pids;
    std::vector<double> pes_counts;
    std::vector<double> byte_totals;
    std::vector<double> bitrates_mbps;
    std::vector<double> ra_counts;
    std::vector<double> last_pts;
    std::vector<double> last_dts;
    std::vector<double> pts_jumps;
    std::vector<double> cc_errors;
    std::vector<double> tei_counts;
    std::vector<double> pusi_counts;
    std::vector<double> scrambling_counts;
    std::vector<double> af_control_counts;

    std::vector<uint16_t> pcr_pids;
    std::vector<double> pcr_intervals_ms;
    std::vector<double> pcr_jitter_ms;

    std::vector<uint16_t> nal_pids;
    std::vector<double> nal_stats; // flat 9 per pid: I,P,B,IDR,SPS,PPS,SEI,AUD,NonIDR

    std::vector<double> error_t;
    std::vector<std::string> error_msg;
    std::vector<const char*> error_msg_p;

    std::vector<double> ring_t;
    std::vector<uint16_t> ring_pid;
    std::vector<uint8_t> ring_kind;
    std::vector<double> ring_pts;
    std::vector<double> ring_dts;
    std::vector<double> ring_size;
    std::vector<uint8_t> ring_ra;
    std::vector<uint8_t> ring_tei;
    std::vector<uint8_t> ring_pusi;
    std::vector<uint8_t> ring_nal;
    std::vector<uint32_t> ring_nal_offsets;
    std::vector<std::string> ring_hex;
    std::vector<const char*> ring_hex_p;

    // STRS views are rebuilt once all strings are final (the char* must not
    // outlive a move of their SSO storage).
    void FinishStrings() {
        pmt_format_ids_p.clear();
        for (const std::string& f : pmt_format_ids) pmt_format_ids_p.push_back(f.c_str());
        error_msg_p.clear();
        for (const std::string& m : error_msg) error_msg_p.push_back(m.c_str());
        ring_hex_p.clear();
        for (const std::string& h : ring_hex) ring_hex_p.push_back(h.c_str());
    }
};

struct TsdMeterSnap {
    std::vector<uint16_t> pids;
    std::vector<uint8_t> channel_counts;
    std::vector<float> peaks;
    std::vector<float> rms;
    std::vector<uint32_t> clips;
    std::vector<float> lufs;
    std::vector<float> phase;
    std::vector<float> scope_l;
    std::vector<float> scope_r;
    std::vector<float> spectrum;
    int32_t selected_pid = 0;
    int32_t selected_channel = 0;
};

// ---- TsDemuxer (lib.rs:446-525, 590-1063, 1370-1554) -------------------------------

struct TsDemuxer {
    TsDemuxer() : start_time(std::chrono::steady_clock::now()) {}

    // ---- feed buffer (lib.rs FeedBuf: leftovers stay buffered, compaction
    // only when fully caught up)
    void Append(const uint8_t* bytes, size_t len) {
        if (feed_pos >= feed_data.size()) {
            feed_data.clear();
            feed_pos = 0;
        }
        feed_data.insert(feed_data.end(), bytes, bytes + len);
    }
    bool HasPacket() const { return feed_data.size() - feed_pos >= TS_PACKET_SIZE; }

    double ElapsedMs() const {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - start_time)
                   .count() * 1000.0;
    }

    void PushPacket(PacketEntry e) {
        packet_ring.push_back(std::move(e));
        while (packet_ring.size() > PACKET_RING_CAP) packet_ring.pop_front();
    }

    void PushError(double t_ms, const std::string& msg) {
        recent_errors.emplace_back(t_ms, msg);
        while (recent_errors.size() > RECENT_ERRORS_CAP) recent_errors.pop_front();
        PacketEntry e;
        e.t_ms = t_ms;
        e.pid = 0;
        e.kind = KIND_ERROR;
        PushPacket(std::move(e));
    }

    const PmtEntry* PmtEntryFor(uint16_t pid) const {
        for (const PmtEntry& e : pmt_entries) {
            if (e.pid == pid) return &e;
        }
        return nullptr;
    }

    bool IsSmpte302mPid(uint16_t pid) const {
        const PmtEntry* e = PmtEntryFor(pid);
        return e != nullptr && e->format_id == "BSSD"; // is_s302m_registration
    }

    // lib.rs accumulate_bytes: roll the 10s bitrate window, then add n.
    void AccumulateBytes(uint16_t pid, uint64_t n,
                         std::chrono::steady_clock::time_point now) {
        PidStats& stats = pid_stats[pid];
        if (n > UINT64_MAX - stats.bytes_total) stats.bytes_total = UINT64_MAX; // saturating
        else stats.bytes_total += n;
        if (!stats.bytes_window_start) stats.bytes_window_start = now;
        const double elapsed_ms =
            std::chrono::duration<double>(now - *stats.bytes_window_start).count() * 1000.0;
        if (elapsed_ms >= BYTES_WINDOW_BUCKET_MS) {
            // Cap rotations so a stalled stream cannot spin (lib.rs:646-647).
            const size_t rotate = std::min(
                static_cast<size_t>(elapsed_ms / BYTES_WINDOW_BUCKET_MS), 2 * BYTES_WINDOW_BUCKETS);
            for (size_t i = 0; i < rotate; i++) {
                stats.bytes_window.push_back(stats.bytes_window_current);
                stats.bytes_window_current = 0;
                while (stats.bytes_window.size() > BYTES_WINDOW_BUCKETS) {
                    stats.bytes_window.pop_front();
                }
            }
            *stats.bytes_window_start = now;
        }
        if (n > UINT64_MAX - stats.bytes_window_current) stats.bytes_window_current = UINT64_MAX;
        else stats.bytes_window_current += n;
    }

    static double BitrateMbps(const PidStats& s) {
        uint64_t window_sum = 0;
        for (uint64_t v : s.bytes_window) window_sum += v;
        const uint64_t total = window_sum + s.bytes_window_current;
        const double buckets =
            std::max<double>(static_cast<double>(s.bytes_window.size() + 1), 1.0);
        const double window_secs = buckets * (BYTES_WINDOW_BUCKET_MS / 1000.0);
        if (window_secs <= 0.0) return 0.0;
        return (static_cast<double>(total) * 8.0) / window_secs / 1000000.0;
    }

    // ---- finalize_pes (lib.rs:662-768)
    void FinalizePes(uint16_t pid, const PesHeader& hdr, const std::vector<uint8_t>& payload,
                     bool ra, double t_ms, bool tei, bool pusi,
                     std::vector<std::unique_ptr<TsEvent>>& events) {
        const int64_t pts = hdr.pts ? static_cast<int64_t>(*hdr.pts) : -1;
        const int64_t dts = hdr.dts ? static_cast<int64_t>(*hdr.dts) : -1;
        {
            PidStats& stats = pid_stats[pid];
            stats.pes_count++;
            if (pts >= 0) {
                if (stats.last_pts >= 0) {
                    const int64_t delta = pts > stats.last_pts ? pts - stats.last_pts
                                                               : stats.last_pts - pts;
                    if (delta > stats.max_pts_delta) stats.max_pts_delta = delta;
                    if (delta > static_cast<int64_t>(PTS_JUMP_90K)) stats.pts_jumps++;
                }
                stats.last_pts = pts;
            }
            if (dts >= 0) stats.last_dts = dts;
        }

        // NAL classification for video PIDs only, H.264 0x1B / HEVC 0x24
        // (lib.rs:696-729) - AV1 (OBU syntax) and audio PIDs carry no
        // Annex-B NAL units. Start codes are scanned ONCE here; offsets +
        // type codes feed both the TsEvent and the PacketEntry (no re-scan).
        std::vector<uint32_t> nal_offsets;
        std::vector<uint8_t> nal_types;
        const PmtEntry* pmt_e = PmtEntryFor(pid);
        if (pmt_e != nullptr) {
            const bool is_hevc = pmt_e->stream_type == 0x24;
            const bool is_h264 = pmt_e->stream_type == 0x1B;
            if (is_hevc || is_h264) {
                nal::NalScan scan = nal::ScanNal(payload.data(), payload.size(), is_hevc);

                // Flat offsets array [off0, len0, off1, len1, ...].
                nal_offsets.reserve(scan.ranges.size() * 2);
                nal_types = scan.types;
                for (const auto& [start, end] : scan.ranges) {
                    nal_offsets.push_back(static_cast<uint32_t>(start));
                    nal_offsets.push_back(static_cast<uint32_t>(end - start));
                }

                // Accumulate debug stats from the same scan (no re-scan).
                const nal::NalStats nstats =
                    nal::ParseNalStatsFromScan(payload.data(), payload.size(), scan, is_hevc);
                nal::NalStats& entry = nal_stats[pid];
                entry.aud = SatAddU32(entry.aud, nstats.aud);
                entry.sps = SatAddU32(entry.sps, nstats.sps);
                entry.pps = SatAddU32(entry.pps, nstats.pps);
                entry.sei = SatAddU32(entry.sei, nstats.sei);
                entry.idr = SatAddU32(entry.idr, nstats.idr);
                entry.non_idr_slice =
                    SatAddU32(entry.non_idr_slice, nstats.non_idr_slice);
                entry.i_slices = SatAddU32(entry.i_slices, nstats.i_slices);
                entry.p_slices = SatAddU32(entry.p_slices, nstats.p_slices);
                entry.b_slices = SatAddU32(entry.b_slices, nstats.b_slices);
            }
        }

        // Emit event with the pre-parsed NAL data (nal_types clones for
        // the event; the original moves into the ring entry below).
        events.push_back(std::make_unique<TsEvent>(TsEvent::Pes(
            pid, hdr, payload, ra, std::move(nal_offsets), nal_types)));

        if (IsSmpte302mPid(pid)) {
            // lib.rs:741-753: decode right after the pes event; the pcm
            // event and the meter update ride the same non-empty decode
            // condition (a valid AES3 header plus at least one whole data
            // chunk), and the meter sees the identical samples burst,
            // channel count (per-PES AES3 header; the unwrap_or(2) arm is
            // unreachable with non-empty samples but mirrored anyway) and
            // pts, BEFORE the samples move into the event.
            std::vector<float> samples = aes3::UnwrapSmpte302mPes(payload.data(), payload.size());
            if (!samples.empty()) {
                const auto info = aes3::S302mInfoFromHeader(payload.data(), payload.size());
                const uint8_t channel_count = info ? info->channel_count : 2;
                meter_state.Update(pid, samples.data(), samples.size(), channel_count, pts);
                events.push_back(std::make_unique<TsEvent>(
                    TsEvent::Pcm(pid, pts, channel_count, std::move(samples))));
            }
        }

        PacketEntry e;
        e.t_ms = t_ms;
        e.pid = pid;
        e.kind = KIND_PES;
        e.pts = pts;
        e.dts = dts;
        e.size = static_cast<uint32_t>(payload.size());
        e.ra = ra;
        e.nal_summary = std::move(nal_types);
        e.tei = tei;
        e.pusi = pusi;
        e.hex = HexPrefix(payload.data(), payload.size());
        PushPacket(std::move(e));
    }

    // ---- handle_packet (lib.rs:770-985)
    void HandlePacket(const TsPacket& packet, std::vector<std::unique_ptr<TsEvent>>& events) {
        const auto now = std::chrono::steady_clock::now();
        const double elapsed_ms = ElapsedMs();
        const uint16_t pid = packet.pid;
        const bool tei = packet.tei;
        const uint8_t cc = packet.cc;
        const uint8_t scrambling = packet.scrambling;
        // pusi per lib.rs:779-785 - payload-type derived, always false for
        // Raw/Null/PesContinuation even when the header bit is set.
        bool pusi = false;
        switch (packet.payload) {
            case TsPacket::kPat:
            case TsPacket::kPmt:
            case TsPacket::kPesStart:
                pusi = true;
                break;
            default:
                break;
        }
        const bool has_af = packet.has_af;
        const bool has_payload = packet.payload != TsPacket::kNone;
        const uint8_t af_control =
            has_af ? (has_payload ? 0x3 : 0x2) : (has_payload ? 0x1 : 0x0);
        const bool discontinuity = has_af && packet.af.discontinuity;

        // Header flag counters apply to EVERY packet (lib.rs:802-816).
        {
            PidStats& stats = pid_stats[pid];
            if (tei) stats.tei_count++;
            if (pusi) stats.pusi_count++;
            stats.scrambling_counts[scrambling]++;
            stats.af_control_counts[af_control]++;
        }

        if (has_af) {
            if (packet.af.pcr) {
                const uint64_t pcr_27mhz = *packet.af.pcr;
                PcrStats& pcr = pcr_stats[pid];
                if (pcr.last_27mhz != 0) {
                    const uint64_t delta_27mhz = pcr_27mhz - pcr.last_27mhz; // wrapping
                    const double interval_ms = static_cast<double>(delta_27mhz) / 27000.0;
                    if (pcr.interval_ms > 0.0) {
                        const double jitter = std::fabs(interval_ms - pcr.interval_ms);
                        pcr.jitter_ms_ema = pcr.jitter_ms_ema * 0.9 + jitter * 0.1;
                    }
                    pcr.interval_ms = interval_ms;
                }
                pcr.last_27mhz = pcr_27mhz;
            }
            if (packet.af.random_access) {
                // Stash for the PES starting in THIS packet; consumed at
                // PesStart so the flag is not attached to the preceding
                // delta PES flushed at the same PesStart (lib.rs:834-843).
                last_ra[pid] = true;
                {
                    PidStats& stats = pid_stats[pid];
                    stats.ra_count++;
                }
                events.push_back(
                    std::make_unique<TsEvent>(TsEvent::RandomAccess(pid)));
                PacketEntry e;
                e.t_ms = elapsed_ms;
                e.pid = pid;
                e.kind = KIND_RA;
                e.ra = true;
                e.tei = tei;
                e.pusi = pusi;
                PushPacket(std::move(e));
            }
        }

        if (!has_payload) return;

        // CC continuity (ISO/IEC 13818-1 2.4.3.3): payload-bearing packets
        // only; a discontinuity_indicator legitimately resets the counter.
        if (!discontinuity) {
            const auto it = last_cc.find(pid);
            if (it != last_cc.end()) {
                const uint8_t expected = (it->second + 1) & 0x0F;
                if (cc != expected) pid_stats[pid].cc_errors++;
            }
        }
        last_cc[pid] = cc;

        switch (packet.payload) {
            case TsPacket::kPat: {
                for (const PatEntry& pa : packet.pat) {
                    program_num = pa.program_num;
                    pmt_pid = pa.pmt_pid;
                    events.push_back(std::make_unique<TsEvent>(
                        TsEvent::Pat(pa.program_num, pa.pmt_pid)));
                    PacketEntry e;
                    e.t_ms = elapsed_ms;
                    e.pid = pid;
                    e.kind = KIND_PAT;
                    e.tei = tei;
                    e.pusi = pusi;
                    PushPacket(std::move(e));
                }
                break;
            }
            case TsPacket::kPmt: {
                HandlePmt(packet.pmt, elapsed_ms, tei, pusi, events);
                break;
            }
            case TsPacket::kPesStart: {
                const size_t pes_payload_len = packet.pes_data.size();
                PartialPes& entry = partials[pid];
                bool have_flush = false;
                PesHeader flushed_hdr;
                std::vector<uint8_t> flushed_payload;
                bool flushed_ra = false;
                if (entry.header && !entry.buf.empty()) {
                    flushed_hdr = std::move(*entry.header);
                    entry.header.reset();
                    flushed_payload = std::move(entry.buf);
                    entry.buf.clear();
                    flushed_ra = entry.ra;
                    entry.ra = false;
                    have_flush = true;
                }
                // Declared ES length: Ok(None) and Err both mean unbounded
                // (flush at next PesStart) - lib.rs:916-925.
                try {
                    entry.declared_len =
                        packet.pes_header.EsPayloadLen(packet.pes_packet_len);
                } catch (const TsError&) {
                    entry.declared_len = std::nullopt;
                }
                entry.header = packet.pes_header;
                const auto ra_it = last_ra.find(pid);
                entry.ra = ra_it != last_ra.end() && ra_it->second;
                last_ra[pid] = false;
                entry.buf.insert(entry.buf.end(), packet.pes_data.begin(), packet.pes_data.end());
                // The NEW partial's bytes count toward the bitrate now, not
                // at flush (lib.rs:930-933).
                AccumulateBytes(pid, pes_payload_len, now);

                if (have_flush) {
                    FinalizePes(pid, flushed_hdr, flushed_payload, flushed_ra, elapsed_ms, tei,
                                pusi, events);
                }
                MaybeFlush(pid, elapsed_ms, tei, pusi, events);
                break;
            }
            case TsPacket::kPesCont: {
                const auto it = partials.find(pid);
                if (it != partials.end()) {
                    it->second.buf.insert(it->second.buf.end(), packet.bytes.begin(),
                                          packet.bytes.end());
                }
                AccumulateBytes(pid, packet.bytes.size(), now);
                MaybeFlush(pid, elapsed_ms, tei, pusi, events);
                break;
            }
            case TsPacket::kRaw: {
                if (pmt_pid && *pmt_pid == pid) {
                    Pmt assembled;
                    if (AssemblePsi(pid, packet.bytes, pusi, &assembled)) {
                        HandlePmt(assembled, elapsed_ms, tei, pusi, events);
                    }
                }
                PacketEntry e;
                e.t_ms = elapsed_ms;
                e.pid = pid;
                e.kind = KIND_OTHER;
                e.tei = tei;
                e.pusi = pusi;
                PushPacket(std::move(e));
                break;
            }
            case TsPacket::kNull: {
                PacketEntry e;
                e.t_ms = elapsed_ms;
                e.pid = pid;
                e.kind = KIND_OTHER;
                e.tei = tei;
                e.pusi = pusi;
                PushPacket(std::move(e));
                break;
            }
            default:
                break;
        }
    }

    // lib.rs:545-588 assemble_psi. `pusi` is the payload-derived flag
    // (always false for Raw); an existing partial distinguishes start from
    // continuation. false = still accumulating OR complete-but-unparseable
    // (Rust's Pmt::read_from(...).ok()).
    bool AssemblePsi(uint16_t pid, const std::vector<uint8_t>& bytes, bool pusi, Pmt* out) {
        const bool is_start = pusi || partial_psi.find(pid) == partial_psi.end();

        if (is_start) {
            if (bytes.empty()) return false; // bytes.get(0)?
            const size_t ptr = bytes[0];
            const size_t section_start = 1 + ptr;
            if (bytes.size() < section_start + 3) return false;
            const size_t sl =
                ((bytes[section_start + 1] & 0x0F) << 8) | bytes[section_start + 2];
            PartialPsi p;
            p.buf.push_back(0); // fake pointer_field 0
            p.buf.insert(p.buf.end(), bytes.begin() + static_cast<long>(section_start),
                         bytes.end());
            p.section_total = 3 + sl;
            partial_psi[pid] = std::move(p);
        } else {
            const auto it = partial_psi.find(pid);
            if (it == partial_psi.end()) return false; // partials.get_mut(&pid)?
            it->second.buf.insert(it->second.buf.end(), bytes.begin(), bytes.end());
        }

        {
            const auto it = partial_psi.find(pid);
            if (it == partial_psi.end()) return false;
            if (it->second.buf.size() < 1 + it->second.section_total) return false;
        }

        PartialPsi p = std::move(partial_psi[pid]);
        partial_psi.erase(pid);
        Src mem = CursorOver(p.buf);
        Rd pr{&mem, mem.end};
        try {
            *out = ReadPmt(pr);
            return true;
        } catch (const TsError&) {
            return false;
        }
    }

    // handle_pmt (lib.rs:987-1025)
    void HandlePmt(const Pmt& pmt, double elapsed_ms, bool tei, bool pusi,
                   std::vector<std::unique_ptr<TsEvent>>& events) {
        const uint16_t row_pid = pmt_pid.value_or(0x1000);
        std::vector<PmtEntry> new_entries;
        std::vector<std::pair<uint16_t, uint8_t>> entries;
        std::vector<std::string> format_ids;
        new_entries.reserve(pmt.es_info.size());
        entries.reserve(pmt.es_info.size());
        for (const PmtEs& e : pmt.es_info) {
            PmtEntry ne;
            ne.pid = e.pid;
            ne.stream_type = e.stream_type;
            ne.format_id = ExtractFormatId(e.descriptors);
            new_entries.push_back(ne);
            entries.emplace_back(e.pid, e.stream_type);
            pid_kinds[e.pid] = kPidPes; // reader.register_pes_pid
        }
        for (const PmtEntry& ne : new_entries) format_ids.push_back(ne.format_id);
        pmt_entries = std::move(new_entries);

        events.push_back(
            std::make_unique<TsEvent>(TsEvent::Pmt(entries, format_ids)));
        PacketEntry row;
        row.t_ms = elapsed_ms;
        row.pid = row_pid;
        row.kind = KIND_PMT;
        row.tei = tei;
        row.pusi = pusi;
        PushPacket(std::move(row));
    }

    // maybe_flush (lib.rs:1027-1063)
    void MaybeFlush(uint16_t pid, double elapsed_ms, bool tei, bool pusi,
                    std::vector<std::unique_ptr<TsEvent>>& events) {
        bool flush = false;
        {
            const auto it = partials.find(pid);
            if (it != partials.end() && it->second.declared_len) {
                flush = it->second.buf.size() >= *it->second.declared_len;
            }
        }
        if (!flush) return;
        PartialPes& p = partials[pid];
        PesHeader hdr;
        if (p.header) {
            hdr = *p.header;
            p.header.reset();
        } else {
            hdr.stream_id = 0xBC; // the fork's default PesHeader fallback
        }
        std::vector<uint8_t> payload = std::move(p.buf);
        p.buf.clear();
        p.declared_len.reset();
        const bool ra = p.ra;
        p.ra = false;
        FinalizePes(pid, hdr, payload, ra, elapsed_ms, tei, pusi, events);
    }

    // ---- feed (lib.rs:507-524)
    size_t Feed(const uint8_t* bytes, size_t len) {
        Append(bytes, len);
        pending.clear(); // untaken staged events are released, not leaked
        while (HasPacket()) {
            Src src{feed_data.data(), feed_data.size(), feed_pos};
            TsPacket packet;
            bool have = false;
            std::optional<std::string> errmsg;
            try {
                have = ReadTsPacket(src, pid_kinds, &packet);
            } catch (const TsError& e) {
                errmsg = std::string("ts parse: ") + e.kind + ": " + e.what();
            }
            feed_pos = src.pos; // an error leaves the cursor mid-packet
            if (!have) {
                if (!errmsg) break; // Ok(None): no full packet left
                const double t_ms = ElapsedMs();
                PushError(t_ms, *errmsg);
                pending.push_back(std::make_unique<TsEvent>(TsEvent::Error(*errmsg)));
                continue;
            }
            HandlePacket(packet, pending);
        }
        return pending.size();
    }

    // ---- debug_snapshot (lib.rs:1376-1530); fills s in place so the STRS
    // views can be built after the strings settle.
    void BuildSnapshot(TsdSnapshot* s) const {
        std::vector<uint16_t> pids;
        pids.reserve(pid_stats.size());
        for (const auto& kv : pid_stats) pids.push_back(kv.first);
        std::sort(pids.begin(), pids.end());
        for (uint16_t pid : pids) {
            const PidStats& st = pid_stats.at(pid);
            s->pids.push_back(pid);
            s->pes_counts.push_back(static_cast<double>(st.pes_count));
            s->byte_totals.push_back(static_cast<double>(st.bytes_total));
            s->bitrates_mbps.push_back(BitrateMbps(st));
            s->ra_counts.push_back(static_cast<double>(st.ra_count));
            s->last_pts.push_back(st.last_pts < 0 ? -1.0 : static_cast<double>(st.last_pts));
            s->last_dts.push_back(st.last_dts < 0 ? -1.0 : static_cast<double>(st.last_dts));
            s->pts_jumps.push_back(static_cast<double>(st.pts_jumps));
            s->cc_errors.push_back(static_cast<double>(st.cc_errors));
            s->tei_counts.push_back(static_cast<double>(st.tei_count));
            s->pusi_counts.push_back(static_cast<double>(st.pusi_count));
            for (int i = 0; i < 4; i++) {
                s->scrambling_counts.push_back(static_cast<double>(st.scrambling_counts[i]));
                s->af_control_counts.push_back(static_cast<double>(st.af_control_counts[i]));
            }
        }

        std::vector<uint16_t> pcrs;
        pcrs.reserve(pcr_stats.size());
        for (const auto& kv : pcr_stats) pcrs.push_back(kv.first);
        std::sort(pcrs.begin(), pcrs.end());
        for (uint16_t pid : pcrs) {
            const PcrStats& p = pcr_stats.at(pid);
            s->pcr_pids.push_back(pid);
            s->pcr_intervals_ms.push_back(p.interval_ms);
            s->pcr_jitter_ms.push_back(p.jitter_ms_ema);
        }

        // nal_stats (lib.rs:1429-1444): video pids ascending, flat 9 per
        // pid in the order I,P,B,IDR,SPS,PPS,SEI,AUD,NonIDR.
        {
            std::vector<uint16_t> nals;
            nals.reserve(nal_stats.size());
            for (const auto& kv : nal_stats) nals.push_back(kv.first);
            std::sort(nals.begin(), nals.end());
            for (uint16_t pid : nals) {
                const nal::NalStats& n = nal_stats.at(pid);
                s->nal_pids.push_back(pid);
                s->nal_stats.push_back(static_cast<double>(n.i_slices));
                s->nal_stats.push_back(static_cast<double>(n.p_slices));
                s->nal_stats.push_back(static_cast<double>(n.b_slices));
                s->nal_stats.push_back(static_cast<double>(n.idr));
                s->nal_stats.push_back(static_cast<double>(n.sps));
                s->nal_stats.push_back(static_cast<double>(n.pps));
                s->nal_stats.push_back(static_cast<double>(n.sei));
                s->nal_stats.push_back(static_cast<double>(n.aud));
                s->nal_stats.push_back(static_cast<double>(n.non_idr_slice));
            }
        }

        for (const PmtEntry& e : pmt_entries) {
            s->pmt_pids.push_back(e.pid);
            s->pmt_stream_types.push_back(e.stream_type);
            s->pmt_format_ids.push_back(e.format_id);
        }

        for (const auto& err : recent_errors) {
            s->error_t.push_back(err.first);
            s->error_msg.push_back(err.second);
        }

        s->ring_nal_offsets.push_back(0);
        for (const PacketEntry& e : packet_ring) {
            s->ring_t.push_back(e.t_ms);
            s->ring_pid.push_back(e.pid);
            s->ring_kind.push_back(e.kind);
            s->ring_pts.push_back(e.pts < 0 ? -1.0 : static_cast<double>(e.pts));
            s->ring_dts.push_back(e.dts < 0 ? -1.0 : static_cast<double>(e.dts));
            s->ring_size.push_back(static_cast<double>(e.size));
            s->ring_ra.push_back(e.ra ? 1 : 0);
            s->ring_tei.push_back(e.tei ? 1 : 0);
            s->ring_pusi.push_back(e.pusi ? 1 : 0);
            s->ring_nal.insert(s->ring_nal.end(), e.nal_summary.begin(), e.nal_summary.end());
            s->ring_nal_offsets.push_back(static_cast<uint32_t>(s->ring_nal.size()));
            s->ring_hex.push_back(e.hex);
        }

        s->program_num = program_num ? static_cast<int32_t>(*program_num) : -1;
        s->pmt_pid = pmt_pid ? static_cast<int32_t>(*pmt_pid) : -1;
        s->FinishStrings();
    }

    // ---- meter_snapshot: the full MUTATING MeterState::Snapshot
    // (meter.rs:419-485) - latches held peak/rms, resets the peak/RMS
    // windows, pushes phase windows into their ring, reads scope and
    // spectrum from the selected PID (lowest PID when the selection points
    // at a gone PID; documented empty shapes when no PID ever metered).
    void BuildMeterSnapshot(TsdMeterSnap* m) {
        meter::MeterSnapshot s = meter_state.Snapshot();
        m->pids = std::move(s.pids);
        m->channel_counts = std::move(s.channel_counts);
        m->peaks = std::move(s.peaks);
        m->rms = std::move(s.rms);
        m->clips = std::move(s.clips);
        m->lufs = std::move(s.lufs);
        m->phase = std::move(s.phase);
        m->scope_l = std::move(s.scope_l);
        m->scope_r = std::move(s.scope_r);
        m->spectrum = std::move(s.spectrum);
        m->selected_pid = s.selected_pid;
        m->selected_channel = s.selected_channel;
    }

    // ---- state
    std::vector<uint8_t> feed_data;
    size_t feed_pos = 0;
    std::unordered_map<uint16_t, uint8_t> pid_kinds; // PidKind

    std::unordered_map<uint16_t, PartialPes> partials;
    std::unordered_map<uint16_t, PartialPsi> partial_psi;
    std::unordered_map<uint16_t, bool> last_ra;

    std::optional<uint16_t> program_num;
    std::optional<uint16_t> pmt_pid;
    std::vector<PmtEntry> pmt_entries;

    std::unordered_map<uint16_t, PidStats> pid_stats;
    std::unordered_map<uint16_t, PcrStats> pcr_stats;
    std::unordered_map<uint16_t, uint8_t> last_cc;
    std::unordered_map<uint16_t, nal::NalStats> nal_stats;

    std::deque<std::pair<double, std::string>> recent_errors;
    std::deque<PacketEntry> packet_ring;

    meter::MeterState meter_state; // one per demuxer, lifetime state
                                    // (lib.rs:474-475, 502)

    std::chrono::steady_clock::time_point start_time;
    std::vector<std::unique_ptr<TsEvent>> pending;
};

// ---- C ABI ---------------------------------------------------------------------------

extern "C" {

TsDemuxer* tsd_new(void) {
    return new TsDemuxer();
}

void tsd_free(TsDemuxer* d) {
    delete d;
}

int tsd_feed(TsDemuxer* d, const uint8_t* bytes, int len) {
    if (d == nullptr || bytes == nullptr || len < 0) return 0;
    return static_cast<int>(d->Feed(bytes, static_cast<size_t>(len)));
}

TsEvent* tsd_event_take(TsDemuxer* d, int i) {
    if (d == nullptr || i < 0 || static_cast<size_t>(i) >= d->pending.size()) return nullptr;
    return d->pending[static_cast<size_t>(i)].release();
}

void tsd_event_free(TsEvent* e) {
    delete e;
}

uint8_t tsd_ev_kind(const TsEvent* e) { return e->kind; }
uint16_t tsd_ev_pid(const TsEvent* e) { return e->pid; }
double tsd_ev_pts(const TsEvent* e) { return e->pts < 0 ? -1.0 : static_cast<double>(e->pts); }
double tsd_ev_dts(const TsEvent* e) { return e->dts < 0 ? -1.0 : static_cast<double>(e->dts); }
uint8_t tsd_ev_stream_type(const TsEvent* e) { return e->stream_type; }
uint16_t tsd_ev_program_num(const TsEvent* e) { return e->program_num; }
int tsd_ev_random_access(const TsEvent* e) { return e->random_access ? 1 : 0; }
int tsd_ev_data_len(const TsEvent* e) { return static_cast<int>(e->data.size()); }
const uint8_t* tsd_ev_data(const TsEvent* e) { return e->data.data(); }
const char* tsd_ev_text(const TsEvent* e) { return e->text.c_str(); }

// pmt_entries (lib.rs:265-278): re-derived from data, LE u16 pairs.
int tsd_ev_pmt_entry_count(const TsEvent* e) {
    return static_cast<int>(e->data.size() / 4 * 2);
}
uint16_t tsd_ev_pmt_entry(const TsEvent* e, int j) {
    const size_t byte = static_cast<size_t>(j) * 2;
    if (byte + 1 >= e->data.size()) return 0;
    return static_cast<uint16_t>(e->data[byte] | (e->data[byte + 1] << 8));
}

int tsd_ev_format_id_count(const TsEvent* e) {
    return static_cast<int>(e->pmt_format_ids.size());
}
const char* tsd_ev_format_id(const TsEvent* e, int j) {
    if (j < 0 || static_cast<size_t>(j) >= e->pmt_format_ids.size()) return "";
    return e->pmt_format_ids[static_cast<size_t>(j)].c_str();
}

int tsd_ev_nal_offset_count(const TsEvent* e) {
    return static_cast<int>(e->nal_offsets.size());
}
const uint32_t* tsd_ev_nal_offsets(const TsEvent* e) { return e->nal_offsets.data(); }
int tsd_ev_nal_type_count(const TsEvent* e) { return static_cast<int>(e->nal_types.size()); }
const uint8_t* tsd_ev_nal_types(const TsEvent* e) { return e->nal_types.data(); }
int tsd_ev_sample_count(const TsEvent* e) { return static_cast<int>(e->samples.size()); }
const float* tsd_ev_samples(const TsEvent* e) { return e->samples.data(); }

TsdSnapshot* tsd_debug_snapshot(const TsDemuxer* d) {
    if (d == nullptr) return nullptr;
    TsdSnapshot* s = new TsdSnapshot();
    d->BuildSnapshot(s);
    return s;
}

void tsd_snapshot_free(TsdSnapshot* s) {
    delete s;
}

static int ViewOf(TsdFieldView* out, const void* data, size_t count, int kind) {
    out->data = data;
    out->count = static_cast<int>(count);
    out->kind = kind;
    return 0;
}

int tsd_snap_field(const TsdSnapshot* s, int field, TsdFieldView* out) {
    if (s == nullptr || out == nullptr) return -1;
    switch (field) {
        case TSD_SNAP_PROGRAM_NUM: return ViewOf(out, &s->program_num, 1, TSD_I32);
        case TSD_SNAP_PMT_PID: return ViewOf(out, &s->pmt_pid, 1, TSD_I32);
        case TSD_SNAP_PMT_PIDS: return ViewOf(out, s->pmt_pids.data(), s->pmt_pids.size(), TSD_U16);
        case TSD_SNAP_PMT_STREAM_TYPES:
            return ViewOf(out, s->pmt_stream_types.data(), s->pmt_stream_types.size(), TSD_U8);
        case TSD_SNAP_PMT_FORMAT_IDS:
            return ViewOf(out, s->pmt_format_ids_p.data(), s->pmt_format_ids_p.size(), TSD_STRS);
        case TSD_SNAP_PIDS: return ViewOf(out, s->pids.data(), s->pids.size(), TSD_U16);
        case TSD_SNAP_PES_COUNTS:
            return ViewOf(out, s->pes_counts.data(), s->pes_counts.size(), TSD_F64);
        case TSD_SNAP_BYTE_TOTALS:
            return ViewOf(out, s->byte_totals.data(), s->byte_totals.size(), TSD_F64);
        case TSD_SNAP_BITRATES_MBPS:
            return ViewOf(out, s->bitrates_mbps.data(), s->bitrates_mbps.size(), TSD_F64);
        case TSD_SNAP_RA_COUNTS:
            return ViewOf(out, s->ra_counts.data(), s->ra_counts.size(), TSD_F64);
        case TSD_SNAP_LAST_PTS: return ViewOf(out, s->last_pts.data(), s->last_pts.size(), TSD_F64);
        case TSD_SNAP_LAST_DTS: return ViewOf(out, s->last_dts.data(), s->last_dts.size(), TSD_F64);
        case TSD_SNAP_PTS_JUMPS:
            return ViewOf(out, s->pts_jumps.data(), s->pts_jumps.size(), TSD_F64);
        case TSD_SNAP_CC_ERRORS: return ViewOf(out, s->cc_errors.data(), s->cc_errors.size(), TSD_F64);
        case TSD_SNAP_TEI_COUNTS:
            return ViewOf(out, s->tei_counts.data(), s->tei_counts.size(), TSD_F64);
        case TSD_SNAP_PUSI_COUNTS:
            return ViewOf(out, s->pusi_counts.data(), s->pusi_counts.size(), TSD_F64);
        case TSD_SNAP_SCRAMBLING_COUNTS:
            return ViewOf(out, s->scrambling_counts.data(), s->scrambling_counts.size(), TSD_F64);
        case TSD_SNAP_AF_CONTROL_COUNTS:
            return ViewOf(out, s->af_control_counts.data(), s->af_control_counts.size(), TSD_F64);
        case TSD_SNAP_PCR_PIDS: return ViewOf(out, s->pcr_pids.data(), s->pcr_pids.size(), TSD_U16);
        case TSD_SNAP_PCR_INTERVALS_MS:
            return ViewOf(out, s->pcr_intervals_ms.data(), s->pcr_intervals_ms.size(), TSD_F64);
        case TSD_SNAP_PCR_JITTER_MS:
            return ViewOf(out, s->pcr_jitter_ms.data(), s->pcr_jitter_ms.size(), TSD_F64);
        case TSD_SNAP_NAL_PIDS: return ViewOf(out, s->nal_pids.data(), s->nal_pids.size(), TSD_U16);
        case TSD_SNAP_NAL_STATS:
            return ViewOf(out, s->nal_stats.data(), s->nal_stats.size(), TSD_F64);
        case TSD_SNAP_ERROR_T: return ViewOf(out, s->error_t.data(), s->error_t.size(), TSD_F64);
        case TSD_SNAP_ERROR_MSG:
            return ViewOf(out, s->error_msg_p.data(), s->error_msg_p.size(), TSD_STRS);
        case TSD_SNAP_RING_T: return ViewOf(out, s->ring_t.data(), s->ring_t.size(), TSD_F64);
        case TSD_SNAP_RING_PID: return ViewOf(out, s->ring_pid.data(), s->ring_pid.size(), TSD_U16);
        case TSD_SNAP_RING_KIND: return ViewOf(out, s->ring_kind.data(), s->ring_kind.size(), TSD_U8);
        case TSD_SNAP_RING_PTS: return ViewOf(out, s->ring_pts.data(), s->ring_pts.size(), TSD_F64);
        case TSD_SNAP_RING_DTS: return ViewOf(out, s->ring_dts.data(), s->ring_dts.size(), TSD_F64);
        case TSD_SNAP_RING_SIZE:
            return ViewOf(out, s->ring_size.data(), s->ring_size.size(), TSD_F64);
        case TSD_SNAP_RING_RA: return ViewOf(out, s->ring_ra.data(), s->ring_ra.size(), TSD_U8);
        case TSD_SNAP_RING_TEI: return ViewOf(out, s->ring_tei.data(), s->ring_tei.size(), TSD_U8);
        case TSD_SNAP_RING_PUSI: return ViewOf(out, s->ring_pusi.data(), s->ring_pusi.size(), TSD_U8);
        case TSD_SNAP_RING_NAL: return ViewOf(out, s->ring_nal.data(), s->ring_nal.size(), TSD_U8);
        case TSD_SNAP_RING_NAL_OFFSETS:
            return ViewOf(out, s->ring_nal_offsets.data(), s->ring_nal_offsets.size(), TSD_U32);
        case TSD_SNAP_RING_HEX:
            return ViewOf(out, s->ring_hex_p.data(), s->ring_hex_p.size(), TSD_STRS);
        default: return -1;
    }
}

TsdMeterSnap* tsd_meter_snapshot(TsDemuxer* d) {
    if (d == nullptr) return nullptr;
    TsdMeterSnap* m = new TsdMeterSnap();
    d->BuildMeterSnapshot(m);
    return m;
}

void tsd_meter_free(TsdMeterSnap* m) {
    delete m;
}

int tsd_meter_field(const TsdMeterSnap* m, int field, TsdFieldView* out) {
    if (m == nullptr || out == nullptr) return -1;
    switch (field) {
        case TSD_METER_PIDS: return ViewOf(out, m->pids.data(), m->pids.size(), TSD_U16);
        case TSD_METER_CHANNEL_COUNTS:
            return ViewOf(out, m->channel_counts.data(), m->channel_counts.size(), TSD_U8);
        case TSD_METER_PEAKS: return ViewOf(out, m->peaks.data(), m->peaks.size(), TSD_F32);
        case TSD_METER_RMS: return ViewOf(out, m->rms.data(), m->rms.size(), TSD_F32);
        case TSD_METER_CLIPS: return ViewOf(out, m->clips.data(), m->clips.size(), TSD_U32);
        case TSD_METER_LUFS: return ViewOf(out, m->lufs.data(), m->lufs.size(), TSD_F32);
        case TSD_METER_PHASE: return ViewOf(out, m->phase.data(), m->phase.size(), TSD_F32);
        case TSD_METER_SCOPE_L: return ViewOf(out, m->scope_l.data(), m->scope_l.size(), TSD_F32);
        case TSD_METER_SCOPE_R: return ViewOf(out, m->scope_r.data(), m->scope_r.size(), TSD_F32);
        case TSD_METER_SPECTRUM:
            return ViewOf(out, m->spectrum.data(), m->spectrum.size(), TSD_F32);
        case TSD_METER_SELECTED_PID: return ViewOf(out, &m->selected_pid, 1, TSD_I32);
        case TSD_METER_SELECTED_CHANNEL: return ViewOf(out, &m->selected_channel, 1, TSD_I32);
        default: return -1;
    }
}

void tsd_set_meter_selection(TsDemuxer* d, uint16_t pid, uint8_t channel) {
    if (d == nullptr) return;
    // lib.rs:1550-1554: plain field assignment - pid=0 or a gone PID
    // re-locks to the next 302M PID on update (meter.rs:404-406).
    d->meter_state.selected_pid = pid;
    d->meter_state.selected_channel = channel;
}

} // extern "C"
