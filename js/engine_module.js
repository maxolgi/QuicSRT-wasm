// engine_module.js - the ONE instantiation of build/srt_engine.mjs shared
// by js/srt_engine.js and js/demux_engine.js (M5 step 6: two factory calls
// meant two 16 MB wasm heaps in the same player worker - the module IS one
// linear memory, so the wrappers must share the call, not just the file).
// The emcc module fetches its .wasm and spawns its pthread workers by
// self-importing srt_engine.mjs, both relative to itself, so this singleton
// call site changes nothing about either; the page bundles keep this
// dynamic import external (build.sh page) exactly as before.

let modulePromise = null;

export function loadEngineModule() {
    if (!modulePromise) {
        modulePromise = import('../build/srt_engine.mjs').then((mod) => mod.default());
    }
    return modulePromise;
}
