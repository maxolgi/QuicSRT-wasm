# srt-wasm-cpp

Spike: a C++/WASM port of WebSRT's Rust `srt-wasm` player engine — Haivision
SRT compiled with Emscripten, driven from a web worker, meant to replace the
Rust engine inside WebSRT's player worker.

All protocol work lives in the srt fork (`~/maxolgi/srt`, branch `websrt`,
github.com/maxolgi/srt), vendored as the `deps/srt` submodule. Fixes land
there first; this repo only builds and drives it.

Build:

    ./build.sh setup   # init deps/srt (falls back to the local fork for unpushed pins)
    ./build.sh lib     # configure + build the srt static lib with Emscripten

License: MPL-2.0, inherited from the srt fork.
