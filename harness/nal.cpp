// The M5 NAL scanner. Every quirk below is deliberate and pinned by the
// js/demux_parity.mjs golden-baseline gate:
//
//   - No emulation-prevention stripping (nal.rs:6-10): slice headers are
//     read raw past the NAL header (H.264 from byte 1, HEVC from byte 2);
//     the first exp-Golomb codes sit well before any realistic 00 00 03.
//   - Start-code scan order matters (nal.rs:85-109): at each offset the
//     3-byte 00 00 01 is tested BEFORE the 4-byte 00 00 00 01, so a
//     4-byte code is found AT its first 00 byte (len 4) - and a run
//     00 00 00 00 01 yields one len-4 code starting at the second byte,
//     the stray first 00 remaining ordinary inter-NAL data.
//   - The last NAL runs to payload end (nal.rs:113-117) - trailing zero
//     bytes belong to it; a range is dropped only when empty
//     (back-to-back start codes, nal.rs:118-120).
//   - HEVC NALs shorter than 2 bytes are skipped entirely (nal.rs:168-170);
//     H.264 has no such check - byte 0 always exists (ranges are non-empty).
//   - HEVC VPS (type 32) folds into pps (nal.rs:174); IDR_W_RADL/RADL
//     (19/20) count idr AND i_slices (nal.rs:178-181); H.264 slice_type
//     is taken mod 5, HEVC's is not (nal.rs:211 vs 189).
//   - Malformed slice headers never abort demux (nal.rs:12-14): the
//     BitReader returns None on exhaustion and the NAL stays counted as a
//     (non-)IDR slice without I/P/B classification.

#include "nal.h"

#include <optional>

namespace nal {
namespace {

// MSB-first bit reader over a borrowed byte slice (nal.rs:15-64). All
// methods return nullopt on end-of-input rather than throwing, so
// malformed NAL units are silently skipped. read_u(0) is 0 without
// touching the reader (the loop body never runs, nal.rs:57-63).
class BitReader {
public:
    BitReader(const uint8_t* bytes, size_t len) : bytes_(bytes), len_(len) {}

    std::optional<uint8_t> ReadBit() {
        const size_t byte_idx = bit_pos_ / 8;
        if (byte_idx >= len_) return std::nullopt;
        const unsigned bit_idx = 7 - (bit_pos_ % 8);
        const uint8_t bit = static_cast<uint8_t>((bytes_[byte_idx] >> bit_idx) & 1);
        bit_pos_ += 1;
        return bit;
    }

    // Fixed-length n-bit unsigned.
    std::optional<uint32_t> ReadU(uint32_t n) {
        uint32_t val = 0;
        for (uint32_t i = 0; i < n; i++) {
            const auto bit = ReadBit();
            if (!bit) return std::nullopt;
            val = (val << 1) | *bit;
        }
        return val;
    }

    // Unsigned exp-Golomb ue(v) per ITU-T H.264 9.1 / H.265 9.1: leading
    // zeros then 1 then the suffix; >= 32 leading zeros is None (the
    // check runs at loop top, so exactly 32 zero bits bail, nal.rs:37-48).
    std::optional<uint32_t> ReadUe() {
        uint32_t leading_zeros = 0;
        for (;;) {
            if (leading_zeros >= 32) return std::nullopt;
            const auto bit = ReadBit();
            if (!bit) return std::nullopt;
            if (*bit == 1) break;
            leading_zeros += 1;
        }
        if (leading_zeros == 0) return 0;
        const auto suffix = ReadU(leading_zeros);
        if (!suffix) return std::nullopt;
        return (1u << leading_zeros) - 1 + *suffix;
    }

private:
    const uint8_t* bytes_;
    size_t len_;
    size_t bit_pos_ = 0;
};

// scan_nal_ranges (nal.rs:85-123).
std::vector<std::pair<size_t, size_t>> ScanNalRanges(const uint8_t* payload, size_t n) {
    std::vector<size_t> code_begins;
    std::vector<size_t> code_lens;
    size_t i = 0;
    while (i + 3 <= n) {
        if (payload[i] == 0 && payload[i + 1] == 0 && payload[i + 2] == 1) {
            code_begins.push_back(i);
            code_lens.push_back(3);
            i += 3;
            continue;
        }
        if (i + 4 <= n && payload[i] == 0 && payload[i + 1] == 0 && payload[i + 2] == 0 &&
            payload[i + 3] == 1) {
            code_begins.push_back(i);
            code_lens.push_back(4);
            i += 4;
            continue;
        }
        i += 1;
    }
    std::vector<std::pair<size_t, size_t>> ranges;
    ranges.reserve(code_begins.size());
    for (size_t j = 0; j < code_begins.size(); j++) {
        const size_t data_start = code_begins[j] + code_lens[j];
        const size_t data_end = j + 1 < code_begins.size() ? code_begins[j + 1] : n;
        if (data_end > data_start) ranges.emplace_back(data_start, data_end);
    }
    return ranges;
}

} // namespace

// scan_nal (nal.rs:134-152).
NalScan ScanNal(const uint8_t* payload, size_t len, bool is_hevc) {
    NalScan scan;
    scan.ranges = ScanNalRanges(payload, len);
    scan.types.reserve(scan.ranges.size());
    for (const auto& [start, end] : scan.ranges) {
        if (start >= end) {
            scan.types.push_back(0); // unreachable: ranges are non-empty (nal.rs:141-143)
            continue;
        }
        scan.types.push_back(is_hevc ? static_cast<uint8_t>((payload[start] >> 1) & 0x3F)
                                     : static_cast<uint8_t>(payload[start] & 0x1F));
    }
    return scan;
}

// parse_nal_stats_from_scan (nal.rs:154-233). The per-range first
// read_ue()'s value is only checked for Some, never used (nal.rs:187-188,
// 209-210) - first_mb_in_slice / slice_pic_parameter_set_id discarded.
NalStats ParseNalStatsFromScan(const uint8_t* payload, size_t len, const NalScan& scan,
                               bool is_hevc) {
    (void)len; // ranges index into payload; len only bounds them (nal.rs:163)
    NalStats stats;
    for (const auto& [start, end] : scan.ranges) {
        const uint8_t* nal = payload + start;
        const size_t nal_len = end - start;
        if (nal_len == 0) continue;
        if (is_hevc) {
            if (nal_len < 2) continue;
            // forbidden(1) | nal_type(6) | nuh_layer_id(6) | nuh_temporal_id_plus1(3)
            const uint8_t nal_type = static_cast<uint8_t>((nal[0] >> 1) & 0x3F);
            switch (nal_type) {
                case 32: stats.pps += 1; break; // VPS - folded into pps per spec
                case 33: stats.sps += 1; break;
                case 34: stats.pps += 1; break;
                case 39:
                case 40: stats.sei += 1; break;
                case 19:
                case 20:
                    stats.idr += 1;
                    stats.i_slices += 1;
                    break;
                case 0:
                case 1: {
                    stats.non_idr_slice += 1;
                    // slice_segment_header: pps_id(ue), then slice_type(ue).
                    // HEVC slice_type is 0=B, 1=P, 2=I (no mod).
                    BitReader reader(nal + 2, nal_len - 2);
                    if (reader.ReadUe().has_value()) {
                        const auto st = reader.ReadUe();
                        if (st.has_value()) {
                            switch (*st) {
                                case 0: stats.b_slices += 1; break;
                                case 1: stats.p_slices += 1; break;
                                case 2: stats.i_slices += 1; break;
                                default: break;
                            }
                        }
                    }
                    break;
                }
                default: break;
            }
        } else {
            // forbidden(1) | nal_ref_idc(2) | nal_unit_type(5)
            const uint8_t nal_type = static_cast<uint8_t>(nal[0] & 0x1F);
            switch (nal_type) {
                case 1: {
                    stats.non_idr_slice += 1;
                    // slice_header: first_mb_in_slice(ue), slice_type(ue).
                    // slice_type % 5: 0=P, 1=B, 2=I, 3=SP, 4=SI (H.264 7.4.3).
                    BitReader reader(nal + 1, nal_len - 1);
                    if (reader.ReadUe().has_value()) {
                        const auto st = reader.ReadUe();
                        if (st.has_value()) {
                            switch (*st % 5) {
                                case 0: stats.p_slices += 1; break;
                                case 1: stats.b_slices += 1; break;
                                case 2: stats.i_slices += 1; break;
                                default: break;
                            }
                        }
                    }
                    break;
                }
                case 5:
                    stats.idr += 1;
                    stats.i_slices += 1;
                    break;
                case 6: stats.sei += 1; break;
                case 7: stats.sps += 1; break;
                case 8: stats.pps += 1; break;
                case 9: stats.aud += 1; break;
                default: break;
            }
        }
    }
    return stats;
}

} // namespace nal
