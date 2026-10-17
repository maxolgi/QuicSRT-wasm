# websrt-wasm-cpp

A C++/WASM port of WebSRT's Rust `srt-wasm` player engine — Haivision SRT
compiled with Emscripten, driven from a web worker, meant to replace the
Rust engine inside WebSRT's player worker. Renamed from `srt-wasm-cpp`
(the A/B harness still labels the engine "srt-wasm-cpp", parallel to the
Rust engine's "srt-wasm").

The receiver is libwebsrt's WT-free `ReceiverCore`
(`deps/libwebsrt/src/srt_session/`, consumed via its receiver-only
Emscripten CMake flavor). All srt-protocol work lives in the srt fork
(github.com/maxolgi/srt, branch `websrt`), pinned inside libwebsrt's own
`deps/srt`; fixes land there first, and this repo only builds and drives
it.

Build:

    ./build.sh setup   # init deps/libwebsrt + its nested deps/srt (falls
                       # back to the local libwebsrt clone for unpushed pins)
    ./build.sh lib     # configure + build libwebsrt's receiver-only flavor
                       # and the srt static lib with Emscripten
    ./build.sh engine  # build/srt_engine.mjs (gate: node js/test_contract.mjs)
    ./build.sh page    # bundle the player page + A/B harness

License: MPL-2.0, inherited from the srt fork.
