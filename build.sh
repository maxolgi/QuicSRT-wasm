#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./build.sh <command>

Commands:
    setup    One-time: init deps/srt (falls back to the local fork clone for
             unpushed pins)
    lib      Configure + build the srt static lib with Emscripten
    harness  Build the M1 loopback gate test (build/loopback.js)
    replay   Build the M2 receiver replay gate test (build/replay.js)
    engine   Build the M3 JS engine wrapper module (build/srt_engine.mjs,
             driven through js/srt_engine.js; gate: node js/test_contract.mjs)
    page     Bundle the M3 player page (page/bundle/{app,worker}.js) with the
             WebSRT checkout's esbuild; needs ./build.sh engine first
EOF
}

case "${1:-}" in
    setup)
        git submodule update --init deps/srt
        # DEV FALLBACK: fork commits may be local-only until the human pushes
        # ~/maxolgi/srt (branch websrt), so the pinned SHA can be missing from
        # the GitHub clone -- fetch it from the local fork and check it out.
        pinned="$(git ls-tree HEAD deps/srt | awk '{print $3}')"
        if ! git -C deps/srt cat-file -e "${pinned}^{commit}" 2>/dev/null; then
            git -C deps/srt fetch /home/flibb/maxolgi/srt websrt 2>/dev/null || true
            if [ "$(git -C deps/srt rev-parse HEAD)" != "$pinned" ]; then
                git -C deps/srt checkout "$pinned"
            fi
        fi
        ;;
    lib)
        source ~/emsdk/emsdk_env.sh
        emcmake cmake -S deps/srt -B build/srt \
            -DCMAKE_BUILD_TYPE=Release \
            -DENABLE_ENCRYPTION=OFF \
            -DENABLE_VIRTUAL_TRANSPORT=ON \
            -DENABLE_APPS=OFF \
            -DENABLE_SHARED=OFF \
            -DENABLE_STATIC=ON \
            -DCMAKE_C_FLAGS="-pthread -fexceptions" \
            -DCMAKE_CXX_FLAGS="-pthread -fexceptions"
        cmake --build build/srt -j "$(nproc)" --target srt_static
        ;;
    harness)
        source ~/emsdk/emsdk_env.sh
        em++ harness/loopback.cpp build/srt/libsrt.a -o build/loopback.js \
            -fexceptions -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -Os \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            -Ideps/srt/srtcore -Ideps/srt/common -Ibuild/srt
        ;;
    replay)
        source ~/emsdk/emsdk_env.sh
        em++ harness/replay_test.cpp harness/receiver.cpp harness/stats_map.cpp build/srt/libsrt.a \
            -o build/replay.js \
            -fexceptions -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=1 -Os \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            -Ideps/srt/srtcore -Ideps/srt/common -Ibuild/srt
        ;;
    engine)
        source ~/emsdk/emsdk_env.sh
        # EXPORT_ES6: the player worker loads this as an ES module
        # (WebSRT web/src/shared/viewer.ts spawns a module worker), so the
        # emcc output must be importable - classic MODULARIZE scripts are
        # not. The .mjs extension also lets node import it directly.
        em++ harness/receiver.cpp harness/stats_map.cpp js/engine_shim.c build/srt/libsrt.a \
            -o build/srt_engine.mjs \
            -fexceptions -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -Os \
            -sMODULARIZE=1 -sEXPORT_NAME=createSrtEngineModule -sEXPORT_ES6=1 \
            -sEXPORTED_FUNCTIONS=_srtw_init,_srtw_engine_new,_srtw_engine_receiver,_srtw_handle_datagram,_srtw_poll,_srtw_poll_outgoing,_srtw_get_stats,_srtw_engine_free,_srtw_test_publisher_start,_srtw_test_publisher_inject,_srtw_test_publisher_poll,_malloc,_free \
            -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64 \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            -Iharness -Ideps/srt/srtcore -Ideps/srt/common -Ibuild/srt
        ;;
    page)
        # esbuild from the WebSRT checkout (no npm install here). The worker
        # bundle keeps ../build/srt_engine.mjs EXTERNAL: the emcc module must
        # be served as its own file because it spawns its pthread workers by
        # self-importing srt_engine.mjs (and fetches the .wasm relative to
        # itself) - serve.mjs maps /build/ to this repo's build/.
        [ -f build/srt_engine.mjs ] || { echo "build/srt_engine.mjs missing - run ./build.sh engine first" >&2; exit 1; }
        ESBUILD="$HOME/maxolgi/WebSRT/web/node_modules/.bin/esbuild"
        [ -x "$ESBUILD" ] || { echo "esbuild not found at $ESBUILD" >&2; exit 1; }
        # demux.ts's ../wasm/mpeg2ts-wasm (the built wasm pkgs, read-only
        # reference to the WebSRT checkout - same layout depth as web/src)
        ln -sfn "$HOME/maxolgi/WebSRT/web/wasm" page/wasm
        mkdir -p page/bundle
        "$ESBUILD" page/vendor/worker.ts --bundle --format=esm \
            --external:../build/srt_engine.mjs --outfile=page/bundle/worker.js
        "$ESBUILD" page/main.ts --bundle --format=esm --outfile=page/bundle/app.js
        # wasm-bindgen glue resolves its wasm via new URL(..., import.meta.url)
        # -> the bundle's own directory
        cp "$HOME/maxolgi/WebSRT/web/wasm/mpeg2ts-wasm/mpeg2ts_wasm_bg.wasm" page/bundle/
        ;;
    -h | --help | help)
        usage
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac
