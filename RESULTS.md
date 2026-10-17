# Results: C++ SRT engine in the browser (spike)

Verdict: **PROCEED** — the Haivision fork runs correctly as a browser engine; every kill
criterion came back green. All numbers below are from this machine, 2026-10-16.

## Gates

| Gate | Result |
|---|---|
| M0 build | fork compiles under Emscripten (`-pthread`, `-fexceptions`, VT on, crypto off); node smoke: `srt_startup`/`srt_create_socket` + log handler from JS |
| M1 loopback (make-or-break) | exit 0: skip-induction handshake, 20000 x 1128 B byte-exact in-order, one-shot loss -> NAK recovery (rcvLoss=1 rcvRetrans=1 rcvDrop=0), RTT seed readback; ~3.1 s (pacing-bound, ~= native) |
| M2 receiver + stats | replay gate exit 0; contract test through the JS API exit 0; all 17 Rust `SrtStats` fields mapped, none zeroed |
| M3 live | in-browser vs local websrt-gateway-cpp: handshake, 75k msgs / 52.8 MB delivered, rtt 0.5 ms, demux -> valid avc1 config |
| M4 A/B (live, 35 s, both engines, zero loss/drop both sides) | see below |
| M5 libwebsrt consume | receiver delegates to libwebsrt's WT-free ReceiverCore (deps/libwebsrt receiver-only Emscripten flavor); loopback/replay/contract/ab_smoke green; live A/B vs websrt-cpp: 14/14 aligned buckets byte-exact, 0 loss/drop; bonus: player vs the RUST gateway (the 940-payload HSv5 quirk, never tested before) decodes video; engine 788 KB |

## M4 A/B — same live stream, two engines, one page (commit b6a4fc0 harness)

| | Rust srt-wasm | C++ srt-wasm-cpp |
|---|---|---|
| delivered | 7289 msg / 4.75 MB | 7309 msg / 4.77 MB (D +0.27%) |
| aligned interior seconds, byte-exact | 34/34 buckets match | 34/34 buckets match |
| full-run SHA-256 | differs (expected: engines join at different offsets; the per-second aligned buckets are the gate and are byte-exact) |
| loss / drop | 0 / 0 | 0 / 0 |
| rtt min/med/max | 0.1 / 0.1 / 0.1 ms | 0.2 / 0.3 / 0.8 ms |
| engine size (js+wasm) | 326 KB | 804 KB (2.47x; kill line was 2 MB) |

Message-count deltas per second are +-0 to +-11 (0.0-0.3%): same byte stream, different
SRT message pacing at second boundaries.

## Kill criteria review

- eventfd/wake fork surgery unshippable? NO — condvar wake, +77 lines in the seam, Linux path byte-identical.
- COOP/COEP unacceptable? NO — plain static server, no side effects.
- TSBPD jitter / drop storms vs Rust? NO — zero drops live; M1 recovery proven; rtt sub-ms.
- wasm > 2 MB? NO — 804 KB total.

## Accepted deltas (documented in `js/srt_engine.js`)

schedUs telemetry 0 (release timing inside libsrt threads); fixed ~5 ms tick (no kind-3
waits); kind-5 log actions never emitted; `sendMessage` not implemented (worker.ts never
calls it); stats are plain numbers, actions plain objects.

## Known limitations

- libwebsrt pin is local until pushed: `deps/libwebsrt` @ e5277c9 adds the
  `WEBSRT_RECEIVER_ONLY` CMake flavor (the srt fork pin inside it, f1617ea,
  is pushed). Push `~/maxolgi/libwebsrt` (master) and `build.sh setup`'s
  local-fetch fallback goes dormant.
- Visual playback VERIFIED (after M3 writeup): the page's decode pipeline defaulted to
  `prefer-hardware`, which this GPU-less machine's Chrome rejects (VideoDecoder.configure
  OperationError; the reference player hits the same wall). The vendored hw/sw toggle
  (`?decode=software`, localStorage `websrt-hw-mode`) fixes it: live 1920x1080 slopshady
  stream renders through the C++ engine (54k msgs / 64 MB, rtt 5.4 ms, canvas pixels
  changing). The page server runs under supervisord (`websrt-wasm-cpp-page`, :8099).
- ~30 stderr lines/run of fork `CRcvBuffer.readMessage()` warnings in node tests (pre-existing
  fork race, benign, both engines' harness unaffected).
- CPU/memory of pthread stacks not measured this spike; note `-fexceptions` is required at
  build AND link (srt's C API translates internal CUDTExceptions; without it the first
  routine timeout aborts the module).

## Reproduce

    ./build.sh setup && ./build.sh lib && ./build.sh harness && node build/loopback.js
    ./build.sh replay   && node build/replay.js
    ./build.sh engine   && node js/test_contract.mjs
    ./build.sh page     && node page/serve.mjs   # player + /ab.html A/B harness
