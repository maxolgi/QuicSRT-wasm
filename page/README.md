# M3 minimal player page

Plays a live WebSRT stream on a canvas through the C++ wasm engine
(`build/srt_engine.mjs` behind `js/srt_engine.js`). `page/vendor/` is the
vendored WebSRT player SDK (byte-identical to WebSRT @ 854c25c except the
one engine-swap line in `worker.ts`); `page/wasm` is a symlink to
WebSRT/web/wasm (the built demuxer wasm pkgs - read-only reference).

- Serve: `./build.sh engine && ./build.sh page && node page/serve.mjs`
- Open: `http://localhost:8099/?stream=test` (localhost is a secure context;
  COOP/COEP headers come from serve.mjs - the emcc engine needs pthreads)
- Gateway: the local `websrt-cpp` supervisord service (WT udp 4435, web
  https://127.0.0.1:8443). serve.mjs proxies `/cert-hash.js` from it (fresh
  hash each boot); `?host=`/`?port=`/`?stream=` override.
- Publish (SRT ingest, any ffmpeg with libsrt; gateway port 9102):

      ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -c:v libx264 -preset veryfast -f mpegts "srt://127.0.0.1:9102?streamid=test&mode=caller&latency=120"

  or WebTransport publish with the libwebsrt-patched ffmpeg (port 4435, hash
  file dance in `websrt-gateway-cpp/scripts/websrt-cpp-testpub.sh`).

Known deltas: worker.ts line 1 swaps the Rust glue import for
`../../js/srt_engine.js` (engine API deltas documented in `js/srt_engine.js`);
`page/wasm` is a symlink, not vendored sources.
