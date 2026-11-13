# QuicSRT-wasm

C++/WASM player/publisher engine for QuicSRT — SRT compiled with
Emscripten, driven from a web worker.

Build:

    ./build.sh setup   # init deps/libquicsrt + nested deps/srt
    ./build.sh lib     # build libquicsrt's receiver-only flavor + the srt
                       # static lib with Emscripten

## SDK

The player is packaged as two npm libraries, assembled by `./build.sh sdk`
(templates in `sdk/`, output in `sdk-dist/`):

- `@quicsrt/player` — the SDK: `mountPlayer()` returning an
  HTMLMediaElement-shaped handle, plus the `<quicsrt-video>` custom
  element (`@quicsrt/player/element`). Ships the worker and the wasm
  engine in-package.
- `@quicsrt/videojs` — a video.js v8 tech playing `quicsrt://` and
  `application/quicsrt` sources through the player SDK.

Embedding guide — routes, source URLs, cert pinning, COOP/COEP:
[docs/embedding.md](docs/embedding.md).

License: MPL-2.0
