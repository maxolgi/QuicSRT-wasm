# srt-wasm-cpp

C++/WASM port of WebSRT's Rust `srt-wasm` player engine —
SRT compiled with Emscripten, driven from a web worker.

Build:

    ./build.sh setup   # init deps/srt (falls back to the local fork for unpushed pins)
    ./build.sh lib     # configure + build the srt static lib with Emscripten

License: MPL-2.0
