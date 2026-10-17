# Plan: all-C++ player & publisher (M5–M7)

Status: DRAFT. M1–M4 shipped (loopback gate, replay gate, engine module +
player page, A/B harness). This is the working plan for the remaining Rust
surface; retire the doc when M7 lands. The libwebsrt-side prerequisite for
M6 lives in `~/maxolgi/WebSRT-cpp/libwebsrt/PLAN.md` (run separately).

## Goal / end state

One Emscripten module (`build/srt_engine.mjs`) carries the entire media
pipeline in C++: SRT engine + TS demux + TS mux. No Rust wasm pkg in the
player/publisher runtime. The Rust pkgs (`srt-wasm`, `mpeg2ts-wasm`,
`ts-muxer-wasm`) remain **dev-time oracles only**: parity gates and the M4
A/B harness keep importing them via the `page/wasm` symlink.

Why: today every delivered TS message crosses JS twice and is copied twice
extra (C++ heap → `new Uint8Array` copy in `js/srt_engine.js` → wasm-bindgen
copy into the Rust demuxer's heap → copy back out for WebCodecs). At
~1000 msgs/s that is allocation churn and GC pressure — the jitter tail a
live player cares about. A single module shares one linear memory and hands
PES payloads out as heap views.

## Inventory

| Component | Rust source (oracle) | Size | Destination |
|---|---|---|---|
| Engine receive | `WebSRT/crates/srt-wasm` `SrtReceiver` | — | ✅ done (`harness/receiver.cpp`, `js/srt_engine.js`) |
| Engine publish | `srt-wasm` `SrtReceiver.send_message` | — | ❌ blocked on libwebsrt PLAN (ReceiverCore send path) → M6 |
| TS demux | `mpeg2ts-wasm/src/lib.rs` (1819) + `nal.rs` (233) + `aes3.rs` (342, SMPTE 302M → f32 PCM) | ~2.4k | ❌ M5 → `harness/ts_demux.{h,cpp}`, `harness/nal.*`, `harness/aes3.*` |
| Audio metering | `mpeg2ts-wasm/src/meter.rs` (peak/RMS/LUFS/phase/FFT) | 809 | ❌ M5 → `harness/meter.*` |
| Debug snapshot | `mpeg2ts-wasm` `DebugSnapshot` (~40 accessor arrays) | in lib.rs | ❌ M5 (part of demux port) |
| TS muxer | `ts-muxer-wasm/src/lib.rs` | 227 | ❌ M7 → `harness/ts_muxer.{h,cpp}` |
| Publisher worker/page | `WebSRT/web/src/stream-worker.ts` + `shared/publish.ts` (TS) | TS | ❌ M6/M7 vendoring with import swaps |
| Debug UI (13 files), `decode.ts` SPS/PPS, `render.ts`, `pcm-player.ts` worklet | TS | — | ✅ **no port** — pure TS; runs unmodified once M5 mirrors the `DebugSnapshot`/meter API shapes |

Protocol constants that must not drift: SRT payload 1128 (6×188; negotiated
940 effective), TS packet 188, TSBPD `max(sender, receiver)`.

## Prep notes (research done, no code)

`plan-notes/` holds the execution contracts — read the relevant note before
starting each milestone:

- `abi-census.md` — the complete port contract: 80 items across TsDemuxer /
  TsEvent / DebugSnapshot / meter / TsMuxer, all with file:line cites, the
  COPY/VIEW table, and the APIs no current consumer uses (surface shrink).
- `parity-spec.md` — the golden set: 10 ffmpeg streams + 9 crafted
  corruptions, ~4.03 MB checked in (js/fixtures/manifest.sha256 total),
  regen-script contract, and the per-field
  comparison rules. PCM bit-identity is confirmed achievable (aes3 scales
  are powers of two, no float accumulation). Error-event `text` must be
  canonicalized by stripping the ` (at <path>:<line>)` suffix, harness runs
  with RUST_BACKTRACE unset; wall-clock snapshot fields (ringT/errorT/
  bitratesMbps) are excluded from comparison.
- `meter-parity.md` — per-field exactness: 8 exact-bit, 2 order-sensitive
  (C++ must mirror loop order), 2 tolerant (lufs/spectrum, abs 1e-6 dB).
  The FFT is hand-rolled (meter.rs:488-534) — port it verbatim, no library.
  `snapshot()` is mutating: the harness must replay an identical
  update/snapshot/selection interleave, incl. LUFS block-ring history.
- `debug-consumers.md` — all 49 snapshot fields are consumed (17
  load-bearing); the 10 retention hazards that forced the data-return
  policy above (H3 is the scariest).
- `publisher-surface.md` — M6 contract: `sendMessage` is the ONLY engine
  API missing from `js/srt_engine.js`; vendoring = 2 files + 1 import
  swap; WebSRT pin 854c25c confirmed (same as page/vendor). Known deltas
  to carry, not fix, in the vendored worker: rx-path `free()` is never
  called (per-session leak), tx stats population unverified until M6.

## M5 — C++ TS demuxer + metering (player path, brings the debug tools)

Port the demuxer into the SAME emscripten module as the engine (new exports
on `build/srt_engine.mjs`). ABI mirrors the wasm-bindgen surface exactly so
`page/vendor/demux.ts` becomes a one-line import swap (same pattern as the
`worker.ts` engine swap; record it in `page/README.md` Known deltas):

- `TsDemuxer`: `new()`, `feed(bytes) -> Vec<TsEvent>`
- `TsEvent` accessors: `kind pid pts dts stream_type data text program_num
  random_access_get pmt_entries pmt_format_ids nal_offsets nal_types samples`
- `debugSnapshot() -> DebugSnapshot` (all ~40 arrays; integer counters must
  match exactly)
- `meter_snapshot() -> MeterSnapshotView` (pids, channel_counts, peaks, …)

Data-return policy (corrected by the retention audit in
`plan-notes/debug-consumers.md`): `TsEvent` data/samples/nal arrays stay
**copies** in M5, matching wasm-bindgen semantics. The vendored worker
retains events across `feed()` calls in its `outgoing` queue and
postMessage-**transfers** `data.buffer`/`samples.buffer`/NAL buffers
(worker.ts:363-377) — a heap view's buffer is the whole shared wasm
memory, and transferring it would detach the engine+demux heap mid-stream
(hazard H3). Heap views remain the documented stretch goal, gated on the
vendored worker copying at its queue boundary. Snapshots stay copies. The
single-module win (no second heap, no second JS crossing per message) is
unaffected by this policy.

**Parity harness first** — `js/demux_parity.mjs`, run in node: imports BOTH
the Rust pkg (`page/wasm/mpeg2ts-wasm`, via the symlink) and the C++ module
(`build/srt_engine.mjs`), feeds identical bytes, compares canonicalized
event streams:

- exact match: kind/pid/pts/dts/flags/stream types/program num, PES bytes
  (sha256), `nal_offsets`/`nal_types`, PCM `samples` **bit-identical**
  (integer unpack + scale — achievable, assert it), all DebugSnapshot
  integer counters
- tolerance policy decided up front for meter floats (LUFS/FFT): relative
  1e-6, everything else exact — no silent tolerance

Golden set (checked in under `js/fixtures/` or generated by a committed
script): ffmpeg `testsrc2`+libx264 with keyframe intervals, AAC audio,
`-acodec pcm_s302m` audio (302M path), crafted TEI/CC-error bytes, a
padding-only span, mid-stream join (start feeding at an offset), PAT/PMT
republish mid-stream.

Steps (each its own commit, gate before moving on):

1. Build `js/demux_parity.mjs` and run it **Rust vs Rust** (same pkg both
   sides) → verify: green self-test proves the harness before any C++.
   — ✅ DONE: 2dfb3cb (golden fixtures S1–S10 + gen.sh), 483d2fe (harness,
   Rust-vs-Rust self-test green).
2. Port `nal.rs` → verify: parity green on the H.264 golden streams.
   — ✅ DONE: c9a0dc4 (plus 40e3b05, canonical per-stage exclusion sets).
3. Port `aes3.rs` → verify: parity green on the 302M golden streams
   (bit-identical floats).
   — ✅ DONE: 6ea68e4.
4. Port the `lib.rs` TS core (PAT/PMT/PES reassembly, DebugSnapshot
   counters) → verify: full golden set parity green.
   — ✅ DONE: e910a23.
5. Port `meter.rs` → verify: meter parity within the agreed tolerances.
   — ✅ DONE: 4ecd72f (zero exclusions at `--m5-stage meter`).
6. Wire exports into the engine module (`build.sh engine` sources), swap
   `page/vendor/demux.ts` import → verify: `./build.sh engine &&
   ./build.sh page`, player plays the local `browsertest`/`ab` stream, the
   vendored debug UI renders against `debugSnapshot()`/`meter_snapshot()`
   unmodified.
   — ✅ DONE: b62fe29 (tsd_* C ABI + `js/demux_engine.js` wired into the
   engine module), cdefb9f (wrapper fix: Chrome's TextDecoder rejects
   SharedArrayBuffer views — found in this step's live gate), e53f926
   (one-line `demux.ts` import swap + README Known-deltas note). Live-gated
   on `browsertest` (h264+aac: playback, stats line, PMT/PES) and a
   self-published `s302m` stream (PCM + meter DSP with sane values). The
   minimal M3 page mounts no debug panel; DebugSnapshot/meter data was
   verified over the worker protocol (the same events the vendored viewer
   hands the debug UI). Known wrinkle for a follow-up: `js/srt_engine.js`
   and `js/demux_engine.js` each instantiate their own copy of
   `build/srt_engine.mjs` in the player worker (two 16 MB heaps) —
   functional, but not the intended single shared instance.
7. Perf snapshot before/after (same stream, same machine): per-frame
   feed→onPes latency percentiles + GC/long-task count via
   PerformanceObserver → verify: written into the commit message or
   `page/README.md`; no regression, ideally a visible tail improvement.

Stretch (only if step 7 says we need more): feed the demuxer directly from
the engine ring inside C++ (no JS hop for message bytes at all) — bigger
ABI change, measured justification required first.

## M6 — publish engine glue (depends on the libwebsrt PLAN)

The libwebsrt PLAN delivers `ReceiverCore` send-path semantics (mirroring
`srt-wasm`'s `SrtReceiver.send_message`) plus its native test. Then:

1. Bump `deps/libwebsrt` pin (commit `build: bump deps/libwebsrt to …`,
   matching repo history) → verify: `./build.sh setup && ./build.sh lib`.
2. Grow `harness/receiver.{h,cpp}` C ABI with sendMessage → verify: engine
   builds; `js/srt_engine.js` implements `sendMessage()` (removing the
   documented NOT-implemented note at the top of that file).
3. Extend `js/test_contract.mjs` with a publisher case (fake WebTransport;
   assert sent messages arrive as datagrams, tx stats populate) → verify:
   `node js/test_contract.mjs`.
4. Vendor `stream-worker.ts` + `shared/publish.ts` from the WebSRT checkout
   (pin the commit in the vendoring note, like `page/vendor` @ 854c25c):
   engine import swaps to `../../js/srt_engine.js`; **muxer stays Rust**
   (`../wasm/ts-muxer-wasm`) — one variable at a time.
5. Publisher page (`page/publish.html` or a mode of `main.ts`) → verify
   live: publish from the browser to the local `websrt-cpp` gateway
   (WT udp 4435, `?publish=`), play it back on the M3 player and `ffprobe`
   it clean; then the same against the Rust `websrt` gateway (udp 4433) as
   an interop cross-check.

## M7 — C++ TS muxer + cutover

Port `ts-muxer-wasm/src/lib.rs` (227 lines) → `harness/ts_muxer.{h,cpp}`,
ABI mirror: `set_video_codec set_video_enabled set_audio_codec add_audio_pid
set_sparse_enabled set_sparse_threshold push_video push_audio push_pcm
push_pcm_pid poll`.

1. `js/muxer_parity.mjs` in node: same elementary inputs (golden encoded
   frames with keyframe flags, pts/dts sequences, PCM blocks) through Rust
   and C++ muxers → verify: **byte-identical** `poll()` output (PAT/PMT/PCR
   timing included).
2. Swap `stream-worker.ts` muxer import → verify: live publish E2E again
   (both gateways), player playback.
3. Cutover + docs: runtime now imports zero Rust pkgs; `page/wasm` symlink
   kept and documented as oracle/AB-only; update `README.md` and
   `page/README.md` (Known deltas section), retire this PLAN.md.

## Out of scope

`decode.ts` SPS/PPS parsing, `render.ts`, the pcm-player worklet, the debug
UI (all shared TS, run unmodified), gateway changes, oxiprobe/SlopShady/
CakeMix, WebCodecs (browser-native both sides).

## Risks

- The 1819-line Rust demux core carries years of edge-case fixes; the
  golden set + live captures in the parity harness are the mitigation —
  parity is the gate, not "looks right".
- Float parity: PCM and counters must be exact (achievable); meter DSP gets
  a decided-up-front tolerance. If exact PCM parity proves impossible,
  stop and document why before widening tolerance.
- Vendored TS drift from WebSRT: pin the WebSRT commit in every vendoring
  note; re-vendor deliberately, never hand-edit vendored files beyond the
  documented import swaps.
