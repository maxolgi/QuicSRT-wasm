# QuicSRT-wasm pages (viewer / publisher / call)

Three pages, all ports of the QuicSRT-rust web pages onto the vendored
SDK (`page/vendor/`, adapted from the legacy TypeScript player), all
running 100% on the C++ wasm engine (`build/srt_engine.mjs` behind
`js/srt_engine.js`) — no Rust anywhere in the runtime:

- `index.html` + `main.ts` — the viewer: plays a live QuicSRT stream on
  a canvas
- `publish.html` + `publish.tsx` — the publisher (webcam/canvas ->
  WT/SRT)
- `call.html` + `call.tsx` — the 1:1 call
- `page/vendor/debug/` — the vendored Preact debug panel: a lazy chunk
  on the viewer (main.ts dynamic-imports it, keeping it off the critical
  path), inline-mounted on publish/call

`./build.sh page` bundles the three entries in ONE esbuild `--splitting`
run — `page/bundle/{main,publish,call}.js` plus the shared/lazy
`chunk-*` files (the workers build separately as `worker.js` /
`publish_worker.js`); `./build.sh deploy` copies `page/bundle/*`
wholesale into `dist/bundle/`, the html files + the `quicsrt.png` /
`favicon.ico` assets (the pages' `/quicsrt.png` favicon link) into
`dist/` root. The debug panel's data sources are the C++ engine exports
(`srtw_get_stats`, `tsd_debug_snapshot`, the tsd meter) flowing through
the vendored worker. Wasm-specific deltas kept vs the rust pages: the
`workerUrl` `/bundle/worker.js` + `/bundle/publish_worker.js` (instead
of vite worker imports), `?decode=` seeding, the `?source=canvas`
publisher mode, the `wt://host:port` URL shorthand + cert-hash.js
`CERT_HASH` pinning, and the `quicsrt-*` localStorage keys.

Viewer how-to:

- Serve: `./build.sh engine && ./build.sh page && ./build.sh deploy` — the
  supervised gateway serves `dist/` as its web_root
- Open: `https://127.0.0.1:8443/?stream=browsertest` (self-signed cert —
  accept it; COOP/COEP headers come from the gateway - the emcc engine
  needs pthreads)
- Gateway: the supervised `QuicSRT-gateway` service (WT udp 4435, SRT ingest
  9102, web https://127.0.0.1:8443, health 127.0.0.1:9292; see AGENTS.md).
  It serves `/cert-hash.js` same-origin (fresh hash each boot);
  `?host=`/`?port=`/`?stream=` override.
- Decode: `?decode=software|hardware` seeds the hw/sw WebCodecs preference
  (localStorage `quicsrt-hw-mode`); the `decode: hw/sw` button above the
  stats line flips it (page reloads). Software-only machines need software.
- Publish (SRT ingest, any ffmpeg with libsrt; gateway port 9102):

      ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -c:v libx264 -preset veryfast -f mpegts "srt://127.0.0.1:9102?streamid=test&mode=caller&latency=120"

  or WebTransport publish with the libquicsrt-patched ffmpeg (port 4435, hash
  file dance in `QuicSRT-gateway/scripts/QuicSRT-gateway-testpub.sh`).

Known deltas: worker.ts line 1 imports the C++ engine glue
`../../js/srt_engine.js` (engine API deltas documented in `js/srt_engine.js`);
demux.ts line 4 imports `../../js/demux_engine.js`
(the M5 C++ demuxer; deltas documented in
`js/demux_engine.js`). The M6 publisher pair
`vendor/stream-worker.ts` + `vendor/shared/publish.ts` adapts the same
way: stream-worker.ts swaps the engine import the same way and adapts
`flushTsToSrt()` to the C ABI `sendMessage()` return codes (deltas 1-2
documented in its header); shared/publish.ts only renames the
localStorage keys to quicsrt-*. stream-worker.ts
line 31 imports `../../js/muxer_engine.js`
(the M7 C++ muxer; delta 3 in its header, deltas
in `js/muxer_engine.js`). The cutover is complete: the player and
publisher runtime bundles run 100% on the C++ engine module.

## M5 perf snapshot (step 7, 2026-10-17)

Host `deb` (16 cores), Chrome 151, stream `browsertest` (testsrc2 640x360@30
libx264 + sine AAC, ~0.93 Mbps TS, 0 loss/drop) via the local `QuicSRT-gateway`
gateway, software WebCodecs decode — `prefer-hardware` configure proved
flaky in this Chrome for BOTH paths (identical `avc1.64001e` + avcC configs
rejected in a retry loop), so every run pins `?decode=software`. OLD = this
page replicated in a scratch rig with the pre-swap Rust demux import
restored (only the worker bundle differs, same esbuild flags); NEW = the
committed page as-is. A/B/A/B order, one browser window, fresh page load
per ~100 s window, canvas pixel-check liveness every 15 s (640x360,
animating in every run). Instrumented only from outside (injected-on-new-
document script wrapping `Worker` onmessage + PerformanceObserver longtask;
rig not committed). The worker-internal per-frame release-jitter metric
(`videoLatency` in the stats) never populates on either path — the engine's
deliver actions carry no `schedUs` — so the demux-side signal is the
main-thread PES cadence plus the worker's own loop stats.

| metric (per run, 2 runs per path) | OLD Rust pkg | NEW C++ module |
|---|---|---|
| videoPes inter-arrival p50 (ms) | 34.11 | 34.11–34.13 |
| videoPes inter-arrival p95 (ms) | 35.17–35.18 | 35.19–35.29 |
| videoPes inter-arrival p99 (ms) | 35.65–35.81 | 35.66–35.77 |
| videoPes inter-arrival max (ms) | 39.4–40.3 | 39.4–40.1 |
| video fps delivered | 30.0 | 30.0 |
| main-thread longtasks (n / TBT) | 0 / 0 ms | 0 / 0 ms |
| worker loop iter avg (ms) | 3.16–3.17 | 3.16 |
| worker worst loop cycle (ms) | 7.4–8.1 | 7.5–7.6 |
| nav → first videoPes (ms) | 225–279 | 158–293 |

Verdict: **no regression** — every metric matches within run-to-run noise.
The hoped-for tail improvement is NOT visible at this load (0.9 Mbps,
640x360, loopback): zero main-thread longtasks on both paths, and demux
runs in the worker whose heap/GC PerformanceObserver cannot see, so the
allocation-churn win stays unmeasured rather than disproven — a heavier
stream would be the honest test (the M5 stretch goal keeps its
"measured justification required" bar).

The M4 A/B harness that proved engine parity was removed when the
bring-up ended; see git history (and `js/engine_smoke.mjs`, which
keeps its fake-WebTransport engine end-to-end gate).

## M6 publisher page (`/publish.html`)

Publishes webcam video+audio from the browser through the vendored
publisher worker (`page/bundle/publish_worker.js` bundles
`vendor/stream-worker.ts`: WebCodecs encode + TS mux in the worker, both
on the C++ engine module since M7 — the muxer behind `js/muxer_engine.js`,
the SRT layer behind `js/srt_engine.js` as before). The driving
logic: `init`
(WT url + certHash + latency + video/audio encoder config, certHash
transferred) starts a session, `VideoFrame`s flow as transferred `frame`
messages from the vendored credit-based `FramePump` (rVFC-paced), mic audio
rides a transferred `audio-port` from the vendored `AudioGraphManager`,
`stop` + terminate ends it; `batch`-wrapped `log`/`credit`/`wtReady`/
`handshakeComplete`/`close`/`wtClosed`/`stats` come back (stats rendered
with the vendored `formatPubStats`).

- Serve/run: same as the player (`./build.sh page && ./build.sh deploy`),
  open `https://127.0.0.1:8443/publish.html` (or
  `https://127.0.0.1:8443/publish.html?source=canvas` for the no-camera
  mode below), Capture (getUserMedia), then Publish. Round-trip check:
  the viewer link (or the M3 player with the same `?stream=` name) plays
  it back.
- `?source=canvas` (automated-gate / no-camera mode, M6 step 5 enabler):
  replaces the getUserMedia capture with an animated canvas test pattern
  (crawling color bars + counting timestamp + per-run id) via
  `canvas.captureStream(30)`, feeding the exact same downstream path
  (preview element, FramePump/rVFC, codec detection, worker protocol).
  Audio stays absent - the selector is disabled at `(none)` and no mic is
  acquired - so this mode covers neither the mic-audio path nor real
  device capture; without the param the page is unchanged (getUserMedia).
- URL: the `url:` field, default `wt://127.0.0.1:4435` (the local
  `QuicSRT-gateway` gateway; `wt://host:port` is shorthand for
  `https://host:port/wt`). The `publish=` query always comes from the
  stream-name field (localStorage-persisted random 8-char key); `?token=` on the page URL passes through. cert-hash.js drives
  pinning exactly like the player (`window.CERT_HASH` hex -> serverCertificateHashes,
  null = PKI mode, no pinning).
- UI deltas, deliberate: webcam-only getUserMedia
  capture (no screen capture / tab audio / camera picker - default device),
  a plain `<pre>` log instead of the preact debug panel, no stream-back
  player in the page (the M3 player serves that role), the URL input above
  instead of `?host=`/`?port=`/`window.WT_PORT` resolution, and the
  pre-bundled `/bundle/publish_worker.js` instead of vite's
  `new URL('./stream-worker.ts')` (the same delta as the player's
  `workerUrl`).

## M6 verification (2026-10-17, gateway-served, live)

All against the supervised C++ gateway (`dist/` via
`./build.sh page && ./build.sh deploy`; `browsertest` from the supervised
testpub). Node gates first, all exit 0: `js/test_contract.mjs`,
`js/demux_parity.mjs`, `js/muxer_parity.mjs` (golden-baseline gates vs
`js/fixtures/*.baseline.json`), `js/engine_smoke.mjs`.

- Player (`/?stream=browsertest`): `crossOriginIsolated === true`, canvas
  640x360 animating (two full-frame pixel sums 2 s apart differ:
  145717350 vs 145855757), stats ticking across a 30 s watch with zero
  loss; the session later ran 20 min continuously (140.0 MB rx, loss 0).
  GPU-less box: hardware decode produced no frames silently - the page's
  own `prefer-software` toggle (`localStorage["quicsrt-hw-mode"]`) makes it
  decode; player verification used it.
- Publisher (`/publish.html?source=canvas`, foreground tab): stream
  `m6verA`, canvas 1280x720 H.264 (`avc1.640028`), 30 fps while the tab is
  foregrounded, `SRT handshake complete` instantly, LIVE alongside a
  concurrently streaming player tab. Background tabs throttle the canvas
  rAF to ~1 fps, which starves late joiners of keyframes (see below) -
  keep the publisher foregrounded while testing.
- Record 20 s with the patched ffmpeg (live hash via `cert_hash_file`,
  the testpub script's pattern - the hash rotates per gateway boot):

      ../libquicsrt/deps/ffmpeg/ffmpeg \
        -f mpegts -i "quicsrt://127.0.0.1:4435?stream=m6verA&cert_hash_file=/tmp/opencode/m6-cert-hash.js" \
        -c copy -t 20 -y /tmp/opencode/m6_cpp.ts

  (`m6-cert-hash.js` is a fresh `curl -sk https://127.0.0.1:8443/cert-hash.js`
  capture; `cert_hash=HEX` also works, bare hex - no `0x` prefix.) The
  command consumed the live stream and wrote a valid 1.5 MB / 9.0 s file,
  then stalled in ffmpeg's live `-c copy` remux (its h264 parser reports
  `non-existing PPS` mid-GOP and stops emitting; the same bytes parse
  flawlessly offline - see ffprobe below). The full-20 s raw wire capture
  via the sibling repo's `quicsrt-dump` (same libquicsrt subscriber):
  3349784 B / 20.2 s / 3234 messages, lost 0 rtx 0 dropped 0, rate
  1.41 mbps.
- ffprobe (`-v error`, zero errors) on the raw 20 s capture: one stream -
  `h264` 1280x720 High, `r_frame_rate` = `avg_frame_rate` = 30000/1001,
  duration 19.905633 s, matching the page's audio=`(none)` (video only).
  In-band PSI is healthy: 15 PAT + 15 PMT + 15 IDR/SPS/PPS keyframe bursts
  in the window (the muxer re-emits PSI on every keyframe, every ~2 s at
  30 fps).
- Playback: `/?stream=m6verA` in a second tab, 21.9 s connected,
  `crossOriginIsolated === true`, canvas 1280x720 animating (pixel sums
  526202890 vs 526157251), rx 662 msg, loss 0 - while the publisher tab
  and a third browsertest player session kept running.
- TX stats while publishing (page line, 6 s apart): `LIVE ... sent:
  83.2 MB` -> `83.3 MB`, loss 0 (the `↑` number is the measured
  txBytes/elapsedMs tx rate; the SRT available-link-bandwidth estimate
  it used to show is labeled `Link BW (est.)` in the player's SRT tab).
- Gateway `/stats` corroboration: `m6verA alive viewers 2` with the
  publisher session at 77420 messages received and both viewer sessions
  tx_data advancing; `browsertest` untouched alongside.

Fixes that made the multi-tab case pass (this commit):

- `js/pthread_spawn_guard.js` (installed by `js/engine_module.js` before
  the module import): Chrome 151 cancels nested pthread module-worker
  script loads (a bare `error` Event, `net::ERR_ABORTED`) once other busy
  engine workers share the renderer - same-origin COOP/COEP tabs share one
  process, so a streaming player tab aborted 3-of-4 publisher pthread
  spawns, and emscripten's rethrow killed the worker mid-handshake. The
  guard tees pre-ready postMessages, retries aborted loads on a fresh
  worker with exponential backoff, and replays the tee (pass-through on
  the happy path - deferring delivery would deadlock the load handshake).
- `js/engine_module.js` also routes the engine's `printErr` through a
  `SRT.br` filter in the browser: srt's "CRcvBuffer.readMessage()" warning
  flood (hundreds per second under load) is one console round-trip each
  and amplifies the renderer contention; Node keeps the raw stream.
