#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./build.sh <command>

Commands:
    setup    One-time: init deps/srt (falls back to the local fork clone for
             unpushed pins)
    lib      Configure + build the srt static lib with Emscripten
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
            -DCMAKE_C_FLAGS=-pthread \
            -DCMAKE_CXX_FLAGS=-pthread
        cmake --build build/srt -j "$(nproc)" --target srt_static
        ;;
    -h | --help | help)
        usage
        ;;
    *)
        usage >&2
        exit 1
        ;;
esac
