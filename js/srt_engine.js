// srt_engine.js - the M3 JS engine wrapper around the emcc module
// (build/srt_engine.mjs: harness/receiver.cpp + js/engine_shim.c).
//
// It mirrors the exported shape of the Rust engine it replaces
// (WebSRT crates/srt-wasm/src/lib.rs -> wasm-bindgen srt_wasm.js) so WebSRT's
// player worker (web/src/worker.ts) can be vendored with ONE import swap:
//
//   import init, { SrtReceiver } from './srt_engine.js';
//
// Mirrored surface (names in/out):
//
//   default export init()                        async, idempotent module load
//   class SrtReceiver
//     new SrtReceiver()                          default 120 ms latency
//     SrtReceiver.newWithLatency(latencyMs)
//     SrtReceiver.newWithLatencyAndRtt(latencyMs, initialRttMs)
//     handle_datagram(bytes: Uint8Array, now_us) -> SrtAction[]
//     poll(now_us)                               -> SrtAction[]
//     isHandshakeComplete()                      -> boolean
//     isClosed()                                 -> boolean
//     getStats()                                 -> plain stats object
//     free()
//   SrtAction (plain object): kind, data, text, wait_ms, schedUs,
//     takeData() -> Uint8Array, free()
//     kinds: 0 SendDatagram, 1 DeliverMessage, 2 HandshakeComplete,
//            3 WaitForData, 4 Close, 5 Log  (lib.rs SrtAction)
//
// Documented deltas vs lib.rs (all receive-path compatible with worker.ts):
//
//   1. sendMessage() is NOT implemented: the underlying C ABI
//      (harness/receiver.h) is receive-only; the player worker never sends
//      media data. worker.ts does not reference it.
//   2. The now_us arguments are accepted but ignored: the C engine runs
//      srt on its own pthreads with real clocks, so there is no JS-driven
//      time base to feed.
//   3. Deliver actions carry schedUs = 0.0: TSBPD release happens inside
//      srt before poll() returns a message, so there is no JS-visible
//      release deadline. worker.ts treats 0 as null and falls back to its
//      own clock for release-jitter telemetry.
//   4. Kind 3 (WaitForData) is never emitted. worker.ts then ticks at its
//      TICK_MAX_MS (5 ms) fallback, the historical fixed cadence.
//   5. Kind 5 (Log) is never emitted: the C ABI surfaces no parse errors.
//   6. Actions are plain JS objects: free() is a no-op (GC owns them) and
//      takeData() hands over the same Uint8Array (no copy); wasm-bindgen's
//      copying `data` getter is not mirrored because worker.ts only ever
//      reads takeData().
//   7. getStats() returns a plain object whose 17 Number fields are exactly
//      the SrtStats getters worker.ts reads (serializeStats/emitLossEvents).
//      Pre-connection it is all zeros, like lib.rs's fresh SocketStatistics.
//   8. isHandshakeComplete()/isClosed() are derived: handshake-complete is
//      the first srtw_get_stats success (connection live), closed is a
//      terminal srtw_poll error. Both are updated on the poll cycle, so
//      they can lag the true state by one tick, unlike lib.rs's direct
//      state reads.
//
// Test-only additions for js/test_contract.mjs (NOT part of the mirrored
// surface): startTestPublisher(), testPublisherPoll(), testPublisherInject()
// - the in-wasm synthetic publisher of js/engine_shim.c.

let modulePromise = null;
let M = null; // the resolved emcc module instance

export default function init() {
    if (!modulePromise) {
        modulePromise = (async () => {
            const mod = await import('../build/srt_engine.mjs');
            M = await mod.default();
            if (M._srtw_init() !== 0) {
                throw new Error('srt_engine: srtw_init failed');
            }
            return M;
        })();
    }
    return modulePromise;
}

// SrtwStats (harness/stats_map.h) layout: 17 eight-byte fields in
// declaration order - doubles read as f64, int64 counters read as unsigned
// 32-bit pairs (JS Numbers, never BigInt, like lib.rs's f64 getters).
const STATS_SIZE = 17 * 8;
const STATS_KEYS = [
    'elapsedMs', 'rttMs', 'bandwidthBps',
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxBelated',
    'rxBuffered', 'rxAck', 'rxNak',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];
const STATS_F64 = { elapsedMs: 0, rttMs: 8 * 8 };
const STATS_I64 = {
    rxData: 1 * 8, rxBytes: 2 * 8, rxLoss: 3 * 8, rxRetransmit: 4 * 8,
    rxDropped: 5 * 8, rxAck: 6 * 8, rxNak: 7 * 8, bandwidthBps: 9 * 8,
    rxBuffered: 10 * 8, rxBelated: 11 * 8, txData: 12 * 8, txBytes: 13 * 8,
    txRetransmit: 14 * 8, txLoss: 15 * 8, txBuffered: 16 * 8,
};

// action scratch: payload cap 1128 + any SRT message envelope headroom
const BUF_CAP = 2048;

function makeAction(kind, data = null, text = '', waitMs = 0, schedUs = 0) {
    const a = { kind, data, text, wait_ms: waitMs, schedUs };
    a.takeData = () => {
        const d = a.data;
        a.data = null;
        return d;
    };
    a.free = () => {};
    return a;
}

export class SrtReceiver {
    constructor(latencyMs = 120, rttMs = 0) {
        if (!M) {
            throw new Error('SrtReceiver: call init() first');
        }
        const eng = M._srtw_engine_new(latencyMs | 0, rttMs > 0 ? rttMs | 0 : 0);
        if (!eng) {
            throw new Error('SrtReceiver: srtw_engine_new failed');
        }
        this._eng = eng;
        this._recv = M._srtw_engine_receiver(eng);
        this._msgBuf = M._malloc(BUF_CAP);
        this._outBuf = M._malloc(BUF_CAP);
        // _malloc keeps _stats >= 8-byte aligned for the f64 view reads
        this._stats = M._malloc(STATS_SIZE);
        this._hs = false;
        this._closed = false;
        this._freed = false;
    }

    static newWithLatency(latencyMs) {
        return new SrtReceiver(latencyMs);
    }

    static newWithLatencyAndRtt(latencyMs, initialRttMs) {
        return new SrtReceiver(latencyMs, initialRttMs);
    }

    // Feed one incoming WebTransport datagram (raw SRT packet bytes).
    // Returns the actions JS should perform, exactly like lib.rs: the
    // receiver's seam output drained from the shim ring as kind-0 actions
    // (lib.rs surfaces outgoing datagrams as SendDatagram actions in the
    // same returned Vec), plus HandshakeComplete on the transition.
    handle_datagram(bytes, now_us) {
        if (now_us === undefined) {
            throw new TypeError('SrtReceiver.handle_datagram: missing now_us');
        }
        if (this._freed) {
            return [];
        }
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError('SrtReceiver.handle_datagram: expected a Uint8Array');
        }
        const ptr = M._malloc(Math.max(1, bytes.length));
        M.HEAPU8.set(bytes, ptr);
        const rc = M._srtw_handle_datagram(this._recv, ptr, bytes.length);
        M._free(ptr);
        const out = [];
        this._syncState(out);
        if (rc === 0) {
            this._drainOutgoing(out);
        }
        return out;
    }

    // Periodic tick: every message the TSBPD window has released (kind 1),
    // the transition to connected (kind 2), the seam output as kind-0
    // actions, and the terminal Close (kind 4) once the stream ends.
    poll(now_us) {
        if (now_us === undefined) {
            throw new TypeError('SrtReceiver.poll: missing now_us');
        }
        if (this._freed || this._closed) {
            return [];
        }
        const out = [];
        this._syncState(out);
        for (;;) {
            const n = M._srtw_poll(this._recv, this._msgBuf, BUF_CAP);
            if (n > 0) {
                out.push(makeAction(1, new Uint8Array(M.HEAPU8.subarray(this._msgBuf, this._msgBuf + n))));
                continue;
            }
            if (n < 0) {
                // Stream ended or errored (any buffered data was already
                // delivered): lib.rs graduates to State::Closed and emits
                // Close on the drain that noticed it.
                this._closed = true;
                out.push(makeAction(4));
            }
            break;
        }
        this._drainOutgoing(out);
        return out;
    }

    isHandshakeComplete() {
        return this._hs;
    }

    isClosed() {
        return this._closed;
    }

    // The 17-field stats object worker.ts reads; all Numbers. All zeros
    // before the connection is live (mirror of lib.rs's zeroed
    // SocketStatistics), never null.
    getStats() {
        const s = {};
        for (const k of STATS_KEYS) {
            s[k] = 0;
        }
        if (this._freed) {
            return s;
        }
        if (M._srtw_get_stats(this._recv, this._stats) === 0) {
            this._hs = true;
            const f64 = M.HEAPF64;
            const u32 = M.HEAPU32;
            for (const k in STATS_F64) {
                s[k] = f64[(this._stats + STATS_F64[k]) / 8];
            }
            for (const k in STATS_I64) {
                const o = (this._stats + STATS_I64[k]) / 4;
                s[k] = u32[o] + u32[o + 1] * 4294967296;
            }
        }
        return s;
    }

    free() {
        if (this._freed) {
            return;
        }
        this._freed = true;
        M._free(this._msgBuf);
        M._free(this._outBuf);
        M._free(this._stats);
        M._srtw_engine_free(this._eng);
    }

    // Emit HandshakeComplete (kind 2) on the poll cycle that first sees the
    // connection live (srtw_get_stats success == accepted socket up).
    _syncState(out) {
        if (!this._hs && M._srtw_get_stats(this._recv, this._stats) === 0) {
            this._hs = true;
            out.push(makeAction(2));
        }
    }

    // The receiver's seam output (handshake replies, ACKs, NAKs) as kind-0
    // actions, one per drained datagram, FIFO - the shim ring preserves srt
    // send order.
    _drainOutgoing(out) {
        for (;;) {
            const n = M._srtw_poll_outgoing(this._eng, this._outBuf, BUF_CAP);
            if (n <= 0) {
                break;
            }
            out.push(makeAction(0, new Uint8Array(M.HEAPU8.subarray(this._outBuf, this._outBuf + n))));
        }
    }

    // ---- test-only (js/test_contract.mjs; see file header) --------------

    startTestPublisher() {
        return M._srtw_test_publisher_start(this._eng);
    }

    testPublisherPoll() {
        const n = M._srtw_test_publisher_poll(this._eng, this._msgBuf, BUF_CAP);
        return n > 0 ? new Uint8Array(M.HEAPU8.subarray(this._msgBuf, this._msgBuf + n)) : null;
    }

    testPublisherInject(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
            return -1;
        }
        const ptr = M._malloc(bytes.length);
        M.HEAPU8.set(bytes, ptr);
        const rc = M._srtw_test_publisher_inject(this._eng, ptr, bytes.length);
        M._free(ptr);
        return rc;
    }
}
