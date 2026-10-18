// engine_module.js - the ONE instantiation of build/srt_engine.mjs shared
// by js/srt_engine.js and js/demux_engine.js (M5 step 6: two factory calls
// meant two 16 MB wasm heaps in the same player worker - the module IS one
// linear memory, so the wrappers must share the call, not just the file).
// The emcc module fetches its .wasm and spawns its pthread workers by
// self-importing srt_engine.mjs, both relative to itself, so this singleton
// call site changes nothing about either; the page bundles keep this
// dynamic import external (build.sh page) exactly as before.
//
// installPthreadSpawnGuard() runs before the import so the module's
// allocateUnusedWorker() picks up the load-abort retry facade (see its
// header - Chrome cancels nested pthread worker script loads when other
// engine workers share the renderer; without the guard the publisher tab
// cannot coexist with a streaming player tab).

import { installPthreadSpawnGuard } from './pthread_spawn_guard.js';

let modulePromise = null;

export function loadEngineModule() {
    if (!modulePromise) {
        installPthreadSpawnGuard();
        modulePromise = import('../build/srt_engine.mjs').then((mod) => mod.default({
            // srt's "CRcvBuffer.readMessage(): nothing to read" warnings
            // fire continuously once TSBPD release outpaces the JS drain.
            // In the browser every line is a console.error round-trip that
            // saturates the renderer (nested pthread worker loads then
            // abort - see js/pthread_spawn_guard.js); Node keeps them.
            printErr: typeof process !== 'undefined' ? undefined : (text) => {
                if (typeof text === 'string' && text.includes('SRT.br')) return;
                console.error(text);
            },
        }));
    }
    return modulePromise;
}
