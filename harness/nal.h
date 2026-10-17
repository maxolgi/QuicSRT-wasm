// The M5 NAL scanner: WebSRT crates/mpeg2ts-wasm/src/nal.rs (the oracle)
// ported 1:1 - Annex-B start-code scanning + slice-type classification
// for the demuxer's per-PES nal tables and per-PID nalStats. Internal
// helper of the demux port (ts_demux.cpp calls it from finalize_pes where
// lib.rs:696-729 calls nal::scan_nal / parse_nal_stats_from_scan): the
// Rust module is crate-internal API, NOT wasm ABI, so nothing here is
// exported through the tsd_* C ABI (abi-census.md header note). Scan
// quirks are documented in nal.cpp.

#ifndef SRTW_NAL_H
#define SRTW_NAL_H

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace nal {

// Per-video-PID accumulated NAL counts (nal.rs:66-79). Flattened into the
// DebugSnapshot's nalStats as 9 values per PID in the order
// I/P/B/IDR/SPS/PPS/SEI/AUD/NonIDR (lib.rs:1431-1444).
struct NalStats {
    uint32_t aud = 0;
    uint32_t sps = 0;
    uint32_t pps = 0;
    uint32_t sei = 0;
    uint32_t idr = 0;
    uint32_t non_idr_slice = 0;
    uint32_t i_slices = 0;
    uint32_t p_slices = 0;
    uint32_t b_slices = 0;
};

// One NAL scan (nal.rs:125-132): start-code ranges + type codes, computed
// in a single pass. ranges: (data_start, data_end) per NAL unit, excluding
// the start-code prefix, consecutive NALs never overlapping, the last one
// running to payload end. types: H.264 low 5 bits of byte 0; HEVC bits 1-6.
struct NalScan {
    std::vector<std::pair<size_t, size_t>> ranges;
    std::vector<uint8_t> types;
};

// Scan Annex B start codes (00 00 01 / 00 00 00 01) once and extract both
// ranges and type codes (nal.rs:134-152). is_hevc: false for stream_type
// 0x1B (H.264), true for 0x24 (HEVC).
NalScan ScanNal(const uint8_t* payload, size_t len, bool is_hevc);

// Accumulate NAL + slice-type statistics from a pre-scanned result
// (nal.rs:154-233) - same logic as a fresh scan, no re-scan. Never throws:
// malformed/truncated NALs count as non_idr_slice without slice
// classification.
NalStats ParseNalStatsFromScan(const uint8_t* payload, size_t len, const NalScan& scan,
                               bool is_hevc);

} // namespace nal

#endif // SRTW_NAL_H
