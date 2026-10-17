# Debug consumers: field usage + retention audit (M5 input)

Sources read: `~/maxolgi/WebSRT/web/src/debug/` (13 files), `web/src/{demux,pcm-player,worker}.ts`,
`web/src/shared/viewer.ts`, `web/src/player/index.ts`, `~/maxolgi/WebSRT/crates/mpeg2ts-wasm/src/{lib,meter}.rs`,
and the ported copies under `page/` (`page/vendor/{demux,worker,pcm-player,decode}.ts`, `page/main.ts`).
`page/vendor/worker.ts`, `demux.ts`, `pcm-player.ts`, `decode.ts`, `shared/viewer.ts` are byte-identical to
WebSRT except the engine import (diff-verified; README pins @854c25c) — all WebSRT line citations hold for the
vendored copies too. The Rust demux (`lib.rs:249,289-303,1141-1284,1321-1367`) **clones every Vec/String in every
getter** — all demux output reaching JS today is a JS-owned copy. That is the contract every consumer below
silently leans on.

## 1. Consumer map

| Consumer | Role | Demux data touched |
|---|---|---|
| `web/src/worker.ts` (worker) | owns `Demuxer`; per-PES/PCM callbacks queue msgs; `getDemuxStats()`; meter timer | TsEvent data/nal/samples; DebugSnapshot; meter |
| `web/src/demux.ts` | wasm-bindgen wrapper; dispatches events; meterSnapshot → plain arrays | all TsEvent accessors; MeterSnapshotView |
| `web/src/decode.ts` | VideoPipeline (h264/hevc/av1), audio pipelines | PES bytes, nalOffsets/nalTypes |
| `web/src/shared/viewer.ts` (main) | worker-msg router; creates pipelines/PcmPlayer | videoPes/audioPes/pcm/meter msgs |
| `web/src/pcm-player.ts` | AudioWorklet sink for PCM | pcm samples |
| `web/src/player/index.ts` | SDK; re-emits `stats`/`audiometer` CustomEvents | DemuxStats POJO, AudioMeterData |
| `web/src/debug/index.ts` | mounts panel; store writes; meter channel-select | DemuxStats, AudioMeterData |
| `debug/store.ts` | signals; `demuxStats`, `audioMeter`, `snapA/B`, history cap 300 | retains POJOs |
| `debug/sampler.ts` | 10 Hz buckets: video/audio Mbps + ccErrors from snapshot | pids, pmt*, bitratesMbps, ccErrors |
| `debug/diagnostics.ts` + `diff.ts` | issue-report JSON; A/B snapshot diff | all non-ring fields (serialized); retained in snapA/B |
| `debug/issues.ts` | health strip thresholds | ccErrors, errorMsg, ptsJumps, pcrIntervalsMs |
| `debug/components/DemuxTab.tsx`, `PacketTimeline.tsx` (+`packetUtils.ts`), `StreamTab.tsx` | tables, packet timeline, CC counter | nearly all snapshot fields |
| `debug/components/AudioTab.tsx` | meters/scope/spectrum/pacing | all meter fields |
| `debug/components/charts/{Bitrate,PidDonut,Cc,Ra,PtsJump,Pcr,NalStacked}*` | charts off store/history | pids, byteTotals, raCounts, ptsJumps, pcrIntervalsMs, nal* |
| wasm-cpp `page/main.ts` | player page | **none** — reads only `detail.stats` (17 SrtStats fields), drops `d.demux` (main.ts:36-52). The vendored worker still computes `getDemuxStats()` every stats tick (wasted until M5 step 6 vendors the debug UI). |

## 2. Field usage table

DebugSnapshot accessors (37) + MeterSnapshotView (12). "LB" = LOAD-BEARING (wrong value/length/layout breaks
logic or corrupts a whole view), "DISP" = DISPLAYED. Layouts that are part of the contract: per-PID arrays
parallel to `pids`; `scramblingCounts`/`afControlCounts` flat 4×N (`lib.rs:1080`); `nalStats` flat 9×M
(`lib.rs:1081`); `ringNalOffsets` N+1 entries (`lib.rs:1082-1083`). pids iterate ascending (`lib.rs:1377-1378`).

### DebugSnapshot

| Field | Consumers (file:line) | Drives | Rank |
|---|---|---|---|
| programNum | DemuxTab:100; diagnostics:70 | Program table row | DISP |
| pmtPid | DemuxTab:101; diagnostics:71 | Program table row | DISP |
| pmtPids | sampler:94-100; DemuxTab:117-138,335-343; PacketTimeline:80-86; PidDonut:119-121; RaTimeline:30-33 | PID→codec classification (video/audio split) feeding bitrate pick, row classes, donut labels, RA chart | **LB** |
| pmtStreamTypes | same as pmtPids | codec classification + stream table | **LB** |
| pmtFormatIds | sampler:98; DemuxTab:59-66,121; PidDonut:119-121; RaTimeline:33 | AV01/Opus disambiguation of 0x06 | **LB** |
| pids | sampler:92,107-111; DemuxTab:53-56,183; PidDonut:45-49; issues (via sums) | key array — every per-PID index join | **LB** |
| pesCounts | DemuxTab:124; diagnostics:76 | PES column | DISP |
| byteTotals | DemuxTab:69-72 (top-2 pick); PidDonut:49; diagnostics:77 | PTS-panel row pick, donut | DISP |
| bitratesMbps | sampler:108-109 → history → BitrateChart, SrtTab | history Mbps (chart data path) | **LB** |
| raCounts | DemuxTab:125; RaTimeline:38; diagnostics:79 | RA column, RA timeline | DISP |
| lastPts / lastDts | DemuxTab:155-156; diagnostics:80-81 | PTS/DTS table | DISP |
| ptsJumps | DemuxTab:157; PtsJumpSparkline:28; issues:76-79; diagnostics:82 | issue strip warn + sparkline | **LB** |
| ccErrors | sampler:110 → history (CcHeatmap:42, LossCorrelation:47, SrtTab:27); DemuxTab:74,126,186; StreamTab:95; issues:69-72; diagnostics:83 | issue strip **error**, heatmap, counters | **LB** |
| teiCounts / pusiCounts | DemuxTab:213-214; diagnostics:84-85 | TS header flags table | DISP |
| scramblingCounts / afControlCounts | DemuxTab:208-216 (4×N unpack); diagnostics:86-87 | flags table — layout error = garbage row | DISP (layout LB) |
| pcrPids | DemuxTab:254-267; PcrChart:105; diagnostics:88 | PCR table/chart gating | DISP |
| pcrIntervalsMs | DemuxTab:257-263; PcrChart:106-108; issues:80-83; diagnostics:89 | issue strip warn (>100 ms), chart | **LB** |
| pcrJitterMs | DemuxTab:258-264; diagnostics:90 | PCR table | DISP |
| nalPids / nalStats | DemuxTab:332-395 (9×M unpack); NalStackedBar:41-57; diagnostics:91-92 | NAL table + stacked bar | DISP (layout LB) |
| errorT / errorMsg | DemuxTab:226-241; issues:73-75; diagnostics:93-94 | demux-errors table; issue strip **error** count (errorMsg **LB**, errorT DISP) | errorMsg **LB** |
| ringT | PacketTimeline:61,65-72,242,410-414 | ring length drives virtualization + auto-scroll | **LB** |
| ringPid | PacketTimeline:93,202-203,240,490-495 | pid filter, video/audio row class, prev-same-PID logic | **LB** |
| ringKind | PacketTimeline:94,98-103,241 | kind filter + row class (codes 0/1/2/3/4/255) | **LB** |
| ringPts / ringDts | PacketTimeline:243-244,263-264,302-303,313-317,341-344 | row/inspector timing + jump warn | DISP |
| ringSize | PacketTimeline:96,245,265,356 | min-size filter, size col | **LB** |
| ringRa / ringTei / ringPusi | PacketTimeline:246-247,268-269,305-307,330-332 | flags badges/inspector | DISP |
| ringNal | PacketTimeline:457-488,521 (via offsets) | NAL summary/inspector | DISP |
| ringNalOffsets | PacketTimeline:458-459,475-476,519-520 | N+1 slice layout for ringNal | **LB** |
| ringHex | PacketTimeline:320-321,394 | hex dump inspector | DISP |

### MeterSnapshotView

| Field | Consumers | Drives | Rank |
|---|---|---|---|
| pids | debug/index.ts:110-117; AudioTab:240 | channel-select global→per-PID translation; PIDs count | **LB** |
| channelCounts | debug/index.ts:111-116 | same translation — wrong = wrong scope/spectrum channel | **LB** |
| peaks | AudioTab:169 (`ch = meter.peaks.length` → **every** subtab's channel count),174-186,264,339 | channel count + peak meters | **LB** |
| rms | AudioTab:340 | LUFS table | DISP |
| clips | AudioTab:267,344-345 | clip dot + table | DISP |
| lufs | AudioTab:341-342 | LUFS table (class thresholds) | DISP |
| phase | AudioTab:362 | phase bars | DISP |
| scopeL / scopeR | AudioTab:87-113 | vectorscope canvas | DISP |
| spectrum | AudioTab:139-155 | spectrum canvas | DISP |
| selectedPid / selectedChannel | AudioTab:243-244,417 | overview + scope caption; must round-trip `setMeterSelection` | DISP |

Counts: snapshot 37 = 14 LB + 23 DISP + 0 unused; meter 12 = 3 LB + 9 DISP + 0 unused. **No field is unused** —
`diagnostics.ts:67-95` serializes nearly all of them into every issue report. Split: all 49 are consumed only by
WebSRT's debug UI; the wasm-cpp page consumes zero today (main.ts:36-52), though its vendored worker already
produces them (vendor/worker.ts = worker.ts:854-904).

## 3. Retention audit (demux-returned data kept past the feed() callback)

| # | Site (file:line) | What's retained | How long | View-safe? |
|---|---|---|---|---|
| H1 | `worker.ts:336-338` (`outgoing`) filled by onPes `worker.ts:481-483` | videoPes/audioPes `data` + `nalOffsets`/`nalTypes` | across **multiple `demux.feed()` calls** — a poll batch drains N deliver actions (`worker.ts:737-783`), each feed queues before the single flush at `worker.ts:727` | **NO** — view invalid at feed #2 |
| H2 | `worker.ts:490` (onPcm → queue) | pcm `samples` | same as H1 (queued across feeds until flush) | **NO** |
| H3 | `worker.ts:351-357` and `363-377` | transfer lists push `m.data.buffer`, `m.samples.buffer`, `m.nalOffsets/nalTypes.buffer` | post time | **NO — catastrophic**: if data are views on the C++ heap, `.buffer` IS the whole wasm memory; transferring it detaches the shared engine+demux heap (M5 puts both in one module). Worker dies mid-stream. |
| H4 | `worker.ts:469-477` (decodeInWorker) → `decode.ts:605,780,788` `pendingNalus` | whole PES `payload` + nal arrays | until decoder configures — arbitrarily many feeds later; replayed at `decode.ts:799` | **NO** |
| H5 | `decode.ts:762-772` | `this.vps/sps/pps = payload.subarray(...)` | session lifetime (compared against every later PES) | **NO** (worker mode; main-thread mode H7 is post-clone) |
| H6 | `worker.ts:854-904` `getDemuxStats()` | POJO of all 37 fields; **`snap.free()` at :902 runs BEFORE the postMessage clone** (flush at :306/:381, :546) | until next stats tick (250 ms/1 s) | **NO** — views into snapshot storage are freed pre-clone; garbage JSON/stats |
| H7 | `viewer.ts:463-489` (main) | `msg.data`→VideoPipeline (same decode.ts retention as H4/H5, post-clone); `msg.samples` captured in `pcmPlayer.init().then()` closure `viewer.ts:481-485` — retained across a promise | until AudioContext ready | safe today (postMessage already cloned); breaks if anyone "optimizes" the clone away |
| H8 | `pcm-player.ts:61` → worklet | pcm samples via `port.postMessage` (clone, no transfer) | worklet ring, seconds | safe (clone at post) |
| H9 | `debug/index.ts:70,73` → `store.ts:26,29`; `store.ts:47-48` snapA/B; sampler history (`store.ts:50-54`) | DemuxStats POJO / AudioMeterData / serialized diagnostics | 250 ms–1 s; snapA/snapB unbounded (user-held) | safe — main-thread clones/plain arrays (`diagnostics.ts:72-94` `Array.from`) |
| H10 | `demux.ts:55-73` meterSnapshot | reads getters via `Array.from` then `s.free()` at :71 | values copied before free | safe **only because** Array.from copies before free — keep that ordering |

PostMessage itself structured-clones (never transfers) the `stats`/`meter` POJOs (`worker.ts:381-385` with
transfer list covering only PES/PCM buffers), so H6/H10 data reaching the main thread is always a copy — the
hazard is confined to the worker side of the boundary.

## 4. Verdict

**Must be exactly right in the C++ port (LB set):** `pids` + index-parallelism of every per-PID array;
`pmtPids`/`pmtStreamTypes`/`pmtFormatIds` (codec classification drives the sampler, charts, timeline colors);
`bitratesMbps`, `ccErrors`, `ptsJumps`, `pcrIntervalsMs`, `errorMsg` (issue strip + history data); ring geometry:
`ringT` length, `ringPid`, `ringKind` (codes 0/1/2/3/4/255), `ringSize`, `ringNalOffsets` (N+1); meter
`pids`/`channelCounts`/`peaks` (peaks.length *is* the channel count, AudioTab:169). The 4×N / 9×M / N+1 layouts
and ascending-pid iteration (`lib.rs:1374-1378`) are contract, not detail.

**Returns that must stay copies despite the zero-copy goal** (retention crosses a feed boundary or a free()):
- `TsEvent.data`, `TsEvent.nalOffsets`, `TsEvent.nalTypes` — H1/H3/H4/H5 (queue-across-feeds + heap-detach transfer + decode.ts caches).
- `TsEvent.samples` — H2/H3/H8.
- All 37 `DebugSnapshot` getters (or change free semantics) — H6 frees before the post clone; either copy in the
  getter like wasm-bindgen does today, or make `free()` defer release until the next `debugSnapshot()`/`feed()`.

**Can be views:** `MeterSnapshotView` fields — `demux.ts:55-73` copies them into JS arrays synchronously before
`free()`, and no feed can interleave (single-threaded timer tick); keep that read-then-free ordering and the
50 ms timer's synchronous queue+flush (`worker.ts:308-315`).

**Consumers silently depending on wasm-bindgen copying today:** every one of them — no consumer copies before
retaining. Worst offenders: `worker.ts` outgoing queue + transfer lists (H1-H3), `decode.ts` pendingNalus and
vps/sps/pps caches (H4/H5), and `getDemuxStats` free-before-post (H6).

**Scariest single hazard:** H3 — `worker.ts:363-377` pushes `.buffer` of PES/PCM/nal arrays into the postMessage
transfer list. With C++ heap views those buffers are the entire shared linear memory; a transfer detaches it and
kills engine + demux together, only when the player path runs (not in a node parity harness — it would pass
parity and die in the browser).
