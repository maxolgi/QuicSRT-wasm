// demux_engine.js - the M5 JS wrapper around the emcc module's demux C ABI
// (build/srt_engine.mjs: harness/ts_demux.{h,cpp}).
//
// It mirrors the exported shape of the Rust demuxer it replaces (WebSRT
// crates/mpeg2ts-wasm/src/lib.rs -> wasm-bindgen mpeg2ts_wasm.js) so
// WebSRT's demux wrapper (web/src/demux.ts) can be vendored with ONE
// import swap, exactly like js/srt_engine.js mirrors the engine:
//
//   import init, { TsDemuxer } from './demux_engine.js';
//
// Mirrored surface (names in/out, plan-notes/abi-census.md is the
// contract):
//
//   default export init()                     async, idempotent module load
//   class TsDemuxer
//     new TsDemuxer()
//     feed(bytes: Uint8Array) -> TsEvent[]
//     debugSnapshot() -> DebugSnapshot
//     meter_snapshot() -> MeterSnapshotView   (snake_case - the one
//                                              wasm-bindgen export without
//                                              a js_name, demux.ts:56)
//     setMeterSelection(pid, channel)
//     free()
//   TsEvent: PROPERTIES kind pid pts dts stream_type data text program_num
//     randomAccess nalOffsets nalTypes samples (snake_case where
//     wasm-bindgen kept the Rust name, camelCase where js_name set it),
//     METHODS pmtEntries() pmtFormatIds(), and free(). Array getters
//     return fresh JS-owned copies each call (the M5 data-return policy -
//     same as wasm-bindgen's Vec getters).
//   DebugSnapshot: the 37 census-1.3 properties + free().
//   MeterSnapshotView: the 12 census-1.4 properties + free().
//
// Deltas vs the wasm-bindgen glue (documented, none consumer-visible):
//   1. Events are backed by C++ heap objects with the same lifetime rules
//      (owned by JS after feed(), released by free()); reading a property
//      after free() returns stale data instead of wasm-bindgen's
//      "use after free" error - consumers free events last, after
//      processing (demux.ts:39-43).
//   2. The meter DSP (harness/meter.{h,cpp}) is live: meter_snapshot()
//      returns the full 12-field view with wasm-bindgen's mutating
//      snapshot semantics (latches/resets windows, pushes the phase
//      ring), exactly like the Rust original.

import { loadEngineModule } from './engine_module.js';

let modulePromise = null;
let M = null; // the resolved emcc module instance

export default function init() {
    if (!modulePromise) {
        modulePromise = (async () => {
            M = await loadEngineModule();
            return M;
        })();
    }
    return modulePromise;
}

function requireModule() {
    if (!M) {
        throw new Error('demux_engine: call init() first');
    }
    return M;
}

// ---- shared decode helpers ---------------------------------------------------

const UTF8 = new TextDecoder('utf-8');

function cstr(ptr) {
    let end = ptr;
    while (M.HEAPU8[end] !== 0) end++;
    // slice, not subarray: with -pthread the heap is a SharedArrayBuffer and
    // Chrome's TextDecoder rejects shared views ("must not be shared"); node
    // accepts them, which is why the parity harness never caught this.
    return UTF8.decode(M.HEAPU8.slice(ptr, end));
}

// TsdFieldView is { const void* data; int count; int kind; } - 12 bytes,
// wasm32. One module-wide scratch buffer: getters are synchronous and
// single-threaded, so no reentrancy is possible.
let viewBuf = 0;

function fieldView(call, id) {
    if (call(id, viewBuf) !== 0) {
        throw new Error(`demux_engine: bad snapshot field id ${id}`);
    }
    const data = M.HEAPU32[viewBuf >> 2];
    const count = M.HEAPU32[(viewBuf >> 2) + 1];
    const kind = M.HEAPU32[(viewBuf >> 2) + 2];
    if (data === 0 || count === 0) {
        return kind === TSD_KIND.I32 ? 0 : emptyArray(kind);
    }
    switch (kind) {
        case TSD_KIND.I32: return M.HEAP32[data >> 2];
        case TSD_KIND.U8: return M.HEAPU8.slice(data, data + count);
        case TSD_KIND.U16: return M.HEAPU16.slice(data >> 1, (data >> 1) + count);
        case TSD_KIND.U32: return M.HEAPU32.slice(data >> 2, (data >> 2) + count);
        case TSD_KIND.F32: return M.HEAPF32.slice(data >> 2, (data >> 2) + count);
        case TSD_KIND.F64: return M.HEAPF64.slice(data >> 3, (data >> 3) + count);
        case TSD_KIND.STRS: {
            const out = new Array(count);
            for (let i = 0; i < count; i++) out[i] = cstr(M.HEAPU32[(data >> 2) + i]);
            return out;
        }
        default: throw new Error(`demux_engine: bad field view kind ${kind}`);
    }
}

// ts_demux.h element-kind enum (TSD_I32..TSD_STRS).
const TSD_KIND = { I32: 0, U8: 1, U16: 2, U32: 3, F32: 4, F64: 5, STRS: 6 };

function emptyArray(kind) {
    switch (kind) {
        case TSD_KIND.U8: return new Uint8Array(0);
        case TSD_KIND.U16: return new Uint16Array(0);
        case TSD_KIND.U32: return new Uint32Array(0);
        case TSD_KIND.F32: return new Float32Array(0);
        case TSD_KIND.F64: return new Float64Array(0);
        case TSD_KIND.STRS: return [];
        default: throw new Error(`demux_engine: bad field view kind ${kind}`);
    }
}

// ---- TsEvent -------------------------------------------------------------------

export class TsEvent {
    /** @internal */
    constructor(ptr) {
        this._e = ptr;
        this._freed = false;
    }

    get kind() { return M._tsd_ev_kind(this._e); }
    get pid() { return M._tsd_ev_pid(this._e); }
    get pts() { return M._tsd_ev_pts(this._e); }
    get dts() { return M._tsd_ev_dts(this._e); }
    get stream_type() { return M._tsd_ev_stream_type(this._e); }
    get program_num() { return M._tsd_ev_program_num(this._e); }
    get randomAccess() { return M._tsd_ev_random_access(this._e) !== 0; }
    get text() { return cstr(M._tsd_ev_text(this._e)); }

    get data() {
        const len = M._tsd_ev_data_len(this._e);
        if (len === 0) return new Uint8Array(0);
        const ptr = M._tsd_ev_data(this._e);
        return M.HEAPU8.slice(ptr, ptr + len); // fresh copy, like Vec<u8>
    }

    // PMT events: flat [pid0, stream_type0, pid1, stream_type1, ...].
    pmtEntries() {
        const n = M._tsd_ev_pmt_entry_count(this._e);
        const out = new Uint16Array(n);
        for (let i = 0; i < n; i++) out[i] = M._tsd_ev_pmt_entry(this._e, i);
        return out;
    }

    // PMT events: per-entry registration-descriptor format id ("" absent).
    pmtFormatIds() {
        const n = M._tsd_ev_format_id_count(this._e);
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = cstr(M._tsd_ev_format_id(this._e, i));
        return out;
    }

    get nalOffsets() {
        const len = M._tsd_ev_nal_offset_count(this._e);
        if (len === 0) return new Uint32Array(0);
        const ptr = M._tsd_ev_nal_offsets(this._e);
        return M.HEAPU32.slice(ptr >> 2, (ptr >> 2) + len);
    }

    get nalTypes() {
        const len = M._tsd_ev_nal_type_count(this._e);
        if (len === 0) return new Uint8Array(0);
        const ptr = M._tsd_ev_nal_types(this._e);
        return M.HEAPU8.slice(ptr, ptr + len);
    }

    get samples() {
        const len = M._tsd_ev_sample_count(this._e);
        if (len === 0) return new Float32Array(0);
        const ptr = M._tsd_ev_samples(this._e);
        return M.HEAPF32.slice(ptr >> 2, (ptr >> 2) + len);
    }

    free() {
        if (!this._freed) {
            this._freed = true;
            M._tsd_event_free(this._e);
        }
    }
}

// ---- snapshots ------------------------------------------------------------------

// ts_demux.h field-id enums, keyed by the wasm-bindgen property names.
const SNAPSHOT_FIELDS = {
    programNum: 0, pmtPid: 1,
    pmtPids: 2, pmtStreamTypes: 3, pmtFormatIds: 4,
    pids: 5, pesCounts: 6, byteTotals: 7, bitratesMbps: 8, raCounts: 9,
    lastPts: 10, lastDts: 11, ptsJumps: 12, ccErrors: 13, teiCounts: 14,
    pusiCounts: 15, scramblingCounts: 16, afControlCounts: 17,
    pcrPids: 18, pcrIntervalsMs: 19, pcrJitterMs: 20,
    nalPids: 21, nalStats: 22,
    errorT: 23, errorMsg: 24,
    ringT: 25, ringPid: 26, ringKind: 27, ringPts: 28, ringDts: 29,
    ringSize: 30, ringRa: 31, ringTei: 32, ringPusi: 33, ringNal: 34,
    ringNalOffsets: 35, ringHex: 36,
};

const METER_FIELDS = {
    pids: 0, channelCounts: 1, peaks: 2, rms: 3, clips: 4, lufs: 5,
    phase: 6, scopeL: 7, scopeR: 8, spectrum: 9,
    selectedPid: 10, selectedChannel: 11,
};

function defineFieldGetters(cls, fields, callPtr) {
    for (const [name, id] of Object.entries(fields)) {
        Object.defineProperty(cls.prototype, name, {
            get() { return fieldView((f, out) => callPtr(this, f, out), id); },
            enumerable: true,
        });
    }
}

export class DebugSnapshot {
    /** @internal */
    constructor(ptr) {
        this._s = ptr;
        this._freed = false;
    }

    free() {
        if (!this._freed) {
            this._freed = true;
            M._tsd_snapshot_free(this._s);
        }
    }
}

export class MeterSnapshotView {
    /** @internal */
    constructor(ptr) {
        this._m = ptr;
        this._freed = false;
    }

    free() {
        if (!this._freed) {
            this._freed = true;
            M._tsd_meter_free(this._m);
        }
    }
}

defineFieldGetters(DebugSnapshot, SNAPSHOT_FIELDS,
    (self, f, out) => M._tsd_snap_field(self._s, f, out));
defineFieldGetters(MeterSnapshotView, METER_FIELDS,
    (self, f, out) => M._tsd_meter_field(self._m, f, out));

// ---- TsDemuxer --------------------------------------------------------------------

export class TsDemuxer {
    constructor() {
        const m = requireModule();
        if (viewBuf === 0) {
            viewBuf = m._malloc(12); // TsdFieldView scratch (4+4+4)
        }
        this._d = m._tsd_new();
        if (!this._d) {
            throw new Error('TsDemuxer: tsd_new failed');
        }
        this._freed = false;
    }

    // Feed raw TS bytes (any length); returns the events emitted during
    // this call. Each event is owned by JS - free() it after processing.
    feed(bytes) {
        if (this._freed) {
            return [];
        }
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError('TsDemuxer.feed: expected a Uint8Array');
        }
        const ptr = M._malloc(Math.max(1, bytes.length));
        M.HEAPU8.set(bytes, ptr);
        const n = M._tsd_feed(this._d, ptr, bytes.length);
        M._free(ptr);
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            out[i] = new TsEvent(M._tsd_event_take(this._d, i));
        }
        return out;
    }

    debugSnapshot() {
        return new DebugSnapshot(M._tsd_debug_snapshot(this._d));
    }

    // snake_case on purpose - the only wasm-bindgen export without a
    // js_name (census 1.1); demux.ts calls meter_snapshot().
    meter_snapshot() {
        return new MeterSnapshotView(M._tsd_meter_snapshot(this._d));
    }

    setMeterSelection(pid, channel) {
        M._tsd_set_meter_selection(this._d, pid, channel);
    }

    free() {
        if (!this._freed) {
            this._freed = true;
            M._tsd_free(this._d);
        }
    }
}
