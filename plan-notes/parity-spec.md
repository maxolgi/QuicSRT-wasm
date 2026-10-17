# M5 demux parity: golden set, corruptions, fixture storage, comparison rules

Decision-complete spec for `js/demux_parity.mjs` (PLAN.md:58-74). The implementing agent
makes **no design decisions** — everything below is normative. Oracle sources (all line refs
bare = `~/maxolgi/WebSRT/crates/mpeg2ts-wasm/src/`): `lib.rs` (1819), `nal.rs`, `aes3.rs`,
`meter.rs`. Underlying crate: mpeg2ts fork, cargo checkout `mpeg2ts-ac551958429171ba/9a1efaf`
(cited as `fork:`). Meter float policy is already decided in `plan-notes/meter-parity.md` —
this doc adopts it wholesale and does not re-litigate.

ffmpeg facts below were probed live on this machine (ffmpeg 7.1.5-0+deb13u1): RAI default-on
(`omit_rai` flag exists; AF flags `0x50`=PCR|RAI seen on IDR PesStart, `0x10` on non-key),
video PES unbounded by default (`omit_video_pes_length` default true; probe `..01e0 0000`),
s302m encoder = `s302m` + `-strict -2` (experimental), 2/4/6/8 ch, sample formats s32→24-bit /
s16→16-bit, **default negotiation picked 16-bit** — `-sample_fmt s32` must be explicit;
s302m stream_id `0xBD`, PMT stream_type `0x06` + registration descriptor `05 04 "BSSD"`;
libx265 → stream_type `0x24` + registration descriptor `"HEVC"`; AAC (`0x0F`) gets **no**
registration descriptor (empty format id); null packets are `47 1F FF 10` with **constant
CC=0**; `-muxrate` produces AF-stuffed PCR-only packets (afc `0b10`, af_length 183) and null
spans; `-tables_version` works (PAT version byte `c1`→`c7` for v3); `-mpegts_flags
initial_discontinuity` sets discontinuity+PCR+RAI (`0xd0`) on the head keyframe; `pat_period`
default 0.1 s ⇒ PAT/PMT republish ~10 Hz; the mpegts muxer has **no option to put PCR on a
dedicated PID** (full `ffmpeg -h muxer=mpegts` option list) — PCR rides the first video PID.

## 1. Golden stream set (all `-f mpegts` **file** output, checked in under `js/fixtures/`)

Common flags on every command (after the `-i`s): `-flags +bitexact -fflags +bitexact`
(suppresses encoder-version SEI/metadata ⇒ byte-stable across machines of the same build).
x264/x265 are deterministic per version. Sizes were **measured** with the exact commands
below; expect ±25% across ffmpeg builds; `manifest.sha256` (§3) is authoritative.

| # | File | Dur | Measured | Exercises (with oracle citations) |
|---|------|-----|----------|-----------------------------------|
| S1 | `av_shortgop.ts` | 6 s | 253,800 B | 2-entry PMT (0x1B video 0x100 no-desc, 0x0F AAC 0x101 no-desc ⇒ `pmtFormatIds ["",""]`); PAT/PMT republish ~10 Hz (PAT event per table, lib.rs:882-901; PMT per section, lib.rs:987-1025); **unbounded** video PES flushed at next PesStart (lib.rs:905-938, test 1749-1783); **bounded** audio PES flushed on last continuation (lib.rs:1027-1063, test 1703-1744); PTS+DTS headers (`-bf 3`); RA events at each of 6 IDRs (lib.rs:834-861); H.264 NAL scan + I/P/B slice classification (nal.rs:200-219); `ra` stash/consume semantics (lib.rs:427-434, 927-928) |
| S2 | `v_longgop.ts` | 12 s | 469,812 B | 10 s GOP (`-g 250`) ⇒ exactly 2 IDRs at 0 s/10 s; PTS-only headers (`-bf 0` ⇒ `dts=-1` path); P-slice-only stats; multi-packet PES chains (long partial accumulation) |
| S3 | `v_hevc.ts` | 6 s | 169,012 B | stream_type 0x24 + `"HEVC"` reg-desc (non-empty `pmtFormatIds`); HEVC NAL path (lib.rs:703-706 gate `0x24`; nal.rs:167-199: VPS 32→`pps` fold, IDR 19/20, TRAIL 0/1 with HEVC slice_type 0=B/1=P/2=I) |
| S4 | `a_aac.ts` | 4 s | 40,796 B | audio-only PMT; bounded PES with `0xFF` stuffing inside payload (byte-exact compare); no NAL (empty `nalOffsets/Types` for non-video PID, lib.rs:696-706); not a 302M pid ⇒ no pcm events (lib.rs:629-635) |
| S5 | `a302m_16.ts` | 2 s | 501,584 B | 302M path: BSSD detection (lib.rs:629-635, aes3.rs:22-28), kind=5 pcm events, 16-bit 5-byte chunks (aes3.rs:102-111), `streamType=6`, `programNum=channel_count` (lib.rs:406-422), meter `update` per PES (lib.rs:743-753); PTS from PES carried on pcm event |
| S6 | `a302m_24.ts` | 2 s | 712,896 B | 24-bit 7-byte chunk decode (aes3.rs:77-88); ≥2 s ⇒ LUFS 4-block ring wrapped (meter.rs:10-11) |
| S7 | `a302m_24_6ch.ts` | 1.5 s | 1,116,720 B | channel_count=6 header (aes3.rs:37,39); pcm `programNum=6`; meter 3 phase pairs, 6 channels (meter.rs:261-299) |
| S8 | `v_cbr_pad.ts` | 3 s | 148,896 B | **padding/CBR**: null packets (fork `null.rs` payload ⇒ CC check applies, lib.rs:968-983 + 868-879); AF-only stuffed PCR packets ⇒ `afControlCounts[0b10]` (lib.rs:786-793); PCR interval + jitter EMA on 0x100 (lib.rs:819-833); the "low-bitrate + adaptation-field padding" requirement |
| S9 | `v_disc.ts` | 3 s | ~110 KB (est) | natural discontinuity_indicator ⇒ CC reset is legitimate, no cc_error (lib.rs:794-798 vs 870-878) |
| S10 | `v_b_v1.ts` | 3 s | ~110 KB (est) | second program: `-tables_version 1`, PIDs 0x200 / PMT 0x1008 — input half of corruption C8 |

Exact commands (paths relative to repo root; `ffmpeg -y … js/fixtures/<file>`):

```sh
# S1
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 6 -flags +bitexact -fflags +bitexact -c:v libx264 -preset veryfast -profile:v main \
  -bf 3 -g 25 -keyint_min 25 -sc_threshold 0 -b:v 180k -c:a aac -b:a 64k -ac 2 \
  -f mpegts js/fixtures/av_shortgop.ts
# S2
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 12 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 250 -keyint_min 250 -sc_threshold 0 -b:v 250k \
  -f mpegts js/fixtures/v_longgop.ts
# S3
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 6 -flags +bitexact -fflags +bitexact \
  -c:v libx265 -preset ultrafast -x265-params keyint=50:min-keyint=50:scenecut=0:log-level=error \
  -b:v 150k -f mpegts js/fixtures/v_hevc.ts
# S4
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 4 -flags +bitexact -fflags +bitexact \
  -c:a aac -b:a 64k -ac 2 -f mpegts js/fixtures/a_aac.ts
# S5 (16-bit; -sample_fmt is REQUIRED — default negotiation also lands s16, be explicit)
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 2 -flags +bitexact -fflags +bitexact \
  -ac 2 -strict -2 -c:a s302m -sample_fmt s16 -f mpegts js/fixtures/a302m_16.ts
# S6 (24-bit)
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 2 -flags +bitexact -fflags +bitexact \
  -ac 2 -strict -2 -c:a s302m -sample_fmt s32 -f mpegts js/fixtures/a302m_24.ts
# S7 (6-channel 24-bit)
ffmpeg -y -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 1.5 -flags +bitexact -fflags +bitexact \
  -af aformat=channel_layouts=5.1 -ac 6 -strict -2 -c:a s302m -sample_fmt s32 \
  -f mpegts js/fixtures/a302m_24_6ch.ts
# S8 (CBR: null stuffing + AF-stuffed PCR-only packets)
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 3 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 50 -b:v 120k -muxrate 400k -f mpegts js/fixtures/v_cbr_pad.ts
# S9 (natural discontinuity indicator)
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 3 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 25 -b:v 150k -mpegts_flags initial_discontinuity \
  -f mpegts js/fixtures/v_disc.ts
# S10 (program B: version 1, remapped PIDs — concat partner for C8)
ffmpeg -y -f lavfi -i testsrc2=size=320x184:rate=25 -t 3 -flags +bitexact -fflags +bitexact \
  -c:v libx264 -preset ultrafast -bf 0 -g 25 -b:v 150k -tables_version 1 \
  -mpegts_start_pid 512 -mpegts_pmt_start_pid 4104 -f mpegts js/fixtures/v_b_v1.ts
```

Note S2 duration is 12 s (single `-t 12`, output-side). Total measured+estimated ≈ **3.7 MB**.

Explicit non-goals (do not chase): **PCR on a separate PID** — impossible with the ffmpeg
mpegts muxer (no such option; PCR rides the first video PID `0x100`); PCR tracking is still
exercised via video-PID PCR + the CBR fixture's PCR-only packets. **20-bit 302M** — the
encoder only emits 16/24-bit (s16/s32); the 20-bit chunk path (aes3.rs:90-100) stays covered
by the crate's unit tests (aes3.rs:118-342). **4/8-channel 302M** — 6ch already covers the
multi-pair header parse and meter fan-out. **Scrambled packets** — not producible;
`scramblingCounts` is compared anyway (expect all zeros).

## 2. Crafted corruptions (feed-time transforms of golden captures — nothing stored)

All offsets are TS-packet-aligned (188·n) unless stated. Packet indexing is 0-based from the
first byte of the (possibly skipped) buffer. Selector names: `videoPid` = PID of the first
PMT entry with streamType 0x1B; `audioPid` = entry 0x0F. TS header refs: byte1 = TEI|PUSI|
priority|PID[12:8]; byte3 = afc[5:4]|CC[3:0]; with AF present, byte4 = af_length, byte5 =
af flags (bit7 = discontinuity, bit6 = RAI, bit4 = PCR).

| # | Transform (byte semantics) | Expected behavior (assertions) |
|---|---|---|
| C1 TEI | Pick a PesContinuation packet of `videoPid` that is **not** the last packet of its PES (exists in S1/S2; a continuation followed by ≥2 more before the next PesStart). `byte1 \|= 0x80`. | Fork parses TEI packets normally (no TEI gating anywhere in fork `reader.rs`). Only diff vs unmutated run: `teiCounts[videoPid] +1` (lib.rs:804-806). No event/ring change (ring `tei` flag rides the *flushing* packet's flag, lib.rs:755-767). |
| C2 CC break | 2nd payload-bearing packet of `videoPid` after the first PesStart: `byte3 = (byte3 & 0xF0) \| ((byte3+7) & 0x0F)`. | Exactly `ccErrors[videoPid] +1` (lib.rs:868-879); CC is not covered by any CRC and not used elsewhere ⇒ everything else identical. |
| C3 CC break + discontinuity | Same mutation as C2 applied to a packet **with** AF (afc `0b11`, e.g. the first video PesStart, which carries PCR): additionally `byte5 \|= 0x80`. | **Zero diff vs baseline**: discontinuity_indicator suppresses the CC error (lib.rs:794-798 gates 870-878) and is recorded nowhere else. Counter-intuitive — that's the point. |
| C4 truncated tail | (a) Feed `bytes[0 .. len-123]`: identical to baseline minus the final packet's events; **no error events**; 123 leftover bytes sit in FeedBuf (lib.rs:155-157). (b) Cut at a packet boundary leaving an open unbounded video PES: that PES is never flushed ⇒ missing pes event, `pesCount`/NAL stats/ring row absent. | Leftover bytes are retained across `feed()` calls (lib.rs:146-153) — append the missing tail in a second `feed()` and the remaining events appear (assert this). |
| C5 mid-stream join (aligned) | Skip the first 200 packets (200·188 B) of S1. | No PSI known ⇒ fork returns `Raw` for every payload PID (fork reader.rs:88-98) ⇒ only `KIND_OTHER` ring rows (lib.rs:948-967); no pat/pmt/pes events. Within ≤ ~0.1 s of stream time (pat_period) a PAT+PMT republish arrives ⇒ pat/pmt events, PIDs register, pes events resume from the next PesStart; an orphan PesContinuation (no open partial) is silently dropped but **still counted in byteTotals** (lib.rs:940-946). No cc errors (CC stays continuous), no pts jumps (per-PID `last_pts` fresh). |
| C6 mid-stream join (misaligned) | Start feeding at offset 188·k+1 (any non-multiple of 188). | Sync-byte error **per byte**: fork reads 1 byte, fails the 0x47 check, consumes exactly that byte (fork packet.rs:97-102; reader.rs:48-57) ⇒ a `feed()` call handed M ≥ 188 bytes emits exactly M−187 kind-4 error events (lib.rs:515-519) and stays misaligned forever; never any pat/pmt/pes/pcm events. `recentErrors` truncated to last 20 (lib.rs:602-606), ring to 500 (lib.rs:31, 595-600). Canonicalized text (§4) = `ts parse: InvalidInput: Expected sync byte 0x47, got 0xXX`. |
| C7 null-only span | In S1, overwrite packets [i, i+50) (i = 10th packet index) with 50 × null packet `47 1F FF 10` + 184×`FF`. | `pids` gains 0x1FFF; `afControlCounts[0x1FFF][0b01] += 50`; `ccErrors[0x1FFF] += 49` — first null seeds `last_cc=0`, every subsequent null repeats cc 0 ≠ expected 1 (lib.rs:868-879 apply because Null has a payload, fork null.rs; lib.rs:968-983). `pesCounts[0x1FFF]=0`, `byteTotals[0x1FFF]=0` (Null path never counts). Ring: 50 `KIND_OTHER` rows. Destroyed content packets ⇒ resume CC gap (+1 `ccErrors` on that PID) and a PES missing that payload (shorter pes event / shifted flush). |
| C8 PAT/PMT republish mid-stream | Runtime concat: feed all of S1, then all of S10 (ffmpeg **cannot** bump version mid-file in one run — `-tables_version` is file-wide; the concat achieves the bump without any byte surgery, so no manual section overwrite is needed). | Mid-stream pat event (pid=0x1008, programNum=1) and pmt event with entry [0x200↔0x1B], `pmtFormatIds [""]`; `pmt_entries` replaced + new PID registered (lib.rs:987-1025); pes events on 0x200 from then on; `pcrPids` gains 0x200; the old dangling partial on 0x100 is **never** flushed (no later PesStart on that PID). New PIDs have fresh per-PID state ⇒ no pts jumps, no cc errors. SDT (0x11) is fork-`Raw` ⇒ KIND_OTHER rows. |
| C9 PTS-jump concat | Runtime concat: feed S1, then S1 again (same bytes). | Second copy restarts PTS near the initial offset ⇒ `ptsJumps[0x100] +1`, `ptsJumps[0x101] +1` (>90000 delta, lib.rs:35, 679-689); `maxPtsDelta` ≥ ~4.1 s·90000; +1 ccError per PID at the seam (CC restarts at 0); the second copy's first PesStart flushes the first copy's dangling partial (lib.rs:905-938). |

Manual PSI surgery (fallback, not needed for the set above): any future byte mutation inside
a PAT/PMT section must recompute CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, no
refin/refout/xorout — fork `crc.rs`/`util.rs` `WithCrc32`) over the section from table_id
through the last descriptor, because the fork **verifies** it (fork psi.rs:65-67); a bad CRC
turns a Pmt payload into `Raw` (fork reader.rs:100-107) and silently changes the event stream.

## 3. Fixture storage decision

- **Checked in**: all ten §1 files under `js/fixtures/` (~3.7 MB total; hard budget **6 MB**
  for the directory, per-file cap 1.2 MB — comfortably under the 20 MB ceiling). No corrupted
  variants and no concat files are stored; §2 transforms and §1 concats happen at feed time.
- **Committed regenerator** `js/fixtures/gen.sh` (spec only — do not write here). Contract:
  1. Emits exactly the ten files with the exact §1 commands (`-y`, cwd = repo root).
  2. Refuses to overwrite an existing file whose sha256 ≠ the value in
     `js/fixtures/manifest.sha256` unless invoked with `--force`.
  3. On success (re)writes `manifest.sha256` (one `<sha256>  <size>  <name>` line per file,
     sorted by name) and **fails** if the directory total exceeds 6 MB or any single file
     exceeds 1.2 MB.
  4. Fails if any measured size deviates > ±25% from the §1 table (guards option drift).
  5. Prints the first line of `ffmpeg -version` into its output (build provenance).
  6. Exit 0 only when all of the above hold. Byte-stability is per ffmpeg build; the
     manifest is authoritative, regeneration exists for recovery, not reproduction.

## 4. Canonical comparison rules

Run harness with **`RUST_BACKTRACE` unset** — the fork's Error Display appends a backtrace
when captured (fork error.rs:72-74), which would leak into event text.

### 4.1 Event canonical form (one JSON object per event, fixed field order)

- kind 0 `pat`: `{kind, pid, programNum}` — `pid` is the **PMT pid** (lib.rs:307-311).
- kind 1 `pmt`: `{kind, pid:0, pmtEntries:[pid,st,…]}` (LE-decoded from `data`,
  lib.rs:265-278) + `pmtFormatIds` (strings, `""` when absent, lib.rs:529-540).
- kind 2 `pes`: `{kind, pid, pts, dts, randomAccess, dataLen, dataSha256, nalOffsets,
  nalTypes}`. `streamType` is always 0 for pes events (lib.rs:361) — compare it as a
  constant, don't infer anything from it. `pts`/`dts` getters return f64 but carry 33-bit
  ints or −1 (lib.rs:229-243) ⇒ serialize as integers.
- kind 3 `random_access`: `{kind, pid}` (lib.rs:372-388).
- kind 4 `error`: `{kind, text}` where `text` = raw text with the ` (at <path>:<line>)`
  suffix stripped (fork error.rs:63-71 embeds the cargo-checkout source location — machine
  specific, unreproducible in C++; the harness strips ` \(at .+\)$` after the `reason`).
- kind 5 `pcm`: `{kind, pid, pts, streamType:6, programNum:channelCount, sampleCount,
  samplesSha256}` where the hash is over the `Float32Array` buffer bytes (little-endian),
  i.e. **raw f32 bit patterns** — not decimal forms.

**Everything EXACT** (string/number equality of the canonical stream). Justifications:

- PES bytes: reassembly is pure byte-append (lib.rs:929, 943) — sha256 + length suffice.
- NAL tables: deterministic byte scan, offsets are `[off,len]` pairs (nal.rs:85-152,
  lib.rs:700-714).
- **PCM bit-identical — confirmed realistic, do not soften.** `unwrap_smpte302m_pes` is
  stateless per sample: integer assembly (shift/or/mask, aes3.rs:77-111) + **one** f32
  multiply by SCALE_24=2⁻²³ / SCALE_20=2⁻¹⁹ / SCALE_16=2⁻¹⁵ (aes3.rs:66-68 — all exact
  powers of two); every decoded integer fits in ≤24 significant bits, so the int→f32
  conversion *and* the scaling multiply are both exact IEEE ops with **zero** rounding.
  No accumulation, no libm, no order dependence. Trailing partial chunks are dropped by
  `chunks_exact` (aes3.rs:78/91/104, test 279-284) — sample counts are deterministic.
- **Event order is fully determined** by packet order: one sequential loop per `feed()`
  (lib.rs:508-524); within a packet, RA event precedes payload events (lib.rs:846 vs 863);
  at a PesStart the previous partial flushes before the new partial's bounded flush
  (lib.rs:935-938); the pcm event follows its pes event immediately (lib.rs:743-752).
  ⇒ demand exact global order of the concatenated event stream (across feed calls).
  Chunk-boundary invariance is asserted by the self-test (§5).

### 4.2 DebugSnapshot (call after **every** `feed()` on both sides — it is `&self`,
side-effect-free, lib.rs:1376; pids sorted ascending, lib.rs:1377-1379)

- **EXACT** (integer or deterministically-derived): `programNum`, `pmtPid`, `pmtPids`,
  `pmtStreamTypes`, `pmtFormatIds`, `pids`, `pesCounts`, `byteTotals` (PES payload bytes
  only, lib.rs:933/945 — PSI/AF-only/null never counted), `raCounts`, `lastPts`, `lastDts`,
  `ptsJumps`, `ccErrors`, `teiCounts`, `pusiCounts`, `scramblingCounts` (flat 4×N),
  `afControlCounts` (flat 4×N, lib.rs:786-793), `pcrPids`, `pcrIntervalsMs` (one
  correctly-rounded divide of a wrapping u64 delta, lib.rs:824-825), `pcrJitterMs` (f64 EMA,
  fixed op order, lib.rs:826-830), `nalPids`, `nalStats` (flat 9×N, order
  I,P,B,IDR,SPS,PPS,SEI,AUD,NonIDR, lib.rs:1434-1443), `errorMsg` (canonicalized per §4.1),
  and the full ring: `ringPid`, `ringKind`, `ringPts`, `ringDts`, `ringSize`, `ringRa`,
  `ringTei`, `ringPusi`, `ringNal`, `ringNalOffsets` (N+1), `ringHex` (first ≤512 payload
  bytes, lowercase hex, lib.rs:45-56; ring cap 500, lib.rs:31).
- **EXCLUDED** (wall-clock derived — assert finite ≥ 0, otherwise ignore): `ringT`,
  `errorT` (elapsed-ms stamps, lib.rs:591-593), `bitratesMbps` (bytes_window rotates on
  wall time, lib.rs:639-658, 1288-1299). No other snapshot field depends on wall time
  (`PidStats.last_ra_ms` exists but is **not** exposed — accessors lib.rs:1130-1285).

### 4.3 MeterSnapshot (per `plan-notes/meter-parity.md` §2 — adopted verbatim)

`pids`, `channelCounts`, `peaks`, `clips`, `scopeL`, `scopeR`, `selectedPid`,
`selectedChannel`: **EXACT-BIT**. `rms`, `phase`: exact given mirrored order
(order-sensitive f64 chains, no libm). `lufs`, `spectrum`: **TOLERANT, abs 1e-6 dB**
(libm `log10`/`sin`/`cos`/`powf` cross libm boundaries; meter.rs:149, 334-335, 349, 364);
the −70.0 / −80.0 sentinels must match as literals. `meter_snapshot()` is **`&mut self` and
mutates** (latches/resets windows, meter.rs:419-485) — both sides must call it the same
number of times at identical feed boundaries. Cadence: after every `feed()` on S5–S7;
plus one extra pass over each 302M fixture with `setMeterSelection(pid, 1)` issued before
the first feed (lib.rs:1550-1554; exercises scope partner swap + spectrum on ch1,
meter.rs:302-315). C++ build side-conditions from meter-parity.md §4.3 apply (no
`-ffast-math`, `-ffp-contract=off`).

## 5. Rust-vs-Rust self-test shape (gate before any C++ exists, PLAN.md:78-79)

1. Import the Rust pkg **once** (`page/wasm/mpeg2ts-wasm` symlink); build **two independent
   `TsDemuxer` instances** from it.
2. Feed both the identical §1/§2 case list in **1128-byte chunks** (6×188, the live SRT
   payload size); after every `feed()` collect the canonical events (§4.1) and both
   snapshots (§4.2/4.3); compare the two sides' full canonical streams byte-for-byte.
   Trivially identical unless the harness itself is nondeterministic — that is the point.
3. **Chunk-boundary invariance**: rerun each fixture at chunk sizes {188, 1128, 7} (fresh
   instances per run); the *concatenated* event streams across all three runs must be
   identical (parsing is per-packet; FeedBuf carries remainders, lib.rs:146-157).
4. **Error-text canonicalizer check**: run C6 and assert (a) ≥1 kind-4 event, (b) the raw
   text matches `^ts parse: (InvalidInput|Unsupported|Other): .+ \(at .+:\d+\)$`, (c) the
   canonicalized text contains no ` (at ` — proves the §4.1 stripper is exact.
5. **Wall-clock isolation**: run one fixture twice and diff canonical output — proves
   `ringT`/`errorT`/`bitratesMbps` are excluded everywhere and nothing else leaks time.
6. On any mismatch: exit non-zero, print case id, event index, field name, both values
   (first divergence only). All green ⇒ harness proven; the C++ side then replaces instance
   B with `build/srt_engine.mjs` and reuses the identical protocol.

## 6. Risk register

1. **Error-text canonicalization** is the sharpest rule: the fork embeds
   `<cargo-checkout-path>:<line>` in every parse error (fork error.rs:63-71, surfaced at
   lib.rs:515-519). We compare everything before the ` (at …)` suffix. If a future oracle
   change adds multi-line reasons, the stripper regex must be revisited.
2. **Spectrum bin edges** use `powf` (meter.rs:349); a libm ulp at a `floor` boundary could
   shift a band by one bin. Mitigated as decided in meter-parity.md §2/§4.4 (edges are
   mathematically ≥1.5e-3 from integers; assert exact edges in the meter-level gate).
3. ffmpeg regen drift: sizes/sha guarded by §3 contract; manifest authoritative.
4. If S1's `-bf 3` output ever shows `dts=-1` on all video pes events (encoder option
   drift), the DTS parse path loses coverage — the harness must assert ≥1 pes event with
   `dts ≥ 0` in S1 and fail loudly otherwise.
