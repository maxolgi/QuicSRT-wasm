# meter.rs → C++ port: float-parity policy

Source of truth: `~/maxolgi/WebSRT/crates/mpeg2ts-wasm/src/meter.rs` (809 lines, all line refs
below are `meter.rs` unless prefixed). Driver: `lib.rs:743-753` (per 302M PES), `lib.rs:1532-1548`
(`meter_snapshot()`), `lib.rs:1550-1554` (`setMeterSelection`). This doc is the M5 step-5
(PLAN.md:85) parity gate: per-field exactness policy agreed **before** the port starts. It refines
the PLAN.md:67-68 sketch ("meter floats rel 1e-6, everything else exact") into per-field buckets.

## 0. Execution model (how lib.rs drives it)

- `TsDemuxer` owns one `MeterState` for its lifetime (lib.rs:474-475, 502). **Stateful across
  events and across snapshots** — K-weighting filter state, LUFS block ring, phase ring, scope/FFT
  rings all persist.
- Drive point: inside PES handling, when the PID is a SMPTE 302M PID, the AES3 payload is decoded
  to interleaved f32 and `meter_state.update(pid, &samples, channel_count, pts)` is called once
  **per PCM PES packet** (lib.rs:743-751). Channel count comes from the AES3 header, fallback 2
  (lib.rs:746-748). So the meter sees one `update()` per PES with a burst of interleaved frames.
- `MeterState::update` (403-417): auto-selects the first PID as `selected_pid` while none is
  selected (404-406); a PidMeter is created per PID; if `channel_count` changes for an existing
  PID the whole `PidMeter` is **re-created from scratch** (413-415) — all LUFS/phase/clip state
  resets. Scope/FFT rings only advance when `pid == selected_pid` (407, 302-315).
- `MeterState::snapshot()` (419-485) is **mutating, part of the state machine, not an observer**:
  per channel with `sample_count > 0` it latches `held_peak`/`held_rms` and resets the peak/RMS
  window (433-438); per phase pair with `count > 0` it pushes the window into the 12-slot ring
  (444-447). Empty windows hold previous values by design (40-45, 714-738). Parity checkpoints
  must therefore replay an *identical interleaving* of `update()` and `snapshot()` calls on both
  sides (§3).

Input assumption: PCM f32 samples are already gated **bit-identical** by M5 step 3 (PLAN.md:82-83),
so every divergence below is attributable to the meter port alone.

## 1. Algorithm inventory (reproducible from this section alone)

Constants: `SAMPLE_RATE=48000`, `LUFS_BLOCK_SAMPLES=4800` (100 ms), `LUFS_BLOCKS=4` (400 ms
window), `PHASE_SLOTS=12`, `CLIP_RUN=3`, `FFT_SIZE=1024`, `SCOPE_SIZE=256` (9-16).

### 1.1 Peak, clip, RMS (ChannelMeter::update, 92-106; rms, 152-157)

Per sample (f32): `abs_s = |x|`; `peak = max(peak, abs_s)` (93-96). Clip detection: `abs_s >= 0.999`
extends a run counter; when the run reaches exactly `CLIP_RUN=3`, `clip_count += 1` **once per
run**; any sub-threshold sample zeroes the run (99-106; semantics documented 35-39). RMS: f64
accumulator `sum_sq += (x as f64)^2` per sample in arrival order, `sample_count += 1` (97-98);
`rms() = sqrt(sum_sq / count) as f32`, 0.0 when count==0 (152-157). Window reset (peak, sum_sq,
count only) happens in `snapshot()` (159-163, 433-438); `held_peak`/`held_rms` re-emit across empty
windows (40-45, 439-440).

### 1.2 LUFS — simplified BS.1770, **no true gating** (108-150)

Two cascaded Direct-Form-I biquads per sample, **all f64**, coefficients are f64 decimal literals
(18-28), evaluated in exactly this order:

- Stage 1 (high shelf): `y1 = KW1_A0*x + KW1_A1*x1 + KW1_A2*x2 - KW1_B1*y1' - KW1_B2*y2'` with
  `A0=1.53512485958697, A1=-2.69169618940638, A2=1.19839281085285, B1=-1.69065929318241,
  B2=0.73248077421585`; then shift x2←x1, x1←x, y2'←y1', y1'←y1 (108-115).
- Stage 2 (high-pass): `y2 = 1.0*y1 + (-2.0)*x1 + 1.0*x2 - KW2_B1*y1' - KW2_B2*y2'` with
  `B1=-1.99004745483398, B2=0.99007225036621`; same state shift, x-history fed with y1 (117-123).
- Mean square accumulation: `lufs_block_sum += y2*y2` (f64), one counter per 4800 samples; on
  reaching 4800 the sum is stored into a 4-slot ring (`lufs_blocks[idx]`, idx wraps mod 4), sum
  resets, `lufs_filled_blocks` saturates at 4 (125-136). Filter state is **never** reset except by
  PidMeter re-creation (413-415).
- `lufs()` (139-150): `total = Σ lufs_blocks[0..4] (left-to-right array order) +
  lufs_block_sum`; `filled = filled_blocks*4800 + block_samples`; if `filled==0` → literal `-70.0`;
  `mean_sq = total/filled`; if `mean_sq < 1e-12` → literal `-70.0`; result
  `(-0.691 + 10.0 * mean_sq.log10()) as f32`.

Not BS.1770 proper: per-channel (no Σ-channel G weighting), 4×100 ms non-overlapping block ring
averaged as one 400 ms window, divisor is *filled* samples not full window (comment 58-61), the
only "gating" is the `mean_sq < 1e-12 → -70.0` floor (146-148). No momentary/short-term split.

### 1.3 Phase correlation (PhaseState, 166-245)

Per frame per stereo pair p (channels 2p, 2p+1, guarded `ri < base+ch`, 293-299): f64
accumulators `sum_lr += l*r`, `sum_ll += l*l`, `sum_rr += r*r`, `count += 1` with l,r widened
from f32 (201-208). Instantaneous `correlation()` (210-217) is test-only (used 615, 625); the
snapshot field is `display_correlation()` (235-244): sums of the 12 ring slots **in array index
order** (236-238; `iter().sum()` is strictly sequential), `c = ring_lr / (sqrt(ring_ll*ring_rr) +
1e-12)`, clamp [-1,1], cast f32. Window push (snapshot side effect, 444-447, 220-232): only when
`count > 0`; current sums overwrite `ring[idx]`, idx wraps mod 12, `ring_filled` saturates at 12,
window accumulators reset. Empty windows neither age nor alter the ring (171-174, 239-241 returns
`held` when ll/rr ≤ 0).

### 1.4 Scope + FFT spectrum (PidMeter::update 302-315, scope 318-327, spectrum 329-368)

Rings (selected PID only, 407): per frame, `scope_ring_l[idx]=samples[sel_ch]`,
`scope_ring_r[idx]=samples[sel_ch^1]` (stereo partner, 303-306), both rings advance mod their
sizes; `fft_ring[fft_idx]=samples[sel_ch]` mod 1024 (307-314). Rings are **not** cleared on
selection change — stale samples persist until overwritten.

`scope()` (318-327): 256 f32 values read starting at `scope_idx` (oldest→newest rotation) — pure
copy, no math.

`spectrum()` (329-368), all f64 internally:
1. De-rotate: `re[i] = fft_ring[(fft_idx+i) % 1024]` — chronological order regardless of ring
   position (332-337).
2. Window: symmetric Hann on N=1024 with denominator **N−1=1023** (not the periodic variant):
   `w = 0.5 − 0.5·cos(2π·i/1023)`, applied `re[i] = sample·w` (334-336). `im[i]=0`.
3. `fft_inplace(re, im)` (488-534): hand-rolled iterative radix-2 DIT complex FFT, N=1024.
   Bit-reversal permutation first (492-504); then stages len=2,4,…,1024: per stage a single
   twiddle `angle = −2π/len`, `w_re=cos(angle)`, `w_im=sin(angle)` (509-511); inside each block
   the running twiddle `(wr,wi)` starts at (1,0) and is advanced **by complex multiplication with
   (w_re,w_im) per butterfly** — no per-index trig, no tables (515-528); butterfly:
   `tr=wr·re2−wi·im2; ti=wr·im2+wi·re2; re2=re1−tr; im2=im1−ti; re1+=tr; im1+=ti` (520-525).
4. Magnitudes: `mags[i] = sqrt(re[i]²+im[i]²)` for i in 0..512 (340-344).
5. Band edges: `edges[0]=1` (DC skipped); `edges[b] = max(edges[b−1]+1, floor(512^(b/64)))` for
   b=1..63; forced `edges[64]=512` (346-352). 64 log-spaced bands over bins 1..511.
6. Per band b: `lo=edges[b]`, `hi=max(edges[b+1], lo+1)` capped at 512 (356-357); `max_mag` =
   max over [lo,hi) (358-363); `bins[b] = (20·log10(max_mag + 1e-12)) as f32`, default −80.0
   (354, 364-365).

### 1.5 Snapshot assembly (419-485)

PIDs sorted ascending (420-421); flat arrays concatenated per PID then per channel/pair; scope and
spectrum come only from the selected PID (or first PID if selection absent, 455-459); missing →
`scope=vec![0.0;256]`, `spectrum=vec![−80.0;64]` (464-468). View fields (lib.rs:1303-1316):
`pids: u16[], channel_counts: u8[], peaks: f32[], rms: f32[], clips: u32[], lufs: f32[],
phase: f32[], scope_l: f32[], scope_r: f32[], spectrum: f32[], selected_pid: u16,
selected_channel: u8` — 12 fields.

## 2. Per-field parity policy

Rust f64 usage: **yes, pervasive** — sum_sq (32), all K-weighting + LUFS state (46-57), phase sums
(167-170, 175-177), spectrum re/im/mags/window/edges (330-341, 334-335, 349). Transcendentals:
`cos`/`sin` at 335 (Hann) and 510-511 (stage twiddles), `powf` at 349 (edges), `log10` at 149
(LUFS) and 364 (band dB). `sqrt` (156, 214, 242, 343) is IEEE-exact everywhere (single
correctly-rounded instruction on any sane target, incl. wasm) and does **not** force tolerance.
The real cross-implementation risk: on wasm32-unknown-unknown Rust std bundles its own libm
(no libc), while Emscripten C++ calls musl — `sin/cos/log10/powf` may differ in the last ulp
between the two modules. Only the two fields below transit through those functions.

| Field | Bucket | Why |
|---|---|---|
| `pids` | EXACT-BIT | integer keys, sorted (420-421) |
| `channel_counts` | EXACT-BIT | integer copy (432) |
| `peaks` | EXACT-BIT | f32 abs + compare + held-latch, no arithmetic (93-96, 435, 439) |
| `clips` | EXACT-BIT | integer counters; `abs_s >= 0.999` exact f32 compare (99-106) |
| `rms` | EXACT-ORDER-SENSITIVE | f64 `sum_sq` accumulated per-sample in arrival order (97), then one divide + one sqrt, both correctly rounded (156). Same order ⇒ bit-identical. |
| `lufs` | TOLERANT | deterministic f64 chain (biquads 108-126, block/ring sums 125-141) but final `log10` (149) crosses libm. **Tol: abs 1e-6 dB.** Justification: mirrored order makes `mean_sq` bit-identical, so divergence is ≤ a few libm ulps ≈ 1e-14 dB; 1e-6 dB is ~zero-margin yet catches any real bug (an f32 anywhere in the chain ⇒ ≥1e-3 dB; wrong order/coefs ⇒ more). The −70.0 sentinels (143, 147) must match exactly as literals. |
| `phase` | EXACT-ORDER-SENSITIVE | f64 sums in frame order (204-206), ring re-summed in slot order 0..12 (236-238), then sqrt+div+clamp, all correctly rounded (242-243). Same structure ⇒ bit-identical. |
| `scope_l`/`scope_r` | EXACT-BIT | pure f32 copies in rotation order (318-327); depends only on already-gated PCM + selection state |
| `spectrum` | TOLERANT | Hann `cos` (335), per-stage `sin/cos` + multiplicative twiddle recurrence (509-528), band-edge `powf` (349), `log10` (364). **Tol: abs 1e-6 dB per bin**, plus hard assert: the 65 `edges[]` values match exactly (integer indices). Justification: all error sources are O(100) f64 ulps on O(1) magnitudes ⇒ ≲1e-10 dB; 1e-6 leaves margin for the one discrete effect — a near-tie inside a band flipping which bin supplies `max_mag` (358-363), which shifts that band by the tie gap (still ≪1e-6 dB for genuine ties). |
| `selected_pid`/`selected_channel` | EXACT-BIT | integers (482-483) |

**Bit-identity answer for EXACT-ORDER-SENSITIVE:** yes. `+ − × ÷ sqrt` are all correctly-rounded
IEEE-754 ops; wasm has hardware instructions for them, and neither rustc nor emcc reassociates or
contracts without opt-in. Provided the C++ mirrors: (a) same f32→f64 widening points, (b) same
loop/accumulation order (per-sample, per-frame, per-slot), (c) build flags **without**
`-ffast-math` and with `-ffp-contract=off` (belt-and-braces against FMA contraction), rms and
phase are bit-identical, and lufs/spectrum differ only through the four named libm calls.

Bucket count: **8 EXACT-BIT, 2 EXACT-ORDER-SENSITIVE, 2 TOLERANT** (of 12 fields).

## 3. Test vector spec

- **Level:** drive `MeterState::update(pid, samples, channel_count, pts)` directly on both sides
  (Rust via a tiny native harness or the wasm pkg; C++ via the ported module) — don't go through
  the demux, PCM is already gated bit-identical (PLAN.md:64). Record the golden call log once
  (from the Rust side): ordered list of `update(...)` / `setMeterSelection(...)` /
  `snapshot()` ops. Replay the *identical* interleaving on the C++ side.
- **Checkpoints = snapshot() calls, and their placement is load-bearing** because snapshot()
  mutates: it latches held_peak/held_rms and resets the peak/RMS window (433-438) and pushes
  phase windows into the ring (444-447). Two snapshots at different points in the same feed
  sequence give different downstream LUFS/phase histories even with identical audio — e.g. a
  snapshot between two PES bursts freezes phase ring state that a later snapshot would otherwise
  have overwritten. Both sides must take every snapshot at the *same* position in the op log.
- **Required checkpoint set** (each exercises distinct state):
  1. Early, < 4800 samples — LUFS partial-block divisor path + `-70.0` sentinels (141-148).
  2. 1-3 full blocks — ring partially filled, `lufs_filled_blocks < 4` (133-135).
  3. > 19200 samples — ring wrapped at least once; LUFS steady-state.
  4. Empty window — snapshot twice with no `update()` between: held values must re-emit
     identically (714-738).
  5. Genuine silence — `update()` of all-zero samples after signal: peak must read 0.0 (735-737).
  6. Off-block-boundary — an `update()` ending mid-block, so `lufs_block_sum` is carried into the
     next snapshot's `lufs()` (140).
  7. After `setMeterSelection` mid-stream — scope/spectrum switch source while the rings still
     hold stale samples from the previously selected channel (rings not cleared, 302-315);
     snapshot before *and* after the switch.
  8. `channel_count` change on a live PID — full state reset (413-415); snapshot before/after.
  9. Multi-PID stream — flat-array concatenation order and sorted `pids` (420-431).
- **Comparator:** per-field, three modes (exact-bits / exact-bits-given-mirrored-order = fall
  back to flagging, treat as build-flag bug / tolerance per §2). On a spectrum tolerance failure,
  re-check whether the per-band `max_mag` bin index flipped (near-tie) before suspecting the FFT.
  Dump snapshots as JSON per checkpoint for diffing.

## 4. Port hazards

1. **FFT source:** hand-rolled in-meter iterative radix-2 DIT with bit-reversal + multiplicative
   twiddle recurrence, no crate, no tables (488-534). **Port it verbatim** — same stage order,
   same recurrence, same f64 arrays. A library FFT (different twiddle rounding or factorization)
   would stay inside the 1e-6 dB tolerance, but buys nothing: the verbatim port is ~45 lines,
   keeps errors at the ulp level, and removes an external dependency from the parity argument.
   Do not "improve" it with precomputed twiddle tables — table values change the error profile.
2. **K-weighting coefficients:** f64 decimal literals (18-28). **Copy the literals verbatim into
   C++**; rustc and clang both round decimal literals correctly to nearest f64 ⇒ identical bits.
   Do *not* recompute at init from the analog prototype formulas — different eval order ⇒ ulp
   drift that feeds every subsequent sample through both biquads. Sign convention is unusual:
   constants include their own signs and the code computes `… − B1·y1 − B2·y2` with B1,B2 already
   negative (109-111, 117-119). Keep every multiply in f64, Direct Form I, per-sample state.
3. **Build flags:** no `-ffast-math`; `-ffp-contract=off` (or verify the wasm backend emitted no
   fused ops) — required for the EXACT-ORDER-SENSITIVE bucket to hold.
4. **Windowed/decay state that must match sample-exactly:**
   - peak/RMS window resets only inside `snapshot()` and only when `sample_count > 0`
     (433-438); `held_*` latch semantics (40-45).
   - K-weighting + LUFS block state never resets mid-stream (only via PidMeter re-creation on
     channel-count change, 413-415).
   - LUFS divides by *filled* samples (58-61, 141) and sums the ring in **slot order** then adds
     the partial block (140) — mirror the order.
   - Phase ring: push only on non-empty windows (444-447); ring sums in slot order (236-238);
     `+1e-12` denominator epsilon and clamp in both correlation paths (214-216, 242-243); `held`
     re-emitted when `ring_filled==0 || ll<=0 || rr<=0` (239-241).
   - Clip runs count once when the run *reaches* 3 (101-103); longer runs don't recount.
   - Scope/FFT rings advance for the selected PID/channel only, partner = `sel_ch ^ 1` (303-306),
     rings never cleared on selection change — stale-data behavior must be reproduced, not fixed.
   - Spectrum details easy to get wrong: Hann denominator 1023 (335); DC skipped via
     `edges[0]=1` (347); monotonic edge fix-up `max(prev+1, floor)` (350); forced `edges[64]=512`
     (352); `hi = max(edges[b+1], lo+1).min(512)` (357); `+1e-12` inside log10 (364); default
     −80.0 (354, 467). Edge indices are mathematically ≥ ~1.5e-3 away from integers
     (512^(b/64) = 2^(9b/64), 9b/64 never integral for 0<b<64), so `powf` ulp noise cannot flip a
     `floor` — but assert edges match exactly in the harness anyway (§2).
5. **f32 cast points:** results narrow to f32 exactly at `lufs()` return (149), `rms()` return
   (156), correlation returns (216, 243), and band dB (365). No intermediate f32 anywhere.
