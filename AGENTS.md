# QuicSRT-wasm agent notes

C++/WASM port of the QuicSRT player/publisher engine — ReceiverCore + TS
demux/mux behind one emscripten module. Byte-parity vs the Rust pkgs
was proven at the recorded baseline commits; the `js/*_parity.mjs`
gates now pin the port to the committed golden baselines, standalone.

## Build/test map

- `./build.sh setup` — init deps/libquicsrt + nested deps/srt
- `./build.sh lib` — libquicsrt receiver-only flavor + the srt static lib
  with Emscripten
- `./build.sh engine` — build/srt_engine.mjs + .wasm (the one module both
  the player and the publisher drive)
- `./build.sh page` — bundle the player + publisher pages
  (needs engine)
- `./build.sh deploy` — assemble the self-contained dist/ the gateway
  serves as web_root (needs page)
- CI (`.github/workflows/ci.yml`) — the full chain + the node gates on
  GitHub Actions (ubuntu-24.04, emsdk 6.0.8 at ~/emsdk); uploads dist/
  as a workflow artifact and publishes `quicsrt-wasm-dist.zip` as a
  GitHub release on master pushes (`dev-<short_sha>`, latest) and `v*`
  tags (stable)
- Node gates (exit 0 = pass):
  - `node js/test_contract.mjs` — engine wrapper contract (the in-wasm
    synthetic publisher)
  - `node js/demux_parity.mjs` — demux regression gate vs the committed
    golden baseline js/fixtures/demux.baseline.json (`--record` re-records
    and prints the drift diff)
  - `node js/muxer_parity.mjs` — muxer regression gate vs
    js/fixtures/muxer.baseline.json (`--record` likewise)
  - `node js/engine_smoke.mjs` — fake-WebTransport end-to-end engine gate
    (the in-wasm publisher piped through a fake transport into a second
    engine instance; verifies 2000 messages delivered byte-identical plus
    stats/bucket accounting; needs `./build.sh engine`)
- Fixtures: `js/fixtures/` (sha/size-gated by manifest.sha256, which
  gates the .ts files only); the golden baselines live alongside and are
  validated by their provenance field + the `--record` drift diff;
  `js/fixtures/gen.sh` regenerates the .ts fixtures — recovery only,
  ffmpeg lines are verbatim from the spec, the committed manifest is
  authoritative
- Parity contracts live in `plan-notes/` (parity-spec, abi-census,
  meter-parity, publisher-surface, debug-consumers). PLAN.md is retired;
  `git show a654b0e^:PLAN.md` for the historical log.

## Live testing

Live testing goes through the ONE supervised C++ gateway — never start
ad-hoc gateways, extra testpub instances, or ad-hoc static file servers
(the old local node-server flow is retired; deploy and let the gateway
serve).

- Supervisord program `QuicSRT-gateway` (the QuicSRT-gateway repo's
  binary): WT ingest 0.0.0.0:4435, SRT ingest 0.0.0.0:9102, web HTTPS
  0.0.0.0:8443 (self-signed, cert_mode self), health 127.0.0.1:9292
- `QuicSRT-gateway-testpub` (also supervised) publishes stream `browsertest` —
  the default live-test stream
- A supervised Rust oracle gateway from the sibling repo runs on
  4433/9000/9091 — do NOT mix them up; this repo's live testing uses the
  C++ one
- Deploy + serve flow:

      ./build.sh page && ./build.sh deploy
      # gateway serves dist/ as web_root:
      #   player   https://127.0.0.1:8443/?stream=browsertest
      #   publish  https://127.0.0.1:8443/publish.html

- The gateway serves player responses with COOP/COEP headers (required
  by the pthreads emcc engine) and generates `/cert-hash.js` same-origin
  (`window.CERT_HASH` + `window.WT_PORT`)
- Config: `/etc/QuicSRT-gateway/gateway.conf` — root-owned; agents in this
  harness CANNOT edit it or sudo ("no new privileges"). Any config
  change or supervisorctl restart/reload needing root goes to the human
- Reload after a config change: `kill -HUP <pid>` — by PID, never `pidof`
  on a gateway name (name patterns can match BOTH gateways' binaries).
  HUP of the C++ gateway works without sudo (the process is owned by
  flibb)
- Diagnosis: `curl http://127.0.0.1:9292/health`, `curl
  http://127.0.0.1:9292/stats`, `/var/log/QuicSRT-gateway/{gateway,testpub}.err.log`

## Boundary rules

- Agents commit their own work; stage only intended files, never push
- Concurrent sessions are possible — `.git/index.lock` present means
  another agent is committing: wait and retry, don't delete it
- Aborted agents orphan processes — kill what YOU started before
  reporting done
