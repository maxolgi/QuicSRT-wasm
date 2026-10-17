// The M5 audio metering DSP: crates/mpeg2ts-wasm/src/meter.rs (the oracle)
// ported 1:1. The Rust IS the spec - every numeric quirk is mirrored, not
// fixed (float parity policy: plan-notes/meter-parity.md):
//
//   - f32/f64 split (meter-parity.md 1/2): PCM arrives as f32 (already
//     bit-gated by the aes3 port); every accumulation widens to f64 at the
//     same points as Rust (`sample as f64`, phase l/r widening, fft_ring
//     `as f64 * w`), and results narrow to f32 exactly at the four
//     documented cast points (Lufs/Rms returns, DisplayCorrelation return,
//     band dB). peaks/scope stay pure f32 copies; rms/phase are
//     order-sensitive f64 chains (bit-identical given mirrored order and
//     -ffp-contract=off); lufs/spectrum cross libm (log10/sin/cos/pow) and
//     are compared tolerant at abs 1e-6 dB with the -70/-80 sentinels as
//     literals.
//   - K-weighting coefficients are f64 decimal literals copied verbatim
//     (meter.rs:18-28) - never recomputed from the analog prototype; both
//     sign conventions carry their own signs into `... - B1*y1 - B2*y2`.
//     Direct Form I, per-sample state, never reset (only PidMeter
//     re-creation on a channel-count change resets anything).
//   - Clip runs count ONCE when the run reaches CLIP_RUN=3 (`>= 0.999f`
//     is an f32 compare in Rust - the literal infers f32 from abs_s; the
//     C++ must spell the f suffix or the compare widens to f64).
//   - LUFS (meter.rs:108-150) is NOT BS.1770 proper: per-channel, 4x100 ms
//     non-overlapping block ring averaged as one window, dividing by
//     FILLED samples (filled_blocks*4800 + block_samples), floor -70.0 on
//     zero fill or mean_sq < 1e-12. The ring sums fold in slot order
//     starting at 0.0, then add the open partial block.
//   - Phase display (meter.rs:235-244): the 12 ring slots re-sum in index
//     order (independent 0.0-start folds), `lr / (sqrt(ll*rr) + 1e-12)`,
//     clamp [-1,1], cast f32; held re-emitted when the ring is empty or
//     ll/rr <= 0. Windows are pushed by Snapshot() only when non-empty -
//     empty windows neither age nor alter the ring.
//   - Snapshot() is part of the state machine (meter.rs:419-485): per
//     channel with samples it latches held_peak/held_rms and resets the
//     window; per pair with samples it pushes the window into the ring.
//     PIDs iterate ascending; scope/spectrum come from the selected PID
//     (or the lowest PID when the selection points at a gone PID), else
//     the documented empty shapes (256x0.0 / 64x-80.0).
//   - Scope/FFT rings advance only for the selected PID/channel; the scope
//     partner is `sel_ch ^ 1` (same channel when ch==1); rings are NEVER
//     cleared on selection change - stale samples persist until
//     overwritten. Scope() reads the rotation oldest->newest, pure copy.
//   - Spectrum (meter.rs:329-368): de-rotate the 1024 ring to
//     chronological order, symmetric Hann window with denominator
//     FFT_SIZE-1 = 1023 (NOT the periodic variant), then the hand-rolled
//     iterative radix-2 DIT FFT below (verbatim port, ~45 lines: no
//     library, no twiddle tables - a table or crate FFT changes the error
//     profile), magnitudes 0..512, 64 log-spaced bands over bins 1..511
//     with edges[0]=1, `edges[b] = max(edges[b-1]+1, floor(512^(b/64)))`
//     (the Rust loop runs b=1..=64 and then forces edges[64]=512), per
//     band `hi = min(max(edges[b+1], lo+1), 512)`, max-magnitude bin ->
//     `20*log10(max_mag + 1e-12)` as f32, default -80.0.

#include "meter.h"

#include <algorithm>
#include <cmath>

namespace meter {
namespace {

// meter.rs:18-28 - verbatim f64 decimal literals (clang and rustc both
// round decimal literals correctly to the same f64 bits).
constexpr double KW1_A0 = 1.53512485958697;
constexpr double KW1_A1 = -2.69169618940638;
constexpr double KW1_A2 = 1.19839281085285;
constexpr double KW1_B1 = -1.69065929318241;
constexpr double KW1_B2 = 0.73248077421585;

constexpr double KW2_A0 = 1.0;
constexpr double KW2_A1 = -2.0;
constexpr double KW2_A2 = 1.0;
constexpr double KW2_B1 = -1.99004745483398;
constexpr double KW2_B2 = 0.99007225036621;

constexpr double K_PI = 3.141592653589793; // std::f64::consts::PI, same bits

// meter.rs:488-534, ported verbatim: iterative radix-2 DIT complex FFT.
// Bit-reversal permutation first, then stages len=2,4,...,1024 - one
// twiddle (cos,sin) per stage, advanced inside each block by complex
// multiplication with the stage twiddle (no per-index trig, no tables).
void FftInplace(double* re, double* im) {
    const size_t n = FFT_SIZE;
    const size_t half = n / 2;

    size_t j = 0;
    for (size_t i = 1; i < n; i++) {
        size_t bit = half;
        while ((j & bit) != 0) {
            j &= ~bit;
            bit >>= 1;
        }
        j |= bit;
        if (i < j) {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }

    size_t len = 2;
    while (len <= n) {
        const size_t half_len = len / 2;
        const double angle = -2.0 * K_PI / static_cast<double>(len);
        const double w_re = std::cos(angle);
        const double w_im = std::sin(angle);

        size_t i = 0;
        while (i < n) {
            double wr = 1.0;
            double wi = 0.0;
            for (size_t k = 0; k < half_len; k++) {
                const size_t idx1 = i + k;
                const size_t idx2 = i + k + half_len;
                const double tr = wr * re[idx2] - wi * im[idx2];
                const double ti = wr * im[idx2] + wi * re[idx2];
                re[idx2] = re[idx1] - tr;
                im[idx2] = im[idx1] - ti;
                re[idx1] += tr;
                im[idx1] += ti;
                const double next_wr = wr * w_re - wi * w_im;
                wi = wr * w_im + wi * w_re;
                wr = next_wr;
            }
            i += len;
        }
        len <<= 1;
    }
}

} // namespace

// ---- ChannelMeter ------------------------------------------------------------

void ChannelMeter::Update(float sample) {
    const float abs_s = std::fabs(sample);
    if (abs_s > peak) {
        peak = abs_s;
    }
    sum_sq += static_cast<double>(sample) * static_cast<double>(sample);
    sample_count += 1;
    if (abs_s >= 0.999f) { // f32 compare (Rust infers f32 from abs_s)
        clip_run = clip_run == UINT32_MAX ? UINT32_MAX : clip_run + 1; // saturating_add
        if (clip_run == CLIP_RUN) {
            clip_count += 1;
        }
    } else {
        clip_run = 0;
    }

    const double x = static_cast<double>(sample);
    const double y1 = KW1_A0 * x + KW1_A1 * kw1_x1 + KW1_A2 * kw1_x2 - KW1_B1 * kw1_y1 -
                      KW1_B2 * kw1_y2;
    kw1_x2 = kw1_x1;
    kw1_x1 = x;
    kw1_y2 = kw1_y1;
    kw1_y1 = y1;

    const double y2 = KW2_A0 * y1 + KW2_A1 * kw2_x1 + KW2_A2 * kw2_x2 - KW2_B1 * kw2_y1 -
                      KW2_B2 * kw2_y2;
    kw2_x2 = kw2_x1;
    kw2_x1 = y1;
    kw2_y2 = kw2_y1;
    kw2_y1 = y2;

    const double weighted = y2 * y2;
    lufs_block_sum += weighted;
    lufs_block_samples += 1;
    if (lufs_block_samples >= LUFS_BLOCK_SAMPLES) {
        lufs_blocks[lufs_block_idx] = lufs_block_sum;
        lufs_block_idx = (lufs_block_idx + 1) % LUFS_BLOCKS;
        lufs_block_sum = 0.0;
        lufs_block_samples = 0;
        if (lufs_filled_blocks < LUFS_BLOCKS) {
            lufs_filled_blocks += 1;
        }
    }
}

float ChannelMeter::Lufs() const {
    double total = 0.0; // iter().sum(): sequential fold, slot order, 0.0 start
    for (size_t i = 0; i < LUFS_BLOCKS; i++) total += lufs_blocks[i];
    total += lufs_block_sum;
    const size_t filled = lufs_filled_blocks * LUFS_BLOCK_SAMPLES + lufs_block_samples;
    if (filled == 0) {
        return -70.0f;
    }
    const double mean_sq = total / static_cast<double>(filled);
    if (mean_sq < 1e-12) {
        return -70.0f;
    }
    return static_cast<float>(-0.691 + 10.0 * std::log10(mean_sq));
}

float ChannelMeter::Rms() const {
    if (sample_count == 0) {
        return 0.0f;
    }
    return static_cast<float>(std::sqrt(sum_sq / static_cast<double>(sample_count)));
}

void ChannelMeter::ResetWindow() {
    peak = 0.0f;
    sum_sq = 0.0;
    sample_count = 0;
}

// ---- PhaseState ---------------------------------------------------------------

void PhaseState::Update(float l, float r) {
    const double lf = static_cast<double>(l);
    const double rf = static_cast<double>(r);
    sum_lr += lf * rf;
    sum_ll += lf * lf;
    sum_rr += rf * rf;
    count += 1;
}

void PhaseState::PushWindow() {
    ring_lr[ring_idx] = sum_lr;
    ring_ll[ring_idx] = sum_ll;
    ring_rr[ring_idx] = sum_rr;
    ring_idx = (ring_idx + 1) % PHASE_SLOTS;
    if (ring_filled < PHASE_SLOTS) {
        ring_filled += 1;
    }
    sum_lr = 0.0;
    sum_ll = 0.0;
    sum_rr = 0.0;
    count = 0;
}

float PhaseState::DisplayCorrelation() const {
    double lr = 0.0; // each ring folds independently, index order, 0.0 start
    double ll = 0.0;
    double rr = 0.0;
    for (size_t i = 0; i < PHASE_SLOTS; i++) {
        lr += ring_lr[i];
        ll += ring_ll[i];
        rr += ring_rr[i];
    }
    if (ring_filled == 0 || ll <= 0.0 || rr <= 0.0) {
        return held;
    }
    const double c = lr / (std::sqrt(ll * rr) + 1e-12);
    return static_cast<float>(c < -1.0 ? -1.0 : (c > 1.0 ? 1.0 : c));
}

// ---- PidMeter ------------------------------------------------------------------

PidMeter::PidMeter(uint8_t channel_count)
    : channel_count(channel_count),
      channels(channel_count),
      phase_pairs(channel_count / 2),
      scope_ring_l(SCOPE_SIZE, 0.0f),
      scope_ring_r(SCOPE_SIZE, 0.0f),
      fft_ring(FFT_SIZE, 0.0f) {}

void PidMeter::Update(const float* samples, size_t len, int64_t pts, bool selected,
                      uint8_t sel_ch) {
    pes_count += 1;
    last_pts = pts;
    const size_t ch = channel_count;
    if (ch == 0 || len < ch) {
        return;
    }
    const size_t frames = len / ch;

    for (size_t i = 0; i < frames; i++) {
        const size_t base = i * ch;
        for (size_t c = 0; c < ch; c++) {
            channels[c].Update(samples[base + c]);
        }
        for (size_t p = 0; p < phase_pairs.size(); p++) {
            const size_t li = base + p * 2;
            const size_t ri = li + 1;
            if (ri < base + ch) {
                phase_pairs[p].Update(samples[li], samples[ri]);
            }
        }
    }

    if (selected && static_cast<size_t>(sel_ch) < ch) {
        // Stereo pair partner: L=0/R=1, L=2/R=3, ... (same channel when
        // ch==1). Both rings advance per frame; stale samples persist
        // across selection changes (rings are never cleared).
        const size_t partner = ch > 1 ? static_cast<size_t>(sel_ch ^ 1)
                                      : static_cast<size_t>(sel_ch);
        for (size_t i = 0; i < frames; i++) {
            const size_t base = i * ch;
            scope_ring_l[scope_idx] = samples[base + sel_ch];
            scope_ring_r[scope_idx] = samples[base + partner];
            scope_idx = (scope_idx + 1) % SCOPE_SIZE;
            fft_ring[fft_idx] = samples[base + sel_ch];
            fft_idx = (fft_idx + 1) % FFT_SIZE;
        }
    }
}

std::pair<std::vector<float>, std::vector<float>> PidMeter::Scope() const {
    std::vector<float> l;
    std::vector<float> r;
    l.reserve(SCOPE_SIZE);
    r.reserve(SCOPE_SIZE);
    for (size_t i = 0; i < SCOPE_SIZE; i++) {
        const size_t idx = (scope_idx + i) % SCOPE_SIZE; // oldest -> newest
        l.push_back(scope_ring_l[idx]);
        r.push_back(scope_ring_r[idx]);
    }
    return {std::move(l), std::move(r)};
}

std::vector<float> PidMeter::Spectrum() const {
    double re[FFT_SIZE] = {};
    double im[FFT_SIZE] = {};
    for (size_t i = 0; i < FFT_SIZE; i++) {
        const size_t idx = (fft_idx + i) % FFT_SIZE; // de-rotate: chronological
        const double w =
            0.5 - 0.5 * std::cos(2.0 * K_PI * static_cast<double>(i) /
                                 (static_cast<double>(FFT_SIZE) - 1.0)); // Hann, N-1
        re[i] = static_cast<double>(fft_ring[idx]) * w;
    }
    FftInplace(re, im);

    const size_t half = FFT_SIZE / 2;
    double mags[512] = {};
    for (size_t i = 0; i < half; i++) {
        mags[i] = std::sqrt(re[i] * re[i] + im[i] * im[i]);
    }

    size_t edges[65];
    edges[0] = 1; // DC skipped
    for (size_t b = 1; b <= 64; b++) {
        const size_t edge =
            static_cast<size_t>(std::floor(std::pow(512.0, static_cast<double>(b) / 64.0)));
        edges[b] = std::max(edges[b - 1] + 1, edge);
    }
    edges[64] = 512;

    std::vector<float> bins(64, -80.0f);
    for (size_t b = 0; b < 64; b++) {
        const size_t lo = edges[b];
        const size_t hi = std::min(std::max(edges[b + 1], lo + 1), half);
        double max_mag = 0.0;
        for (size_t i = lo; i < hi; i++) {
            if (mags[i] > max_mag) {
                max_mag = mags[i];
            }
        }
        const double db = 20.0 * std::log10(max_mag + 1e-12);
        bins[b] = static_cast<float>(db);
    }
    return bins;
}

// ---- MeterState -----------------------------------------------------------------

void MeterState::Update(uint16_t pid, const float* samples, size_t len, uint8_t channel_count,
                        int64_t pts) {
    if (selected_pid == 0 || pids_.find(selected_pid) == pids_.end()) {
        selected_pid = pid; // auto-lock (meter.rs:404-406)
    }
    const bool selected = pid == selected_pid;
    const uint8_t sel_ch = selected_channel;
    auto it = pids_.find(pid);
    if (it == pids_.end()) {
        it = pids_.emplace(pid, PidMeter(channel_count)).first;
    } else if (it->second.channel_count != channel_count) {
        it->second = PidMeter(channel_count); // full state reset
    }
    it->second.Update(samples, len, pts, selected, sel_ch);
}

MeterSnapshot MeterState::Snapshot() {
    std::vector<uint16_t> pids;
    pids.reserve(pids_.size());
    for (const auto& kv : pids_) pids.push_back(kv.first);
    std::sort(pids.begin(), pids.end()); // sort_unstable

    MeterSnapshot s;
    for (uint16_t pid : pids) {
        PidMeter& meter = pids_.at(pid);
        s.channel_counts.push_back(meter.channel_count);
        for (ChannelMeter& ch : meter.channels) {
            if (ch.sample_count > 0) {
                ch.held_peak = ch.peak;
                ch.held_rms = ch.Rms();
                ch.ResetWindow();
            }
            s.peaks.push_back(ch.held_peak);
            s.rms.push_back(ch.held_rms);
            s.clips.push_back(ch.clip_count);
            s.lufs.push_back(ch.Lufs());
        }
        for (PhaseState& pair : meter.phase_pairs) {
            if (pair.count > 0) {
                pair.PushWindow();
            }
            const float c = pair.DisplayCorrelation();
            pair.held = c;
            s.phase.push_back(c);
        }
    }

    const uint16_t scope_pid = pids_.find(selected_pid) != pids_.end()
                                   ? selected_pid
                                   : (!pids.empty() ? pids.front() : 0);
    const auto it = pids_.find(scope_pid);
    if (it != pids_.end()) {
        auto [l, r] = it->second.Scope();
        s.scope_l = std::move(l);
        s.scope_r = std::move(r);
        s.spectrum = it->second.Spectrum();
    } else {
        s.scope_l.assign(SCOPE_SIZE, 0.0f);
        s.scope_r.assign(SCOPE_SIZE, 0.0f);
        s.spectrum.assign(64, -80.0f);
    }

    s.pids = std::move(pids);
    s.selected_pid = selected_pid;
    s.selected_channel = selected_channel;
    return s;
}

} // namespace meter
