#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./build.sh <command>

Commands:
    setup    One-time: init deps/libwebsrt + its nested deps/srt (falls back
             to the local libwebsrt clone for unpushed pins)
    lib      Configure + build libwebsrt's receiver-only flavor + the srt
             static lib with Emscripten (WEBSRT_ENABLE_WT=OFF,
             WEBSRT_RECEIVER_ONLY=ON -> websrt::receiver-core)
    harness  Build the M1 loopback gate test (build/loopback.js)
    replay   Build the M2 receiver replay gate test (build/replay.js)
    engine   Build the M3 JS engine wrapper module (build/srt_engine.mjs,
             driven through js/srt_engine.js; gate: node js/test_contract.mjs)
    page     Bundle the M3 player page + M4 A/B harness
             (page/bundle/{app,worker,ab,ab_worker}.js) with the WebSRT
             checkout's esbuild; needs ./build.sh engine first
EOF
}

# libwebsrt's Emscripten flavor: the WT-free ReceiverCore (compiled by the
# libwebsrt configure as a static lib) over the srt fork. Paths and lib
# artifacts shared by the link steps below.
SRT_INC="-Ideps/libwebsrt/deps/srt/srtcore -Ideps/libwebsrt/deps/srt/common -Ibuild/libwebsrt/deps/srt"
LW_INC="-Ideps/libwebsrt/src"
LW_LIB="build/libwebsrt/libwebsrt_receiver_core.a"
# the srt submodule's own CMake puts its archive at the configure root
SRT_LIB="build/libwebsrt/libsrt.a"

case "${1:-}" in
    setup)
        # || true: with an unpushed pin the GitHub clone cannot check out
        # the gitlink SHA and submodule update exits nonzero - the DEV
        # FALLBACK below is what recovers, so it must stay reachable.
        git submodule update --init deps/libwebsrt || true
        # DEV FALLBACK: libwebsrt commits may be local-only until the human
        # pushes ~/maxolgi/libwebsrt (master), so the pinned SHA can be
        # missing from the GitHub clone -- fetch it from the local checkout
        # and check it out (goes dormant once every pin is pushed).
        pinned="$(git ls-tree HEAD deps/libwebsrt | awk '{print $3}')"
        if ! git -C deps/libwebsrt cat-file -e "${pinned}^{commit}" 2>/dev/null; then
            git -C deps/libwebsrt fetch /home/flibb/maxolgi/libwebsrt master 2>/dev/null || true
            if [ "$(git -C deps/libwebsrt rev-parse HEAD)" != "$pinned" ]; then
                git -C deps/libwebsrt checkout "$pinned"
            fi
        fi
        # The nested srt pin rides the libwebsrt commit checked out above.
        # Run inside the submodule, NOT --recursive: libwebsrt also carries
        # deps/lsquic (WT-only) and srt its test submodules - neither builds
        # here and they would just be cloned.
        git -C deps/libwebsrt submodule update --init deps/srt
        ;;
    lib)
        source ~/emsdk/emsdk_env.sh
        emcmake cmake -S deps/libwebsrt -B build/libwebsrt \
            -DCMAKE_BUILD_TYPE=Release \
            -DWEBSRT_ENABLE_WT=OFF \
            -DWEBSRT_RECEIVER_ONLY=ON \
            -DCMAKE_C_FLAGS="-pthread -fexceptions" \
            -DCMAKE_CXX_FLAGS="-pthread -fexceptions"
        cmake --build build/libwebsrt -j "$(nproc)" --target websrt_receiver_core
        ;;
    harness)
        source ~/emsdk/emsdk_env.sh
        # CJS marker: the emcc output uses require(); without this the
        # nearest package.json (~: "type": "module", the desktop app's)
        # makes node reject it as ESM. The .mjs engine output is exempt
        # by extension.
        printf '{"type":"commonjs"}\n' > build/package.json
        em++ harness/loopback.cpp "$SRT_LIB" -o build/loopback.js \
            -fexceptions -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -Os \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            $SRT_INC
        ;;
    replay)
        source ~/emsdk/emsdk_env.sh
        printf '{"type":"commonjs"}\n' > build/package.json
        em++ harness/replay_test.cpp harness/receiver.cpp harness/stats_map.cpp "$LW_LIB" "$SRT_LIB" \
            -o build/replay.js \
            -fexceptions -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -Os \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            -Iharness $LW_INC $SRT_INC
        ;;
    engine)
        source ~/emsdk/emsdk_env.sh
        # EXPORT_ES6: the player worker loads this as an ES module
        # (WebSRT web/src/shared/viewer.ts spawns a module worker), so the
        # emcc output must be importable - classic MODULARIZE scripts are
        # not. The .mjs extension also lets node import it directly.
        em++ harness/receiver.cpp harness/stats_map.cpp js/engine_shim.c "$LW_LIB" "$SRT_LIB" \
            -o build/srt_engine.mjs \
            -fexceptions -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -Os \
            -sMODULARIZE=1 -sEXPORT_NAME=createSrtEngineModule -sEXPORT_ES6=1 \
            -sEXPORTED_FUNCTIONS=_srtw_init,_srtw_engine_new,_srtw_engine_receiver,_srtw_handle_datagram,_srtw_poll,_srtw_poll_outgoing,_srtw_get_stats,_srtw_engine_free,_srtw_test_publisher_start,_srtw_test_publisher_inject,_srtw_test_publisher_poll,_malloc,_free \
            -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64 \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            -Iharness $LW_INC $SRT_INC
        ;;
    page)
        # esbuild from the WebSRT checkout (no npm install here). The worker
        # bundles keep ../build/srt_engine.mjs EXTERNAL: the emcc module must
        # be served as its own file because it spawns its pthread workers by
        # self-importing srt_engine.mjs (and fetches the .wasm relative to
        # itself) - serve.mjs maps /build/ to this repo's build/.
        [ -f build/srt_engine.mjs ] || { echo "build/srt_engine.mjs missing - run ./build.sh engine first" >&2; exit 1; }
        ESBUILD="$HOME/maxolgi/WebSRT/web/node_modules/.bin/esbuild"
        [ -x "$ESBUILD" ] || { echo "esbuild not found at $ESBUILD" >&2; exit 1; }
        # demux.ts's ../wasm/mpeg2ts-wasm and ab_worker.ts's
        # ./wasm/srt-wasm/srt_wasm.js (the built wasm pkgs, read-only
        # reference to the WebSRT checkout - same layout depth as web/src)
        ln -sfn "$HOME/maxolgi/WebSRT/web/wasm" page/wasm
        # the bundles' external ../build/srt_engine.mjs resolves relative to
        # page/bundle/ - serve.mjs maps /build/ to the repo for the browser,
        # this symlink gives node (page/ab_smoke.mjs) the same view
        ln -sfn ../build page/build
        mkdir -p page/bundle
        "$ESBUILD" page/vendor/worker.ts --bundle --format=esm \
            --external:../build/srt_engine.mjs --outfile=page/bundle/worker.js
        "$ESBUILD" page/main.ts --bundle --format=esm --outfile=page/bundle/app.js
        # M4 A/B harness: the ab worker bundles BOTH engine glues (rust
        # wasm-bindgen + the C++ js wrapper) and picks one per instance at
        # the start command; same --external treatment for the emcc module.
        "$ESBUILD" page/ab_worker.ts --bundle --format=esm \
            --external:../build/srt_engine.mjs --outfile=page/bundle/ab_worker.js
        "$ESBUILD" page/ab.ts --bundle --format=esm --outfile=page/bundle/ab.js
        # wasm-bindgen glue resolves its wasm via new URL(..., import.meta.url)
        # -> the bundle's own directory
        cp "$HOME/maxolgi/WebSRT/web/wasm/mpeg2ts-wasm/mpeg2ts_wasm_bg.wasm" page/bundle/
        cp "$HOME/maxolgi/WebSRT/web/wasm/srt-wasm/srt_wasm_bg.wasm" page/bundle/
        ;;
    -h | --help | help)
        usage
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac
