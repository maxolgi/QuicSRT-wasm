# websrt-wasm-cpp

C++/WASM port of WebSRT's Rust `srt-wasm` player engine — SRT compiled
with Emscripten, driven from a web worker. Renamed from `srt-wasm-cpp`.

Build:

    ./build.sh setup   # init deps/libwebsrt + nested deps/srt
    ./build.sh lib     # build libwebsrt's receiver-only flavor + the srt
                       # static lib with Emscripten

License: MPL-2.0
