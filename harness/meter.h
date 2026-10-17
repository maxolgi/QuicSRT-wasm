// The M5 audio metering DSP: WebSRT crates/mpeg2ts-wasm/src/meter.rs (the
// oracle) ported 1:1 - per-channel peak/RMS/clip windows, simplified
// BS.1770 K-weighted LUFS (per-channel, 4x100 ms block ring, no true
// gating), stereo-pair phase correlation (12-window ring), and a
// hand-rolled 1024-point FFT spectrum of the selected channel. Internal
// helper of the demux port: ts_demux.cpp calls Update() from finalize_pes
// exactly where lib.rs:743-753 drives meter_state.update, Snapshot() where
// lib.rs:1532-1548 builds the MeterSnapshotView, and assigns
// selected_pid/selected_channel where lib.rs:1550-1554 does. The Rust
// module is crate-internal API, NOT wasm ABI, so nothing here crosses the
// tsd_* C ABI (abi-census.md header note). Numeric quirks are documented
// in meter.cpp; the per-field float parity policy (exact-bit /
// order-sensitive / tolerant buckets and the -ffp-contract=off build
// condition) lives in plan-notes/meter-parity.md.

#ifndef SRTW_METER_H
#define SRTW_METER_H

#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <utility>
#include <vector>

namespace meter {

constexpr size_t SAMPLE_RATE = 48000;
constexpr size_t LUFS_BLOCK_SAMPLES = SAMPLE_RATE / 10; // 100 ms
constexpr size_t LUFS_BLOCKS = 4;                       // 400 ms window
constexpr size_t PHASE_SLOTS = 12;
constexpr uint32_t CLIP_RUN = 3; // full-scale samples that constitute a clip
constexpr size_t FFT_SIZE = 1024;
constexpr size_t SCOPE_SIZE = 256;

// Per-channel meter (meter.rs:30-163): peak/RMS window, clip counter, and
// the K-weighting chain feeding the LUFS block ring. All filtering runs in
// f64; results narrow to f32 exactly at the Rms()/Lufs() returns.
struct ChannelMeter {
    float peak = 0.0f;
    double sum_sq = 0.0;
    uint64_t sample_count = 0;
    uint32_t clip_count = 0;
    uint32_t clip_run = 0;
    // Peak/RMS latched at the end of the last window that had samples;
    // empty windows re-emit these instead of 0.
    float held_peak = 0.0f;
    float held_rms = 0.0f;
    // K-weighting biquad state (Direct Form I, f64, never reset).
    double kw1_x1 = 0.0, kw1_x2 = 0.0, kw1_y1 = 0.0, kw1_y2 = 0.0;
    double kw2_x1 = 0.0, kw2_x2 = 0.0, kw2_y1 = 0.0, kw2_y2 = 0.0;
    double lufs_blocks[LUFS_BLOCKS] = {0.0, 0.0, 0.0, 0.0};
    size_t lufs_block_idx = 0;
    size_t lufs_block_samples = 0;
    double lufs_block_sum = 0.0;
    size_t lufs_filled_blocks = 0; // saturates at LUFS_BLOCKS

    void Update(float sample); // meter.rs:92-137
    float Lufs() const;        // meter.rs:139-150
    float Rms() const;         // meter.rs:152-157
    void ResetWindow();        // meter.rs:159-163 (snapshot side effect)
};

// One stereo-pair phase window + its 12-slot display ring (meter.rs:166-245).
struct PhaseState {
    double sum_lr = 0.0;
    double sum_ll = 0.0;
    double sum_rr = 0.0;
    uint64_t count = 0;
    double ring_lr[PHASE_SLOTS] = {};
    double ring_ll[PHASE_SLOTS] = {};
    double ring_rr[PHASE_SLOTS] = {};
    size_t ring_idx = 0;
    size_t ring_filled = 0;
    float held = 0.0f;

    void Update(float l, float r);         // meter.rs:201-208
    void PushWindow();                     // meter.rs:220-232 (snapshot side effect)
    float DisplayCorrelation() const;      // meter.rs:235-244
};

// One 302M PID's meter set (meter.rs:247-368).
struct PidMeter {
    uint8_t channel_count = 0;
    std::vector<ChannelMeter> channels;
    uint64_t pes_count = 0;
    int64_t last_pts = -1;
    std::vector<PhaseState> phase_pairs;
    std::vector<float> scope_ring_l; // SCOPE_SIZE, f32 samples of sel ch
    std::vector<float> scope_ring_r; // SCOPE_SIZE, sel ch's pair partner
    size_t scope_idx = 0;
    std::vector<float> fft_ring; // FFT_SIZE, f32 samples of sel ch
    size_t fft_idx = 0;

    explicit PidMeter(uint8_t channel_count); // meter.rs:261-277
    // meter.rs:279-316. selected/sel_ch gate the scope/FFT rings only -
    // rings are never cleared on selection change (stale samples persist).
    void Update(const float* samples, size_t len, int64_t pts, bool selected,
                uint8_t sel_ch);
    std::pair<std::vector<float>, std::vector<float>> Scope() const; // meter.rs:318-327
    std::vector<float> Spectrum() const;                            // meter.rs:329-368
};

// The flattened snapshot (meter.rs:371-384): per-PID-concatenated channel
// arrays, scope/spectrum of the selected PID only.
struct MeterSnapshot {
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
    uint16_t selected_pid = 0;
    uint8_t selected_channel = 0;
};

class MeterState {
public:
    // meter.rs:403-417: auto-lock the first (or re-lock a gone) selection,
    // create the PID's meter, re-create it from scratch when its channel
    // count changes.
    void Update(uint16_t pid, const float* samples, size_t len, uint8_t channel_count,
                int64_t pts);
    // meter.rs:419-485 - MUTATING (latches held peaks/RMS, resets windows,
    // pushes phase windows), exactly like the Rust original.
    MeterSnapshot Snapshot();

    uint16_t selected_pid = 0;
    uint8_t selected_channel = 0;

private:
    std::unordered_map<uint16_t, PidMeter> pids_;
};

} // namespace meter

#endif // SRTW_METER_H
