# Publisher surface — M6 vendoring contract

WebSRT pin: **854c25c2e9ab51a1438d2d4604d13077f679b1ef** (`git -C ~/maxolgi/WebSRT rev-parse HEAD`,
2026-10-17). Same commit `page/vendor` is already vendored at (page/README.md:5).

Sources (all `~/maxolgi/WebSRT/`): `web/src/stream-worker.ts` (566 lines, read in full),
`web/src/shared/publish.ts` (345), `web/src/stream.tsx`, `web/src/call.tsx`,
`web/wasm/srt-wasm/srt_wasm.d.ts`, `web/wasm/ts-muxer-wasm/ts_muxer_wasm.d.ts`,
`crates/srt-wasm/src/lib.rs`, `crates/ts-muxer/src/lib.rs`.
Target repo: `~/maxolgi/WebSRT-cpp/websrt-wasm-cpp` (PLAN.md M6, steps 4–5 at PLAN.md:113–121).

## 0. Who drives the worker

| Driver | Spawn | init payload | cert hash | Stop |
|---|---|---|---|---|
| `stream.tsx` (publish page) | `new Worker(new URL('./stream-worker.ts', …), {type:'module'})` stream.tsx:387 | cmd 391–401: `wtUrl` (`?publish=<name>` 380–382), `latencyMs` from input 384, video cfg from UI, optional audio cfg | `window.CERT_HASH` hex → `hexToBytes` 369–371 (publish.ts:7–14); buffer **transferred** 399–401 | `{cmd:'stop'}` + `terminate()` 419–423 |
| `call.tsx` (call page) | same pattern 296–298 | 300–311: `CALL_LATENCY_MS`, fixed fps/bitrate consts | `certHashForUrl()` 319–322, transferred 308–310 | 327–330 |

Worker → page msgs (`PublishMsg`, stream-worker.ts:36–44), batched as `{type:'batch',msgs:[…]}` via
`queue()`/`flushOutgoing()` (124–132, flushed after every handler 119). Page reacts: `credit` →
FramePump credit (stream.tsx:442–443), `handshakeComplete` → `framePump.start()` + playback mount
(449–458), `stats` → `formatPubStats` (publish.ts:333–345) showing **bandwidthBps, txBytes, rttMs,
txLoss** (+encode-side fps/encodeMs/queueDepth).

## 1. Engine contract — every `SrtReceiver` touch in stream-worker.ts

Import (stream-worker.ts:1): `initSrt` default + `SrtReceiver`, types `SrtAction`, `SrtStats`.

| Member | Call site(s) | Exact shape / semantics |
|---|---|---|
| `initSrt()` (default export) | 141, guarded by `srtWasmReady` (73) | awaited once per worker lifetime; must be idempotent |
| `SrtReceiver.newWithLatencyAndRtt(latencyMs, initialRttMs)` | 232–233 | only when WT `getStats()` exposed `smoothedRtt > 0` (probe 224–230); seeds RTT EWMA (srt_wasm.d.ts:58–63) |
| `SrtReceiver.newWithLatency(latencyMs)` | 234 | fallback path; `latencyMs` = page input (stream.tsx:384) / `CALL_LATENCY_MS` (call.tsx:304) |
| `rx.handle_datagram(bytes, nowUs)` | 454 | `bytes` = raw WT datagram `Uint8Array`; `nowUs` = `(performance.now() − epoch) × 1000` µs (448); return actions processed inline |
| `rx.sendMessage(tsBytes, nowUs)` | 417 | **the publish call**: `tsBytes` = entire `muxer.poll()` output in ONE call (413–417), i.e. all TS bytes since last flush (multiples of 188 B; at 1 Mbps/30 fps ≈ ~4 kB per video chunk). Rust side feeds duplex sender which fragments into SRT packets itself (lib.rs:391–406, `handle_data_input` 396); returns `SendDatagram` actions — one per SRT packet (≤ ~1500 B) — processed by the same `processActions` |
| `rx.poll(nowUs)` | 464 every loop cycle; 10× burst on visibility regain 91–97 | advances state machine + drains outgoing ring; nowUs same epoch base (416/448) |
| `rx.isHandshakeComplete()` | 411 | **send gate**: `flushTsToSrt()` returns early until true; Rust side no-ops sends pre-handshake anyway (lib.rs:404) |
| `rx.getStats()` | 109, 256 | 1 Hz `setInterval` (254–261); `debug-rate` cmd re-arms it, min 100 ms (103–116); result may be checked for null (110/257 — Rust returns an object, never null) |
| `SrtAction.kind` + `takeData()`/`free()` | 473–501 | kinds consumed: **0 SendDatagram → `writeDatagram(a.takeData())`**; 1 DeliverMessage → ignored; **2 HandshakeComplete → queue msg + immediate `flushTsToSrt()` kick** (sends any TS buffered pre-handshake); 3 WaitForData → ignored; **4 Close → queue `{type:'close'}`**; 5 Log → `a.text` logged; `a.free()` in `finally` 497–499 |
| `free()` | **never called on `rx`** — `doStop` just nulls it (298–303) | only `muxer.free()` happens; Rust object relies on GC/finalizers. C++ engine has no FinalizationRegistry → see §5 |
| `SrtStats` fields read | 540–566 `serializeStats` reads **all 17** (elapsedMs, rttMs, bandwidthBps, rxData/rxBytes/rxLoss/rxRetransmit/rxDropped/rxBelated/rxBuffered/rxAck/rxNak, txData/txBytes/txRetransmit/txLoss/txBuffered); `emitLossEvents` deltas **txLoss** 519–525; page displays bandwidthBps/txBytes/rttMs/txLoss (publish.ts:334–343) |

### Wire mechanics (how actions reach WebTransport)

- **Datagrams only, never streams**: kind-0 → `writer.write(bytes)` on the WT **datagrams**
  writable (503–515); fire-and-forget with `.catch` log — no await, no backpressure signal beyond
  the writer's own queue. Reader side built with `createReadable/createWritable` **or**
  `.readable/.writable` fallback (235–244).
- **Send pacing = encoder-paced, not timed**: `flushTsToSrt()` fires per encoded video chunk
  (365), per audio chunk (404), on handshake-complete kick (484), and up to 10× on tab-visible
  (91–97). No timers, no rate limit.
- **Main loop** (`runSrtLoop` 424–471): infinite `Promise.race` of next WT datagram read vs
  **5 ms tick** (POLL_MS 433); datagram win → `handle_datagram` (454); **every** cycle ends with
  `rx.poll(nowUs)` + `flushOutgoing()` (464–465); tracks `pollMaxMs` 467–469. Exits on gen change,
  reader done/error (450–461).
- **Init order** (`doInit` 136–270): wasm inits (141–142) → epoch reset (145) → `new TsMuxer` +
  `setVideoCodec` (153–155) → VideoEncoder (annexb for H.264, hw→sw probe fallback, 158–188) →
  optional Opus AudioEncoder 48 kHz (191–211) → `inited = true` (213, second gate for
  `flushTsToSrt` 410) → `new WebTransport(url, opts)` + `await wt.ready` (216–221) → RTT probe →
  receiver ctor (232–234) → datagram reader/writer (235–244) → `wt.closed` watch (246–248) →
  `wtReady` msg → `runSrtLoop` (252) → 1 Hz stats timer (254–261).
- **Teardown** (`doStop` 274–306): clear stats timer → `flush()+close()` both encoders → close
  audio port → **`muxer.free()`** → null wt/reader/writer/rx, `inited=false` → `wt.close({})`.
  `gen++` at every stop/init (100, 137) invalidates stale callbacks.
- **cert-hash handling**: worker only consumes `init.certHash: Uint8Array|null` → sets
  `serverCertificateHashes: [{algorithm:'sha-256', value}]` on `WebTransportOptions` when non-null
  (216–219); `null` (online/PKI mode) → no pinning. Hex decode + transfer-buffer mechanics live in
  the pages (§0).

## 2. Muxer contract — every `TsMuxer` touch

Import (stream-worker.ts:2): `initMux` default + `TsMuxer` from `../wasm/ts-muxer-wasm/ts_muxer_wasm.js`.
**Muxer stays Rust in M6** (PLAN.md:115–116). API per ts_muxer_wasm.d.ts:4–29 / lib.rs.

| Method | Call site(s) | Exact args |
|---|---|---|
| `initMux()` | 142 (`muxWasmReady` guard 74) | awaited once per worker lifetime |
| `new TsMuxer()` | 153 | no args; defaults relied on — see below |
| `setVideoCodec(codec)` | 154–155 | `'av1'` iff `videoCfg.codec.startsWith('av01')`, else `'h264'`. Rust mapping (lib.rs:123–134): av1 → private stream type + AV1 descriptor, h264 (default arm) → H264. (`'hevc'` arm exists, unused here) |
| `push_video(data, pts_us, dts_us, is_keyframe)` | 348–351 | `data` = `EncodedVideoChunk` copyTo buffer (H.264 = **annexb**, forced at 167–169; AV1 = OBUs); `pts = dts = chunk.timestamp` (**µs**, WebCodecs timestamp — muxer converts to 90 kHz internally, lib.rs:278); `is_keyframe = chunk.type === 'key'` |
| `push_audio(data, pts_us)` | 400–403 | `data` = Opus `EncodedAudioChunk` bytes (encoder: opus/48 kHz/`audioCfg.channels`/bitrate, 192–210); `pts_us = chunk.timestamp` (µs) |
| `poll()` | 413 | → `Uint8Array`, **drains all** accumulated TS output (`mem::take`, lib.rs:269–271); empty → send skipped (414) |
| `free()` | 294 (doStop) | releases wasm muxer |

Unused by this worker (must simply not be needed): `setAudioCodec`, `addAudioPid`, `push_pcm`,
`push_pcm_pid`, `setSparseEnabled`, `setSparseThreshold`, `setVideoEnabled`. Audio path rides the
**constructor defaults**: video PID 0x100 (H264 or AV1 after setVideoCodec), audio stream PID
**0x101 Opus 2ch**, PMT PID 0x1000 (lib.rs:15–17, 93–121). The worker never picks PIDs and never
configures audio on the muxer.

**poll() → sendMessage chunking**: one `poll()` per flush trigger (§1 "send pacing"); the entire
returned byte string (N × 188-byte TS packets, lib.rs:13) goes into a **single**
`rx.sendMessage(tsBytes, nowUs)`; the engine fragments/packs into SRT datagrams. No splitting,
sizing, or pacing in JS.

## 3. Vendoring deltas (into `page/`)

Pattern to mirror: page/vendor/worker.ts:1 + page/README.md:25–27 ("Known deltas").

| File (web/src) | → vendored as | import edits |
|---|---|---|
| `stream-worker.ts` | `page/vendor/stream-worker.ts` | **line 1 only**: `from '../wasm/srt-wasm/srt_wasm.js'` → `from '../../js/srt_engine.js'` (exact mirror of page/vendor/worker.ts:1, incl. `type SrtAction, type SrtStats` — js/ has **no .d.ts**; esbuild erases type-only imports without checking, this already works for worker.ts). Line 2 muxer import **unchanged**; line 3 `import type { StatsMsg } from './worker'` **unchanged** (resolves to vendored page/vendor/worker.ts, which exports `StatsMsg` at its line 26 — superset of the base 21 fields stream-worker.ts:540–563 assigns, so it type-fits). |
| `shared/publish.ts` | `page/vendor/shared/publish.ts` | **none** — its only imports are type-only `'../stream-worker'` and `'./worker'` (publish.ts:2–3), both resolve correctly inside page/vendor/. All runtime exports (hexToBytes, CODEC_CANDIDATES, detectCodec, TIMER_WORKER_SRC, CAPTURE_WORKLET, AudioGraphManager, FramePump, attachDebugResizer, formatPubStats) are self-contained. |

**Vendoring closure = exactly 2 new files.** Transitive imports of the pair:
`../wasm/srt-wasm/srt_wasm.js` (swapped → engine), `../wasm/ts-muxer-wasm/ts_muxer_wasm.js`
(kept, via symlink), `./worker` (type-only, already vendored). Nothing else in web/src is reached —
no demux/decode/render/player/store files, no other shared/* module.

Build side (confirm against build.sh `page` case 102–132): `page/wasm` symlink
`ln -sfn ~/maxolgi/WebSRT/web/wasm page/wasm` (114) makes `../wasm/ts-muxer-wasm/…` resolve from
page/vendor/* exactly as from web/src/* (comment 111–113). A new esbuild entry for the publisher
worker needs the same `--external:../build/srt_engine.mjs` (120–121 — js/srt_engine.js dynamically
imports it, line 75) and a copy of `ts_muxer_wasm_bg.wasm` into `page/bundle/` (wasm-bindgen glue
resolves its wasm via `import.meta.url`, comment 129–132; currently only mpeg2ts + srt wasm are
copied, 131–132). Vendoring note must record pin 854c25c like page/README.md:5.

## 4. Page-side obligations (for the M6/M7 publish page, not the worker)

The driver page must provide: `window.CERT_HASH` hex or null (stream.tsx:369/528–535),
`window.WT_PORT` fallback + `?host/?port/?token` URL params (376–382), codec detect
(`detectCodec` publish.ts:23–49: av01.0.08M.08 then avc1.640028, annexb probe), `FramePump` with
credit loop from `credit` msgs (publish.ts:207–273), `AudioGraphManager` + `audio-port` transfer
(publish.ts:181–185), batched-msg dispatch (stream.tsx:433–435).

## 5. Gaps vs `js/srt_engine.js` (C++ engine today)

| Required by publisher | Status in js/srt_engine.js |
|---|---|
| `init()` default export | ✅ idempotent (72–84) |
| `newWithLatency` / `newWithLatencyAndRtt` | ✅ (157–163; ctor takes latency + rtt 136–145) |
| `handle_datagram(bytes, nowUs)` | ✅ (170–190) |
| `poll(nowUs)` | ✅ (195–221) |
| `isHandshakeComplete()` | ✅ (223–225) — but **derived** (first `srtw_get_stats` success, 281–286); gates all sends, must fire on the publish connection |
| `getStats()` 17 fields incl. tx* | ✅ shape (234–255; STATS_KEYS 93–98) — tx values come from the C stats map; verify they populate once a send path exists |
| `SrtAction` kind/takeData/free/text | ✅ plain-object form (124–133) — worker only uses takeData/free (454–499), compatible |
| **`sendMessage(bytes, nowUs)`** | ❌ **MISSING — the one blocker** (documented 30–32: C ABI receive-only). Needs libwebsrt ReceiverCore send path + C ABI growth (PLAN.md:101–109) |
| `free()` on rx | ✅ exists (268–277) but worker never calls it (§1) — C engine holds a socket + pthread per instance; without a FinalizationRegistry every publish session leaks. Decide: add finalizer to the wrapper or a vendoring delta that calls `rx.free()` in `doStop` |

Deltas 2–5 (srt_engine.js:33–42) are receive-path notes that also bound the publish path:
`now_us` args are ignored (C engine keeps real clocks — send timing must come from srt itself, JS
epoch µs cannot be honored literally); kind 3/5 never emitted (publisher treats both as ignorable —
cosmetic only). One publish-specific risk: the outgoing shim ring (`BUF_CAP` 2048, 117–118;
drop counter + warning, 261–315) currently only carries handshake/ACK/NAK traffic — once
`sendMessage` exists it also carries **media datagrams**, where a stalled JS drain silently drops
payload; `getDroppedOutgoing()` (261–266, exposed but unread by the worker) should go on the M6
verification checklist alongside `js/test_contract.mjs`'s publisher case (PLAN.md:110–112).
