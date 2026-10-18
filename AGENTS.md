# websrt-wasm-cpp agent notes

C++/WASM port of WebSRT's player/publisher engine — ReceiverCore + TS
demux/mux behind one emscripten module, proven byte-parity vs the Rust
pkgs by `js/*_parity.mjs`.

## Build/test map

- `./build.sh setup` — init deps/libwebsrt + nested deps/srt (falls back
  to the local libwebsrt clone for unpushed pins)
- `./build.sh lib` — libwebsrt receiver-only flavor + the srt static lib
  with Emscripten
- `./build.sh harness` / `replay` — M1/M2 gate tests (build/loopback.js,
  build/replay.js)
- `./build.sh engine` — build/srt_engine.mjs + .wasm (the one module both
  the player and the publisher drive)
- `./build.sh page` — bundle the player + A/B + publisher pages
  (needs engine)
- `./build.sh deploy` — assemble the self-contained dist/ the gateway
  serves as web_root (needs page)
- Node gates (exit 0 = pass):
  - `node js/test_contract.mjs` — engine wrapper contract (the in-wasm
    synthetic publisher)
  - `node js/demux_parity.mjs [--cpp --m5-stage meter]` — demux parity vs
    the Rust mpeg2ts-wasm pkg
  - `node js/muxer_parity.mjs [--cpp]` — muxer parity vs the Rust
    ts-muxer-wasm oracle
  - `node page/ab_smoke.mjs` — static A/B harness gate (needs
    `./build.sh page`)
- Fixtures: `js/fixtures/` (sha/size-gated by manifest.sha256);
  `js/fixtures/gen.sh` regenerates — recovery only, ffmpeg lines are
  verbatim from the spec, the committed manifest is authoritative
- Parity contracts live in `plan-notes/` (parity-spec, abi-census,
  meter-parity, publisher-surface, debug-consumers). PLAN.md is retired;
  `git show a654b0e^:PLAN.md` for the historical log.

## Live testing

Live testing goes through the ONE supervised C++ gateway — never start
ad-hoc gateways, extra testpub instances, or ad-hoc static file servers
(the old local node-server flow is retired; deploy and let the gateway
serve).

- Supervisord program `websrt-cpp` (the websrt-gateway-cpp repo's
  binary): WT ingest 0.0.0.0:4435, SRT ingest 0.0.0.0:9102, web HTTPS
  0.0.0.0:8443 (self-signed, cert_mode self), health 127.0.0.1:9292
- `websrt-cpp-testpub` (also supervised) publishes stream `browsertest` —
  the default live-test stream
- A supervised Rust oracle gateway from the sibling repo runs on
  4433/9000/9091 — do NOT mix them up; this repo's live testing uses the
  C++ one
- Deploy + serve flow:

      ./build.sh page && ./build.sh deploy
      # gateway serves dist/ as web_root:
      #   player   https://127.0.0.1:8443/?stream=browsertest
      #   A/B      https://127.0.0.1:8443/ab.html?stream=browsertest
      #   publish  https://127.0.0.1:8443/publish.html

- The gateway serves player responses with COOP/COEP headers (required
  by the pthreads emcc engine) and generates `/cert-hash.js` same-origin
  (`window.CERT_HASH` + `window.WT_PORT`)
- Config: `/etc/websrt-cpp/gateway.conf` — root-owned; agents in this
  harness CANNOT edit it or sudo ("no new privileges"). Any config
  change or supervisorctl restart/reload needing root goes to the human
- Reload after a config change: `kill -HUP <pid>` — by PID, never
  `pidof websrt-gateway` (it matches BOTH gateways' binaries). HUP of
  the C++ gateway works without sudo (the process is owned by flibb)
- Diagnosis: `curl http://127.0.0.1:9292/health`, `curl
  http://127.0.0.1:9292/stats`, `/var/log/websrt-cpp/{gateway,testpub}.err.log`

## Boundary rules

- Agents commit their own work; stage only intended files, never push
- Concurrent sessions are possible — `.git/index.lock` present means
  another agent is committing: wait and retry, don't delete it
- Aborted agents orphan processes — kill what YOU started before
  reporting done
