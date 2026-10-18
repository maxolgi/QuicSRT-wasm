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
    engine   Build the M3 JS engine wrapper module (build/srt_engine.mjs,
             driven through js/srt_engine.js; gate: node js/test_contract.mjs)
    page     Bundle the M3 player page + M6 publisher page
             (page/bundle/{app,worker,publish,publish_worker}.js) with the
             local esbuild (package.json - npm install);
             needs ./build.sh engine first
    deploy   Assemble the self-contained dist/ tree the supervised gateway
             serves as web_root: page html + page/bundle + the engine module
             at dist/build/ (the bundles' external ../build/srt_engine.mjs);
             needs ./build.sh page first
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
        # pushes ~/maxolgi/WebSRT-cpp/libwebsrt (master), so the pinned SHA can be
        # missing from the GitHub clone -- fetch it from the local checkout
        # and check it out (goes dormant once every pin is pushed).
        pinned="$(git ls-tree HEAD deps/libwebsrt | awk '{print $3}')"
        if ! git -C deps/libwebsrt cat-file -e "${pinned}^{commit}" 2>/dev/null; then
            git -C deps/libwebsrt fetch "$HOME/maxolgi/WebSRT-cpp/libwebsrt" master 2>/dev/null || true
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
    engine)
        source ~/emsdk/emsdk_env.sh
        # EXPORT_ES6: the player worker loads this as an ES module
        # (WebSRT web/src/shared/viewer.ts spawns a module worker), so the
        # emcc output must be importable - classic MODULARIZE scripts are
        # not. The .mjs extension also lets node import it directly.
        # harness/ts_demux.cpp + harness/nal.cpp + harness/aes3.cpp +
        # harness/meter.cpp: the M5 demux C ABI (incl. the nal.rs scanner,
        # the aes3.rs 302M unwrapper and the meter.rs DSP) alongside the
        # receiver (js/demux_engine.js wraps the tsd_* exports).
        # harness/ts_muxer.cpp: the M7 muxer C ABI (ts-muxer-wasm oracle
        # surface; js/muxer_engine.js wraps the tsm_* exports).
        # -ffp-contract=off: no FMA contraction in the meter's f64 chains
        # (plan-notes/meter-parity.md 2/4 - rms/phase are exact-bit given
        # mirrored order; there is no -ffast-math anywhere).
        em++ harness/receiver.cpp harness/stats_map.cpp harness/ts_demux.cpp harness/nal.cpp harness/aes3.cpp harness/meter.cpp harness/ts_muxer.cpp js/engine_shim.c "$LW_LIB" "$SRT_LIB" \
            -o build/srt_engine.mjs \
            -fexceptions -ffp-contract=off -pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1 -Os \
            -sMODULARIZE=1 -sEXPORT_NAME=createSrtEngineModule -sEXPORT_ES6=1 \
            -sEXPORTED_FUNCTIONS=_srtw_init,_srtw_engine_new,_srtw_engine_receiver,_srtw_handle_datagram,_srtw_poll,_srtw_send_message,_srtw_poll_outgoing,_srtw_dropped_outgoing,_srtw_get_stats,_srtw_engine_free,_srtw_test_publisher_start,_srtw_test_publisher_inject,_srtw_test_publisher_poll,_malloc,_free,_tsd_new,_tsd_free,_tsd_feed,_tsd_event_take,_tsd_event_free,_tsd_ev_kind,_tsd_ev_pid,_tsd_ev_pts,_tsd_ev_dts,_tsd_ev_stream_type,_tsd_ev_program_num,_tsd_ev_random_access,_tsd_ev_data_len,_tsd_ev_data,_tsd_ev_text,_tsd_ev_pmt_entry_count,_tsd_ev_pmt_entry,_tsd_ev_format_id_count,_tsd_ev_format_id,_tsd_ev_nal_offset_count,_tsd_ev_nal_offsets,_tsd_ev_nal_type_count,_tsd_ev_nal_types,_tsd_ev_sample_count,_tsd_ev_samples,_tsd_debug_snapshot,_tsd_snapshot_free,_tsd_snap_field,_tsd_meter_snapshot,_tsd_meter_free,_tsd_meter_field,_tsd_set_meter_selection,_tsm_new,_tsm_free,_tsm_set_video_codec,_tsm_set_video_enabled,_tsm_set_audio_codec,_tsm_add_audio_pid,_tsm_set_sparse_enabled,_tsm_set_sparse_threshold,_tsm_push_video,_tsm_push_audio,_tsm_push_pcm,_tsm_push_pcm_pid,_tsm_poll \
            -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,HEAPU32,HEAP16,HEAP32,HEAPF32,HEAPF64 \
            -DSRT_ENABLE_VIRTUAL_TRANSPORT \
            -Iharness $LW_INC $SRT_INC
        ;;
    page)
        # esbuild from the local node_modules (package.json devDependency).
        # The worker bundles keep ../build/srt_engine.mjs EXTERNAL: the emcc
        # module must be served as its own file because it spawns its pthread
        # workers by self-importing srt_engine.mjs (and fetches the .wasm
        # relative to itself) - the deploy target puts it at dist/build/.
        [ -f build/srt_engine.mjs ] || { echo "build/srt_engine.mjs missing - run ./build.sh engine first" >&2; exit 1; }
        ESBUILD="node_modules/.bin/esbuild"
        [ -x "$ESBUILD" ] || { echo "esbuild not found at $ESBUILD - run: npm install" >&2; exit 1; }
        mkdir -p page/bundle
        "$ESBUILD" page/vendor/worker.ts --bundle --format=esm \
            --external:../build/srt_engine.mjs --outfile=page/bundle/worker.js
        "$ESBUILD" page/main.ts --bundle --format=esm --outfile=page/bundle/app.js
        # M6 publisher page: the worker bundles the vendored stream-worker.ts
        # (C++ engine + C++ muxer since M7); same --external treatment for
        # the emcc module.
        "$ESBUILD" page/vendor/stream-worker.ts --bundle --format=esm \
            --external:../build/srt_engine.mjs --outfile=page/bundle/publish_worker.js
        "$ESBUILD" page/publish.ts --bundle --format=esm --outfile=page/bundle/publish.js
        ;;
    deploy)
        # Self-contained dist/ for the supervised gateway's web_root
        # (/etc/websrt-cpp/gateway.conf): the bundles keep
        # ../build/srt_engine.mjs external, so the engine module + its
        # self-relative .wasm ride along at dist/build/ to make that
        # import resolve when the gateway serves dist/ as-is.
        [ -f build/srt_engine.mjs ] || { echo "build/srt_engine.mjs missing - run ./build.sh engine first" >&2; exit 1; }
        [ -f page/bundle/app.js ] || { echo "page/bundle/ missing - run ./build.sh page first" >&2; exit 1; }
        rm -rf dist
        mkdir -p dist/bundle dist/build
        cp page/*.html dist/
        cp page/bundle/* dist/bundle/
        cp build/srt_engine.mjs build/srt_engine.wasm dist/build/
        echo "deployed dist/ (gateway web_root):"
        ls dist/*.html dist/bundle/* dist/build/*
        ;;
    -h | --help | help)
        usage
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac
