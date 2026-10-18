# QuicSRT-wasm

C++/WASM player/publisher engine for QuicSRT — SRT compiled with
Emscripten, driven from a web worker. Renamed from `websrt-wasm-cpp`
(originally `srt-wasm-cpp`).

Build:

    ./build.sh setup   # init deps/libquicsrt + nested deps/srt
    ./build.sh lib     # build libquicsrt's receiver-only flavor + the srt
                       # static lib with Emscripten

License: MPL-2.0
