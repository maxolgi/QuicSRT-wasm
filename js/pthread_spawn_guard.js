// pthread_spawn_guard.js - retry the emcc pthread worker's script load when
// Chrome aborts it (M6: the live publisher proof). Chrome 151 cancels a
// nested module worker's script fetch (net::ERR_ABORTED, surfaced as a bare
// `error` Event with no message - not an ErrorEvent) whenever other busy
// engine workers share the renderer: same-origin COOP/COEP tabs share one
// renderer process, so a streaming player tab makes every publisher-tab
// pthread spawn abort 3-of-4. emscripten's glue logs "worker sent an
// error!" and RETHROWS the Event, which kills the page worker's pending
// promise chains mid-SRT-handshake; the player page survives this via its
// terminate-and-recreate reconnect, the publisher page dies for good.
//
// The guard replaces self.Worker BEFORE the engine module loads so the
// module's allocateUnusedWorker() gets a facade per pthread worker. The
// happy path is a pure pass-through: every postMessage goes straight to
// the inner worker (deferring delivery would deadlock - the pthread
// worker's first outbound message, its cmd:3 "finished loading", only
// fires after cmd:1 "load" arrives, so gating cmd:1 on traffic from the
// worker waits forever). The facade only TEES what was posted before the
// worker proved life with its first message; a pre-ready bare `error`
// Event means the script never loaded, so nothing was delivered: the
// inner worker is discarded, a fresh one is created and the teed messages
// are replayed to it. A replay is only correct while no transferable was
// detached at the original pass-through post, so messages that carried a
// transfer list are not replayable - such an abort falls through to the
// normal error path (this engine's thread starts transfer nothing; the
// stack lives in the shared wasm heap). Post-ready errors are the
// worker's own - forwarded untouched. Retries back off exponentially and
// are bounded; each respawn warns once (at most MAX_SPAWN_ATTEMPTS lines)
// so a pathological renderer stays visible instead of silent.
//
// Node (js/test_contract.mjs, the parity harnesses) is skipped: emscripten
// swaps in worker_threads there and the browser abort race does not exist.

const MAX_SPAWN_ATTEMPTS = 10;
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 2000;

export function installPthreadSpawnGuard() {
    if (typeof process !== 'undefined' || typeof self === 'undefined' || typeof Worker === 'undefined') {
        return;
    }
    if (self.__websrtPthreadGuard) return;
    self.__websrtPthreadGuard = true;

    const RealWorker = Worker;

    class GuardedWorker {
        constructor(url, opts) {
            this._url = url;
            this._opts = opts;
            this._sent = [];         // [msg, transferList] teed before ready
            this._ready = false;     // first message from the inner worker
            this._dead = false;
            this._attempts = 0;
            this._onmessage = null;
            this._onerror = null;
            this.pthread_ptr = 0;
            this._spawn();
        }

        get onmessage() { return this._onmessage; }
        set onmessage(fn) { this._onmessage = fn; }

        get onerror() { return this._onerror; }
        set onerror(fn) { this._onerror = fn; }

        postMessage(msg, transferList) {
            if (!this._ready) this._sent.push([msg, transferList]);
            this._inner.postMessage(msg, transferList);
        }

        terminate() {
            this._dead = true;
            this._inner.terminate();
        }

        _spawn() {
            this._ready = false;
            this._inner = new RealWorker(this._url, this._opts);
            this._inner.onmessage = (ev) => {
                this._ready = true; // proved alive: the tee is no longer needed
                this._sent = [];
                if (this._onmessage) this._onmessage(ev);
            };
            this._inner.onerror = (ev) => {
                // A bare Event (no .message) before the first message is a
                // script-load abort: the worker never evaluated, so the teed
                // messages were never delivered - replay them on a fresh
                // worker. Immediate retries land inside the same contention
                // window (the abort persists while the renderer is busy), so
                // each retry backs off exponentially, capped.
                const replayable = this._sent.every(([, tl]) => !tl || tl.length === 0);
                if (!this._ready && !this._dead && !ev.message && replayable
                        && this._attempts < MAX_SPAWN_ATTEMPTS) {
                    this._attempts++;
                    const replay = this._sent;
                    this._sent = [];
                    const delay = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
                    this._inner.terminate();
                    console.warn(`srt_engine: pthread worker load aborted, respawn ${this._attempts}/${MAX_SPAWN_ATTEMPTS} in ${delay}ms`);
                    setTimeout(() => {
                        if (this._dead) return;
                        this._spawn();
                        for (const [msg, transferList] of replay) {
                            this.postMessage(msg, transferList);
                        }
                    }, delay);
                    return;
                }
                if (this._onerror) this._onerror(ev);
            };
        }
    }

    self.Worker = GuardedWorker;
}
