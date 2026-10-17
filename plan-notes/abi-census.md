# ABI census — mpeg2ts-wasm + ts-muxer-wasm (M5/M7 port contract)

Definitive mirror spec for the C++ port: the exact wasm-bindgen surface
`harness/ts_demux.*` / `harness/meter.*` (M5) and `harness/ts_muxer.*` (M7)
must reproduce so `page/vendor/demux.ts` and the vendored `stream-worker.ts`
work with a one-line import swap. Sources (Rust oracle, `~/maxolgi/WebSRT`):

- `crates/mpeg2ts-wasm/src/lib.rs` (1819 ln), `nal.rs` (233), `aes3.rs` (342), `meter.rs` (809)
- `crates/ts-muxer-wasm/src/lib.rs` (227) — thin shim over native `crates/ts-muxer/src/lib.rs` (1235)
- Consumers: `web/src/demux.ts`, `web/src/stream-worker.ts`, `web/src/pcm-player.ts`, `websrt-wasm-cpp/page/vendor/{demux.ts,worker.ts,shared/types.ts}`

Conventions below: **JS name** is what wasm-bindgen exports (property vs
method matters — see §4). All line refs are into the file last cited in the
section heading. Only `#[wasm_bindgen]` items are JS-visible; `pub mod nal /
aes3 / meter` items without `#[wasm_bindgen]` (lib.rs:25-26) are crate-internal
Rust API, not JS ABI — the C++ port ports their logic, not their bindings.

---

## 1. mpeg2ts-wasm demuxer ABI

### 1.1 `TsDemuxer` — 5 public methods (lib.rs)

| JS | Rust signature | Semantics | Source |
|---|---|---|---|
| `new TsDemuxer()` | `#[constructor] pub fn new() -> TsDemuxer` | Fresh state: empty feed buf, `TsPacketReader` over shared buffer, empty maps/rings, default meter, `start_time = now` (clock anchor for all `t_ms` in rings — ms since construction). | lib.rs:483-505 |
| `feed(bytes)` | `pub fn feed(&mut self, bytes: &[u8]) -> Vec<TsEvent>` | Append raw TS bytes (any length; leftovers <188 B buffered across calls via `FeedBuf`, lib.rs:139-171), parse whole 188-B packets, return events emitted during this call. Reader error → one kind-4 event `"ts parse: {e:?}"` per failed read + error-ring entry. Events are wasm objects; JS must `e.free()` each (demux.ts:41). | lib.rs:507-524 |
| `debugSnapshot()` | `#[js_name=debugSnapshot] pub fn debug_snapshot(&self) -> DebugSnapshot` | Struct-of-arrays analysis snapshot (§1.3). `&self` (no state mutation). Per-PID tables sorted ascending by PID for cross-call stability. | lib.rs:1375-1530 |
| `meter_snapshot()` | `pub fn meter_snapshot(&mut self) -> MeterSnapshotView` | **⚠ snake_case JS name** (no `js_name` attr — the only such export; demux.ts:56 calls `meter_snapshot()`). **Stateful**: resets peak/RMS windows, latches held values, pushes phase windows (meter.rs:419-453). | lib.rs:1532-1548 |
| `setMeterSelection(pid, channel)` | `#[js_name=setMeterSelection] pub fn set_meter_selection(&mut self, pid: u16, channel: u8)` | Select source PID + channel for scope/FFT. `pid=0` or a gone PID → auto-re-lock to next 302M PID on update (meter.rs:404-406). | lib.rs:1550-1554 |

`Default for TsDemuxer` (lib.rs:1066-1070) is Rust-only, not ABI.

### 1.2 `TsEvent` — kind enum + 14 accessors (lib.rs:197-423)

Kind values (lib.rs:219, 307-422):

| kind | meaning | constructor / trigger |
|---|---|---|
| 0 | `pat` — Program Association Table entry seen | lib.rs:307-323, emitted per `pat.table` row (lib.rs:882-900) |
| 1 | `pmt` — Program Map Table seen | lib.rs:324-345, via parsed `TsPayload::Pmt` or reassembled multi-packet PSI (lib.rs:902-904, 948-953, 545-588) |
| 2 | `pes` — reassembled PES packet | lib.rs:346-371; flushed at declared length OR next PesStart (lib.rs:1027-1063) |
| 3 | `random_access` — AF random_access_indicator set | lib.rs:372-388, lib.rs:846 |
| 4 | `error` — recoverable parse error | lib.rs:389-405, lib.rs:515-520 |
| 5 | `pcm` — SMPTE 302M PES decoded to f32 | lib.rs:406-422, emitted right after the kind-2 PES for BSSD PIDs (lib.rs:743-752) |

Accessors (all **properties** except the two marked methods):

| JS | Rust → JS type | Notes | Source |
|---|---|---|---|
| `kind` | `u8` → number | 0-5 above | lib.rs:220-223 |
| `pid` | `u16` → number | **kind 0: this is the PMT pid, not 0** (lib.rs:310); kind 1: always 0 (lib.rs:335); kind 4: 0 | lib.rs:224-227 |
| `pts` | `f64` → number | 90 kHz ticks; `-1.0` when absent (i64 -1 internally, widened to f64) | lib.rs:228-235 |
| `dts` | `f64` → number | same convention | lib.rs:236-243 |
| `stream_type` | `u8` → number | **always 0 except kind 5** (0x06, `S302M_STREAM_TYPE`); kind 2 does NOT carry it — see §3 | lib.rs:244-247, 412 |
| `data` | `Vec<u8>` → Uint8Array (copy) | kind 2: PES payload; kind 1: packed LE-u16 `[pid,st, pid,st, …]`; else empty | lib.rs:248-251 |
| `text` | `String` → string | kind 4 only | lib.rs:252-255 |
| `program_num` | `u16` → number | kind 0: program number; kind 5: **channel_count** (overloaded!); else 0 | lib.rs:256-259, 415 |
| `randomAccess` | `bool` → boolean | kind 2: RA flag captured at PesStart time; kind 3: true | lib.rs:260-263 |
| `pmtEntries()` *(method)* | `Vec<u16>` → Uint16Array | decodes `data` kind 1 into flat `[pid0, st0, pid1, st1, …]` (re-derives; recomputed each call) | lib.rs:265-278 |
| `pmtFormatIds()` *(method)* | `Vec<String>` → string[] | per-entry registration-descriptor id ("AV01"/"Opus"/"HEVC"/"BSSD"), `""` when absent | lib.rs:280-286, 527-540 |
| `nalOffsets` | `Vec<u32>` → Uint32Array (copy) | flat `[off0, len0, off1, len1, …]` relative to `data`, video PIDs only | lib.rs:212, 288-291, 708-714 |
| `nalTypes` | `Vec<u8>` → Uint8Array (copy) | NAL type per NALU (H.264 low 5 bits; HEVC bits 1-6), video only | lib.rs:213, 293-296; nal.rs:136-152 |
| `samples` | `Vec<f32>` → Float32Array (copy) | kind 5 only: interleaved f32 PCM, [-1,1), 48 kHz | lib.rs:298-303 |

Field-by-kind matrix (X = meaningful value):

| field | 0 pat | 1 pmt | 2 pes | 3 ra | 4 error | 5 pcm |
|---|---|---|---|---|---|---|
| pid | PMT pid | 0 | X | X | 0 | X |
| pts/dts | -1 | -1 | X/-1 | -1 | -1 | X/-1 |
| stream_type | 0 | 0 | 0 | 0 | 0 | 0x06 |
| data | – | LE pairs | PES payload | – | – | – |
| text | – | – | – | – | X | – |
| program_num | prog num | 0 | 0 | 0 | 0 | **channel_count** |
| randomAccess | false | false | X | true | false | false |
| pmtEntries/pmtFormatIds | – | X | – | – | – | – |
| nalOffsets/nalTypes | – | – | video only | – | – | – |
| samples | – | – | – | – | – | X |

### 1.3 `DebugSnapshot` — 37 accessors (lib.rs:1084-1285)

Struct-of-arrays; JS zips parallel arrays by index (doc lib.rs:1072-1083).
Every getter `.clone()`s → fresh JS-owned typed arrays; snapshot itself needs
`free()` (worker.ts:855-904 reads all 37 then frees).

Scalars:

| JS | type | notes | source |
|---|---|---|---|
| `programNum` | `i32` | -1 = none yet | lib.rs:1132-1135, 1492 |
| `pmtPid` | `i32` | -1 = none yet | lib.rs:1136-1139, 1493 |

PMT tables (parallel, one per ES entry, PMT order):

| JS | element type | source |
|---|---|---|
| `pmtPids` | u16 → Uint16Array | lib.rs:1140-1143 |
| `pmtStreamTypes` | u8 → Uint8Array | lib.rs:1144-1147 |
| `pmtFormatIds` | String → string[] | lib.rs:1148-1151 |

Per-PID stats — key array `pids` (ascending), scalars 1/PID, scrambling/afControl 4/PID:

| JS | element type | source |
|---|---|---|
| `pids` | u16 → Uint16Array | lib.rs:1153-1156 |
| `pesCounts` | f64 → Float64Array | lib.rs:1157-1160 |
| `byteTotals` | f64 (cumulative bytes) | lib.rs:1161-1164 |
| `bitratesMbps` | f64 (10 s rolling window, 100×100 ms buckets) | lib.rs:1165-1168, 1288-1299 |
| `raCounts` | f64 | lib.rs:1169-1172 |
| `lastPts` / `lastDts` | f64, -1 = none | lib.rs:1173-1180 |
| `ptsJumps` | f64 (>1 s delta count, `PTS_JUMP_90K`=90000) | lib.rs:1181-1184, 35 |
| `ccErrors` | f64 (discontinuity_indicator resets exempt) | lib.rs:1185-1188, 868-879 |
| `teiCounts` / `pusiCounts` | f64 | lib.rs:1189-1196 |
| `scramblingCounts` | f64, flat 4×N, index = TSC discriminant (0=clear, 2=even, 3=odd) | lib.rs:1197-1200, 777-815 |
| `afControlCounts` | f64, flat 4×N, index = derived AF control (0b11 AF+payload, 0b10 AF-only, 0b01 payload-only, 0b00 none) | lib.rs:1201-1204, 786-793 |

*Not exposed despite existing internally:* `PidStats.max_pts_delta`,
`last_ra_ms`, `scrambling/af` are the only [u32;4]s that surface — max PTS
delta and last-RA-ms never leave Rust (lib.rs:69-87).

PCR (per PID with a PCR seen; ascending):

| JS | element type | source |
|---|---|---|
| `pcrPids` | u16 → Uint16Array | lib.rs:1206-1209 |
| `pcrIntervalsMs` | f64 (27 MHz delta / 27000) | lib.rs:1210-1213, 819-833 |
| `pcrJitterMs` | f64 (EMA α=0.1) | lib.rs:1214-1217, 826-829 |

NAL stats (video PIDs 0x1B/0x24 only; ascending):

| JS | element type | source |
|---|---|---|
| `nalPids` | u16 → Uint16Array | lib.rs:1219-1222 |
| `nalStats` | f64, flat 9×M, order **I, P, B, IDR, SPS, PPS, SEI, AUD, NonIDR** | lib.rs:1223-1226, 1431-1444; nal.rs:66-79 |

Recent errors (last 20, `RECENT_ERRORS_CAP`):

| JS | element type | source |
|---|---|---|
| `errorT` | f64 (ms since construction) | lib.rs:1228-1231, 1113 |
| `errorMsg` | String → string[] | lib.rs:1232-1235 |

Packet ring (last 500 entries, `PACKET_RING_CAP`):

| JS | element type | source |
|---|---|---|
| `ringT` | f64 (ms since construction) | lib.rs:1237-1240 |
| `ringPid` | u16 → Uint16Array | lib.rs:1241-1244 |
| `ringKind` | u8: 0 pat, 1 pmt, 2 pes, 3 ra, 4 error, 255 other | lib.rs:1245-1248, 37-43 |
| `ringPts` / `ringDts` | f64, -1 = absent | lib.rs:1249-1256 |
| `ringSize` | f64 (PES payload bytes; 0 for non-pes rows) | lib.rs:1257-1260 |
| `ringRa` / `ringTei` / `ringPusi` | u8, 0/1 booleans | lib.rs:1261-1272 |
| `ringNal` | u8, concatenated per-row NAL type summaries | lib.rs:1273-1276 |
| `ringNalOffsets` | u32, **N+1 prefix sums**; row i's types = `ringNal[offsets[i]..offsets[i+1]]` | lib.rs:1277-1280, 1082-1083, 1473-1487 |
| `ringHex` | String → string[], hex of first ≤512 B of PES payload (`HEX_CAP_BYTES`) | lib.rs:1281-1284, 45-56 |

### 1.4 Meter API (lib.rs:1302-1554 + meter.rs)

`MeterSnapshotView` — 12 accessors (lib.rs:1302-1368), all properties, plus `free()`:

| JS | element type | notes | source |
|---|---|---|---|
| `pids` | u16 → Uint16Array | metered PIDs, ascending | lib.rs:1320-1323 |
| `channelCounts` | u8 → Uint8Array | 1/pid, parallel to `pids` | lib.rs:1324-1327 |
| `peaks` | f32 → Float32Array | **flat across ALL channels of ALL pids** in pid order; window peak, held on empty windows | lib.rs:1328-1331; meter.rs:430-442 |
| `rms` | f32 → Float32Array | same flat layout | lib.rs:1332-1335 |
| `clips` | u32 → Uint32Array | per channel; 1 clip per ≥3-sample (`CLIP_RUN`) flat-top run at \|s\|≥0.999 | lib.rs:1336-1339; meter.rs:99-106, 14 |
| `lufs` | f32 → Float32Array | per channel, K-weighted, 4×100 ms blocks, floor -70 | lib.rs:1340-1343; meter.rs:10-11, 139-150 |
| `phase` | f32 → Float32Array | per **channel pair** (ch/2 per pid), 12-window ring avg, clamp [-1,1] | lib.rs:1344-1347; meter.rs:12, 166-245 |
| `scopeL` / `scopeR` | f32 → Float32Array ×2 | 256 samples each, selected pid; L=selected ch, R=stereo partner (`sel_ch ^ 1`) | lib.rs:1348-1355; meter.rs:16, 302-315 |
| `spectrum` | f32 → Float32Array | 64 log-spaced bins in dB, floor -80; 1024-pt FFT of selected channel | lib.rs:1356-1359; meter.rs:15, 329-368 |
| `selectedPid` | u16 → number | | lib.rs:1360-1363 |
| `selectedChannel` | u8 → number | | lib.rs:1364-1367 |

Meter selection: `setMeterSelection(pid, ch)` (§1.1); auto-select fallback in
`MeterState::update` (meter.rs:403-417) — selected_pid 0/gone → first
incoming pid.

**How metering is driven: no timer inside wasm.** Updates happen inside
`feed()`: `finalize_pes` decodes 302M → `meter_state.update(pid, samples,
channel_count, pts)` (lib.rs:743-752). JS polls `meter_snapshot()` on a
**50 ms `setInterval`** (worker.ts:549-556, 308-315; doc comment says
"~30fps", meter.rs:5). Snapshot has side effects (window reset/latch,
meter.rs:430-451), so poll cadence defines the peak/RMS/phase window length.

### 1.5 Mirror-relevant constants

- TS packet 188 (lib.rs:29); ring 500 (lib.rs:31); errors 20 (lib.rs:32);
  bitrate window 100×100 ms (lib.rs:33-34); PTS jump 90_000 (lib.rs:35);
  hex cap 512 B (lib.rs:47).
- 302M: stream type 0x06, reg-desc tag 0x05, id "BSSD" (aes3.rs:21-25);
  decode scales 1/2^23, 1/2^19, 1/2^15 for 24/20/16-bit, bit-reversed LSB-first
  layout, 7/6/5 B per stereo pair (aes3.rs:59-116); sample rate always 48000
  (aes3.rs:54).
- NAL scan: Annex-B 3- and 4-byte start codes, no emulation-prevention strip
  (nal.rs:81-123, 6-10).

---

## 2. ts-muxer-wasm ABI (shim: ts-muxer-wasm/src/lib.rs; logic: ts-muxer/src/lib.rs)

12 methods (constructor + 11). `TsMuxer` JS name; `free()` inherited.

| JS | Rust signature | Semantics | shim source | native source |
|---|---|---|---|---|
| `new TsMuxer()` | `new() -> TsMuxer` | video on, H.264, video pid 0x100, one Opus 2-ch stream pid 0x101, PMT pid 0x1000, sparse off, threshold 300 ms, pmt_version 0 | :19-24 | n:93-121 |
| `setVideoCodec(codec)` | `(&mut self, &str)` | `"av1"`→st 0x06+AV01 desc; `"hevc"`→0x24; anything else→0x1B H.264 | :26-29 | n:123-138 |
| `setVideoEnabled(bool)` | `(&mut self, bool)` | drop video ES from PMT + ignore push_video | :31-34 | n:140-142 |
| `setAudioCodec(codec, ch)` | `(&mut self, &str, u8)` | retargets **stream[0] only**: `"s302m"` vs default Opus | :36-39 | n:144-153 |
| `addAudioPid(pid, codec, ch)` | `(&mut self, u16, &str, u8)` | append stream (dedup by pid) | :41-44 | n:155-170 |
| `setSparseEnabled(bool)` | `(&mut self, bool)` | opt-in silence suppression; default off | :49-52 | n:175-177 |
| `setSparseThreshold(ms)` | `(&mut self, f64)` | default 300.0 | :54-57 | n:179-181 |
| `push_video(data, ptsUs, dtsUs, isKeyframe)` | `(&mut self, &[u8], f64, f64, bool)` | see poll() triggers below | :59-62 | n:196-220 |
| `push_audio(data, ptsUs)` | `(&mut self, &[u8], f64)` | Opus path: prepends `0x7F 0xE0` AU header; targets first Opus-kind stream (`unwrap_or(0)` — no Opus stream ⇒ lands on stream 0's pid regardless of kind) | :64-67 | n:222-245 |
| `push_pcm(samples, ptsUs)` | `(&mut self, &[f32], f64)` | s302m path: AES3-wraps (24-bit), targets first s302m stream | :69-72 | n:247-254, 277-356 |
| `push_pcm_pid(pid, samples, ptsUs)` | `(&mut self, u16, &[f32], f64)` | per-pid s302m; **no-op** on unknown pid or non-s302m pid | :77-80 | n:259-267 |
| `poll()` | `(&mut self) -> Vec<u8>` | drain accumulated output (`mem::take`); always a whole number of 188-B packets; may be empty | :82-85 | n:269-271 |

### `poll()` output triggers (native lib.rs)

- **PAT/PMT cadence**:
  - `push_video` with `is_keyframe=true`: PAT+PMT before the PES, every
    keyframe (n:204-209).
  - `push_pcm*`: first-ever push emits PAT+PMT (n:286-291); periodic PAT+PMT
    when `pts_90k - last_psi_pts ≥ 9000` ticks (=100 ms) (n:29-33, 329-336);
    sparse transitions → immediate rewrite + **10× re-send burst**
    (`PMT_RESEND_COUNT`, n:30, 303-327); PMT `version_number` bumps mod 32 on
    each drop/re-add (n:85-89, 402).
  - `push_audio` (Opus): **never emits PSI** — video-disabled Opus-only
    streams emit PAT/PMT only via nothing; PES only. (Mirror exactly.)
- **PCR**: `pcr = pts_90k·300` (wrapping) set by every push_video and
  push_pcm* (n:202, 279); written into the AF of the **first packet of that
  PES** only when the pushed pid == `pcr_pid()` — video pid if video enabled,
  else first non-suppressed audio pid (n:183-194, 482-521). So with video on,
  every video PES carries PCR; audio PES carries PCR only in audio-only mode.
- **Random_access flag**: AF flag 0x40 on first packet of a video PES only
  when `is_keyframe` (n:512-514; test n:755-767).
- **Null padding: none.** No PID 0x1FFF packets ever; short final PES packets
  are 0xFF-stuffed via the adaptation field (n:488-527); PSI tail stuffing
  0xFF (n:432-463). `poll()` length = exactly what pushes produced.
- **PES headers**: video = unbounded (`pes_packet_len` 0x0000), PTS always,
  DTS only when `dts != pts` (n:542-565); audio = bounded
  `3+5+len`, PTS-only (n:567-584); `us→90k` = `max(us,0)·9/100` truncating
  (n:586-588).
- **Sparse semantics**: silence = all \|s\| ≤ 1e-6 (n:29, 590-597);
  per-push accumulation `frames/48` ms; suppress when `silence_ms >
  threshold` (strict), resume on any loud frame; while suppressed the PES is
  dropped but periodic PSI keeps flowing (n:293-341). **CC is *not* reset**
  across suppression despite the "resets CC" doc comments (shim :48-51,
  native :83-84) — test `sparse_resume_keeps_cc_continuous` asserts CC
  continues mod 16 (n:910-948). Tests win; the comments are stale.

Consumer drive pattern: `flushTsToSrt()` polls after every encoder output,
gated on `rx.isHandshakeComplete()` (stream-worker.ts:409-420).

---

## 3. Consumer call-site cross-check

`web/src/demux.ts` ≡ `page/vendor/demux.ts` (byte-identical vendoring;
dispatch at demux.ts:79-126). `page/vendor/worker.ts` is the player worker.

**mpeg2ts-wasm — used:** `new TsDemuxer()`, `feed`, `debugSnapshot`,
`meter_snapshot`, `setMeterSelection` (worker.ts:320, 551); TsEvent: `kind`,
`pid`, `pts`, `dts`, `data`, `text`, `program_num`, `randomAccess`,
`pmtEntries()`, `pmtFormatIds()`, `nalOffsets`, `nalTypes`, `samples`
(demux.ts:80-125); all 37 DebugSnapshot accessors (worker.ts:861-901); all 12
MeterSnapshotView accessors (demux.ts:55-73). `e.free()`/`snap.free()`/`s.free()`
on every path.

**Unused by current consumers:**

- `TsEvent.stream_type` — never read by any consumer. PMT stream types travel
  via `pmtEntries()`; nothing branches on the kind-5 0x06. Port it anyway
  (mirror contract), but parity tests can't rely on consumer coverage.
- `TsMuxer`: `setVideoEnabled`, `setAudioCodec`, `addAudioPid`,
  `setSparseEnabled`, `setSparseThreshold`, `push_pcm`, `push_pcm_pid` —
  **unused by WebSRT web consumers** (stream-worker.ts uses only `new`,
  `setVideoCodec`, `push_video`, `push_audio`, `poll`, `free`:
  stream-worker.ts:153-155, 351, 403, 413, 294). The pid/pcm APIs exist for
  CakeMix's 64×s302m layout (native test comment n:1127-1128; roundtrip test
  shim:95-130). M7 must still mirror them — the vendored `stream-worker.ts`
  keeps `../wasm/ts-muxer-wasm` until the M7 swap, and CakeMix-grade parity
  tests exercise them.
- `pcm-player.ts`: **no wasm API usage at all** — type-only `AudioMeterData`
  import; metering hooks are no-op stubs (pcm-player.ts:11-12, 64-65, 72-73).
  Imposes no ABI beyond "PCM arrives as Float32Array".
- `page/vendor/shared/types.ts` mirrors DebugSnapshot as `DemuxStats`
  (types.ts:71-110) and the meter as `AudioMeterData` (types.ts:34-47) — the
  C++ exports must keep those shapes property-compatible.

**Consumer behavior the mirror must tolerate (zero-copy hazards):**

- worker.ts transfer-lists `videoPes.data`, `pcm.samples`, `nalOffsets`,
  `nalTypes` ArrayBuffers in `postMessage` (worker.ts:363-380, 342-361) —
  with VIEW returns these can no longer be transferred (they'd point into
  wasm heap); the wrapper must copy before queue/transfer, or views must be
  heap-allocated copies. demux.ts's doc comment already promises "fresh
  JS-owned copy" for snapshot getters (demux.ts:45-50) — keep that true for
  snapshots; views are only for the feed-callback path (consumed synchronously
  inside `feed()`, worker.ts:746-755).

---

## 4. Type-mapping + COPY/VIEW contract

wasm-bindgen mapping (current Rust pkg):

- `Vec<u8>/Vec<u16>/Vec<u32>` → fresh `Uint8/16/32Array` (copied out of wasm
  heap); `Vec<f32>/Vec<f64>` → `Float32/64Array` (copy); `Vec<String>` →
  `string[]`; `String` → string. Every getter clones (e.g. lib.rs:249-251).
- `&[u8]`/`&[f32]` params → accept `Uint8Array`/`Float32Array`, **copied into
  the wasm heap** per call.
- `&mut self` / `&self` → plain JS methods on the wrapper; no visible difference.
- Struct returns (`TsEvent`, `DebugSnapshot`, `MeterSnapshotView`) → wasm
  objects with property getters + `free()`.
- `u8/u16 → number`, `bool → boolean`, `f64 → number` (PTS/DTS deliberately
  f64, not i64 — wasm-bindgen i64 → BigInt would break consumers).

C++ port per PLAN.md zero-copy contract (PLAN.md:53-56): mark each hot return
COPY (keep wasm-bindgen behavior) or VIEW (heap view, valid only until the
next mutating call — `feed()` for demuxer events, next `push_*`/`poll()` for
muxer output):

| Item | Rust today | C++ port | Lifetime caveat |
|---|---|---|---|
| `TsEvent.data` (kind 2, PES payload) | copy | **VIEW** (`HEAPU8` subarray) | invalid after next `feed()`; consumers use it synchronously in `onPes` (worker.ts:434-485) — any queuing must copy |
| `TsEvent.samples` (kind 5, PCM) | copy | **VIEW** (`Float32Array` over heap) | same; worker queues/transfers pcm → must copy at the queue boundary (worker.ts:490, 363-380) |
| `TsEvent` everything else (scalars, nalOffsets, nalTypes, pmtEntries, pmtFormatIds, text) | copy | COPY | small; nalOffsets/nalTypes also get transfer-listed (worker.ts:374-377) |
| `DebugSnapshot` all 37 | copy | COPY | PLAN keeps snapshots JS-owned; polled at 250 ms-1 s, not hot |
| `MeterSnapshotView` all 12 | copy | COPY | 50 ms poll, ~1 kB — not hot |
| `TsMuxer.poll()` output | copy (`Vec<u8>` drained) | COPY per current contract (PLAN.md lists only "PES/PCM data"); VIEW of the output ring is a legal later extension | if ever VIEW: invalid at next `push_*` or `poll()`; stream-worker sends it straight into `rx.sendMessage` (stream-worker.ts:413-417), which copies for transport anyway |
| `feed(bytes)` input, `push_video/push_audio(data)` input, `push_pcm(samples)` input | copy-in | input side; accepting views into the shared heap is free (same module as engine) | n/a |

Method-vs-property distinction the C++ JS wrapper must preserve exactly
(TS callers depend on it): `pmtEntries()` / `pmtFormatIds()` are **called**;
`kind/pid/pts/dts/stream_type/data/text/program_num/randomAccess/nalOffsets/nalTypes/samples`
and every snapshot field is **read as a property** (demux.ts:82-123,
worker.ts:864-901). And `meter_snapshot` stays snake_case while everything
else is camelCase.

---

## Surprises (port-relevant)

1. `TsEvent.stream_type` is vestigial: always 0 except kind-5 (0x06); unused
   by every consumer (§3).
2. `meter_snapshot` is the only snake_case JS export — easy mirror trap (§1.1).
3. Sparse-mode doc comments ("resets CC on resume", shim:48-51, native:83-84)
   contradict the tested behavior (CC continues mod 16, n:910-948).
4. `push_audio` never emits PAT/PMT — PSI comes only from keyframe video
   pushes and PCM pushes (§2).
5. `DebugSnapshot` hides `max_pts_delta` / `last_ra_ms` that the internal
   stats track (§1.3).
6. kind-0 `pat` event's `pid` = PMT pid; kind-5 `program_num` = channel count
   — two field overloads the flat event struct forces (§1.2).
7. Metering has no internal timer: updates ride `feed()`, windows advance on
   the JS 50 ms `meter_snapshot()` poll, which is `&mut self` stateful (§1.4).
