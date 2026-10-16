// M4 A/B harness worker: a self-contained dual-engine WebSRT subscriber.
// One instance is spawned PER ENGINE by page/ab.ts; each instance opens its
// OWN WebTransport session (two subscribers cannot share one: their SRT
// handshakes/ACKs would collide on the gateway), runs the vendored
// worker.ts loop mechanics (connect/cert-hash/datagram pump, adaptive tick)
// against the engine picked by the start command, and accounts every
// DeliverMessage payload:
//
//   - total delivered msgs / bytes
//   - running SHA-256 of the concatenated delivered payload (streaming impl
//     below; crypto.subtle has no incremental API)
//   - per-wall-second buckets (digest + count) keyed off the shared run
//     epoch, so the main thread can compare aligned interior seconds
//
// The engine is the import swap from page/vendor/worker.ts:
//   rust: '../wasm/srt-wasm/srt_wasm.js' (vendored wasm-bindgen glue)
//   cpp:  '../js/srt_engine.js'            (js/srt_engine.js, same API shape)
// Both glues are inert until init() runs, so one bundle serves both.
//
// Node-compat for the page/ab_smoke.mjs gate: the module only touches
// globalThis-attached hooks (onmessage/postMessage) and lazily-loads
// engines, so importing the bundle in node is side-effect free.

import * as rustEngine from './wasm/srt-wasm/srt_wasm.js';
import * as cppEngine from '../js/srt_engine.js';

type EngineKind = 'rust' | 'cpp';

export interface StartCmd {
    cmd: 'start';
    engine: EngineKind;
    url: string;
    certHash: Uint8Array | null;
    latencyMs: number;
    /** Shared run epoch (Date.now() of the START click) - bucket timebase. */
    epoch: number;
}

export type AbWorkerCmd = StartCmd | { cmd: 'stop' };

export interface StatsSample {
    at: number;
    rttMs: number;
    rxLoss: number;
    rxDropped: number;
    rxRetransmit: number;
    bandwidthBps: number;
    rxBytes: number;
    rxData: number;
    elapsedMs: number;
    dMsgs: number;
    dBytes: number;
}

export interface Bucket {
    sec: number;
    msgs: number;
    bytes: number;
    sha256: string;
}

export interface AbFinal {
    engine: EngineKind;
    reason: string;
    error?: string;
    durationMs: number;
    firstDeliverDelayMs: number | null;
    handshakeDelayMs: number | null;
    msgs: number;
    bytes: number;
    sha256: string;
    buckets: Bucket[];
    samples: StatsSample[];
    rttMinMs: number | null;
    rttMedianMs: number | null;
    rttMaxMs: number | null;
    lossTotal: number;
    dropTotal: number;
    rxBytesFinal: number;
    /** Final full getStats() snapshot: all 17 STATS_KEYS, raw values. */
    finalStats: Record<string, number> | null;
}

export type AbWorkerMsg =
    | { type: 'log'; engine: EngineKind; msg: string }
    | { type: 'ready'; engine: EngineKind }
    | { type: 'wtReady'; engine: EngineKind }
    | { type: 'handshakeComplete'; engine: EngineKind }
    | { type: 'wtClosed'; engine: EngineKind; error?: string }
    | { type: 'stats'; engine: EngineKind; sample: StatsSample }
    | { type: 'final'; engine: EngineKind; final: AbFinal };

// ---------------------------------------------------------------------------
// Streaming SHA-256 (FIPS 180-4). crypto.subtle.digest is one-shot over a
// full buffer; the delivered stream is unbounded, so hash it incrementally.
// ---------------------------------------------------------------------------

const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA_IV = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

export class Sha256 {
    private h = new Uint32Array(8);
    private buf = new Uint8Array(64);
    private bufLen = 0;
    private total = 0;
    private w = new Uint32Array(64);
    private done = false;

    constructor() {
        this.h.set(SHA_IV);
    }

    update(d: Uint8Array): this {
        if (this.done) throw new Error('Sha256: update after digest');
        this.total += d.length;
        this.absorb(d);
        return this;
    }

    digestHex(): string {
        if (this.done) throw new Error('Sha256: digest twice');
        this.done = true;
        const bitLen = this.total * 8; // < 2^53: exact
        // pad is what gets APPENDED to the buffered remainder, so that
        // bufLen + pad.length lands on a 64-byte boundary (1 or 2 blocks)
        const rem = this.bufLen <= 55 ? 64 - this.bufLen : 128 - this.bufLen;
        const pad = new Uint8Array(rem);
        pad[0] = 0x80;
        const dv = new DataView(pad.buffer);
        dv.setUint32(rem - 8, Math.floor(bitLen / 4294967296));
        dv.setUint32(rem - 4, bitLen % 4294967296);
        this.absorb(pad);
        let out = '';
        for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, '0');
        return out;
    }

    private absorb(d: Uint8Array): void {
        let p = 0;
        if (this.bufLen > 0) {
            const take = Math.min(64 - this.bufLen, d.length);
            this.buf.set(d.subarray(0, take), this.bufLen);
            this.bufLen += take;
            p = take;
            if (this.bufLen === 64) {
                this.compress(this.buf, 0);
                this.bufLen = 0;
            }
        }
        for (; p + 64 <= d.length; p += 64) this.compress(d, p);
        if (p < d.length) {
            this.buf.set(d.subarray(p));
            this.bufLen = d.length - p;
        }
    }

    private compress(d: Uint8Array, off: number): void {
        const w = this.w;
        const h = this.h;
        for (let i = 0; i < 16; i++) {
            const o = off + 4 * i;
            w[i] = ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
            const s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h[0], b = h[1], c = h[2], dd = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
            const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (dd + t1) >>> 0;
            dd = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + dd) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
}

/** Dev gate: streaming SHA-256 vs crypto.subtle over tricky lengths. */
export async function __sha256SelfTest(): Promise<boolean> {
    let seed = 0x9e3779b9;
    const rnd = (n: number) => {
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            out[i] = seed & 0xff;
        }
        return out;
    };
    for (const n of [0, 1, 54, 55, 56, 63, 64, 65, 127, 128, 1000, 4096]) {
        const data = rnd(n);
        const mine = new Sha256();
        // chunked updates at awkward boundaries, not one big update
        let p = 0;
        while (p < n) {
            const take = Math.min(n - p, 1 + ((p * 7) % 37));
            mine.update(data.subarray(p, p + take));
            p += take;
        }
        const ref = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
        let hex = '';
        for (const b of ref) hex += b.toString(16).padStart(2, '0');
        if (mine.digestHex() !== hex) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Run state (one run per worker instance; the harness terminates the worker
// after its final message)
// ---------------------------------------------------------------------------

const ctx: any = globalThis;

const STATS_KEYS = [
    'elapsedMs', 'rttMs', 'bandwidthBps',
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxBelated',
    'rxBuffered', 'rxAck', 'rxNak',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];

interface EngineModule {
    default(): Promise<unknown>;
    SrtReceiver: any;
}

const ENGINES: Record<EngineKind, EngineModule> = { rust: rustEngine as any, cpp: cppEngine as any };

let gen = 0;
let engine: EngineKind = 'rust';
let rx: any = null;
let wt: WebTransport | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let started = false;
let finished = false;
let epoch = 0; // Date.now() of run start (bucket timebase)
let startPerf = 0;
let firstDeliverAt: number | null = null;
let handshakeAt: number | null = null;
let totalSha: Sha256 | null = null;
let dMsgs = 0;
let dBytes = 0;
const buckets = new Map<number, { msgs: number; bytes: number; sha: Sha256 }>();
const samples: StatsSample[] = [];
const rtts: number[] = [];
let lastStats: any = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let lastWaitMs: number | null = null;
let lastWaitAtMs = 0;

// worker.ts adaptive-tick bounds (HTML setTimeout clamp floor, historical 5ms cadence)
const TICK_MIN_MS = 4;
const TICK_MAX_MS = 5;

function post(msg: AbWorkerMsg) {
    ctx.postMessage(msg);
}

function log(msg: string) {
    post({ type: 'log', engine, msg });
}

function statsPOJO(r: any): any {
    const s = r.getStats();
    if (s && typeof s.free === 'function') {
        // wasm-bindgen SrtStats: copy fields out, then free the WASM object
        const o: any = {};
        for (const k of STATS_KEYS) o[k] = s[k];
        s.free();
        return o;
    }
    return s;
}

ctx.onmessage = (e: MessageEvent) => {
    const cmd = e.data as AbWorkerCmd;
    if (cmd.cmd === 'start') {
        void doStart(cmd);
    } else if (cmd.cmd === 'stop') {
        finish('stop');
    }
};

async function doStart(cmd: StartCmd) {
    const myGen = ++gen;
    engine = cmd.engine;
    epoch = cmd.epoch;
    started = true;
    startPerf = performance.now();
    totalSha = new Sha256();
    dMsgs = 0;
    dBytes = 0;
    buckets.clear();
    samples.length = 0;
    rtts.length = 0;
    firstDeliverAt = null;
    handshakeAt = null;
    try {
        const m = ENGINES[cmd.engine];
        await m.default();
        if (myGen !== gen) return;
        post({ type: 'ready', engine });

        const opts: WebTransportOptions = {};
        if (cmd.certHash) {
            opts.serverCertificateHashes = [{ algorithm: 'sha-256', value: cmd.certHash as BufferSource }];
        }
        wt = new WebTransport(cmd.url, opts);
        await wt.ready;
        if (myGen !== gen) { try { wt.close({}); } catch {} return; }

        // Seed SRT's RTT from QUIC's smoothed RTT (draft-sharabayko-srt-over-quic
        // §4.5) - same cold-start refinement worker.ts applies.
        let initialRttMs: number | undefined;
        try {
            const qs = await (wt as any).getStats();
            if (qs && typeof qs.smoothedRtt === 'number' && qs.smoothedRtt > 0) {
                initialRttMs = qs.smoothedRtt;
            }
        } catch { /* getStats not supported - proceed with default RTT */ }
        rx = initialRttMs !== undefined
            ? m.SrtReceiver.newWithLatencyAndRtt(cmd.latencyMs, initialRttMs)
            : m.SrtReceiver.newWithLatency(cmd.latencyMs);

        const dg = (wt as any).datagrams;
        const datagrams = typeof dg === 'function' ? dg() : dg;
        const readable = typeof datagrams.createReadable === 'function' ? datagrams.createReadable() : datagrams.readable;
        const writable = typeof datagrams.createWritable === 'function' ? datagrams.createWritable() : datagrams.writable;
        reader = readable.getReader();
        writer = writable.getWriter();
        wt.closed
            .then(() => { if (myGen === gen) post({ type: 'wtClosed', engine }); })
            .catch((err) => { if (myGen === gen) post({ type: 'wtClosed', engine, error: String(err) }); });
        post({ type: 'wtReady', engine });

        statsTimer = setInterval(() => {
            if (!rx || !started) return;
            const s = statsPOJO(rx);
            lastStats = s;
            if (typeof s.rttMs === 'number' && s.rttMs > 0) rtts.push(s.rttMs);
            const sample: StatsSample = {
                at: Date.now(),
                rttMs: s.rttMs,
                rxLoss: s.rxLoss,
                rxDropped: s.rxDropped,
                rxRetransmit: s.rxRetransmit,
                bandwidthBps: s.bandwidthBps,
                rxBytes: s.rxBytes,
                rxData: s.rxData,
                elapsedMs: s.elapsedMs,
                dMsgs,
                dBytes,
            };
            samples.push(sample);
            if (samples.length > 60) samples.shift();
            post({ type: 'stats', engine, sample });
        }, 1000);

        await runLoop(myGen);
    } catch (e) {
        if (myGen === gen) {
            finish('error', String(e));
        }
    }
}

function writeDatagram(bytes: Uint8Array) {
    const w = writer;
    if (!w) return;
    try {
        w.write(bytes).catch(() => {});
    } catch { /* writer closed */ }
}

function account(data: Uint8Array) {
    dMsgs++;
    dBytes += data.length;
    totalSha!.update(data);
    const sec = Math.floor((Date.now() - epoch) / 1000);
    let b = buckets.get(sec);
    if (!b) {
        b = { msgs: 0, bytes: 0, sha: new Sha256() };
        buckets.set(sec, b);
    }
    b.msgs++;
    b.bytes += data.length;
    b.sha.update(data);
    if (firstDeliverAt === null) firstDeliverAt = performance.now();
}

function processActions(actions: any[]) {
    for (const a of actions) {
        try {
            switch (a.kind) {
                case 0: // SendDatagram
                    writeDatagram(a.takeData());
                    break;
                case 1: // DeliverMessage -> hash + count (the A/B payload)
                    account(a.takeData());
                    break;
                case 2: // HandshakeComplete
                    if (handshakeAt === null) handshakeAt = performance.now();
                    post({ type: 'handshakeComplete', engine });
                    break;
                case 3: // WaitForData: next timed event - drives the tick
                    if (lastWaitMs === null || a.wait_ms < lastWaitMs) {
                        lastWaitMs = a.wait_ms;
                        lastWaitAtMs = performance.now();
                    }
                    break;
                case 4: // Close: stream ended
                    log('engine closed the session');
                    finish('closed');
                    break;
                case 5: // Log
                    log(a.text);
                    break;
                default:
                    break;
            }
        } finally {
            a.free?.();
        }
    }
}

function nowRelMs(): number {
    return performance.now() - startPerf;
}

async function runLoop(myGen: number) {
    const r = reader;
    if (!r) return;
    let readPromise = r.read();
    const BATCH_SIZE = 16;

    mainLoop: for (;;) {
        if (myGen !== gen || !rx || !started || finished) break;

        let tickMs = TICK_MAX_MS;
        if (lastWaitMs !== null) {
            const elapsedMs = nowRelMs() - lastWaitAtMs;
            tickMs = Math.min(TICK_MAX_MS, Math.max(TICK_MIN_MS, lastWaitMs - elapsedMs));
        }
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<{ kind: 'tick' }>((resolve) => {
            timeoutId = setTimeout(() => resolve({ kind: 'tick' }), tickMs);
        });
        const readWithLabel = readPromise.then(
            (res) => ({ kind: 'dgram' as const, res }),
            (err: unknown) => ({ kind: 'read_error' as const, err }),
        );

        const winner = await Promise.race([readWithLabel, tick]);
        if (timeoutId !== undefined) clearTimeout(timeoutId);

        if (myGen !== gen || !rx || !started || finished) break;

        if (winner.kind === 'dgram') {
            if (winner.res.done || !winner.res.value) break;
            processActions(rx.handle_datagram(winner.res.value, nowRelMs() * 1000));
            readPromise = r.read();

            for (let i = 1; i < BATCH_SIZE; i++) {
                const next = await Promise.race([
                    readPromise.then(
                        (res) => ({ kind: 'dgram' as const, res }),
                        (err: unknown) => ({ kind: 'read_error' as const, err }),
                    ),
                    Promise.resolve({ kind: 'idle' as const }),
                ]);
                if (next.kind === 'idle') break;
                if (next.kind === 'read_error') {
                    log(`wt read: ${next.err}`);
                    break mainLoop;
                }
                if (next.res.done || !next.res.value) break mainLoop;
                processActions(rx.handle_datagram(next.res.value, nowRelMs() * 1000));
                readPromise = r.read();
            }
        } else if (winner.kind === 'read_error') {
            log(`wt read: ${winner.err}`);
            break;
        }

        processActions(rx.poll(nowRelMs() * 1000));
    }
    if (myGen === gen && !finished) finish('loop-end');
}

function rttOf(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function finish(reason: string, error?: string) {
    if (finished) return;
    finished = true;
    gen++;
    started = false;
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    const w = wt;
    wt = null;
    reader = null;
    writer = null;
    const r = rx;
    rx = null;
    let s = lastStats;
    if (r) {
        try { s = statsPOJO(r); } catch { /* keep last sample */ }
        try { r.free(); } catch { /* idempotent */ }
    }
    if (w) { try { w.close({}); } catch {} }

    const bucketList: Bucket[] = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([sec, b]) => ({ sec, msgs: b.msgs, bytes: b.bytes, sha256: b.sha.digestHex() }));
    const sortedRtt = [...rtts].sort((a, b) => a - b);
    const f: AbFinal = {
        engine,
        reason,
        error,
        durationMs: performance.now() - startPerf,
        firstDeliverDelayMs: firstDeliverAt !== null ? firstDeliverAt - startPerf : null,
        handshakeDelayMs: handshakeAt !== null ? handshakeAt - startPerf : null,
        msgs: dMsgs,
        bytes: dBytes,
        sha256: totalSha ? totalSha.digestHex() : '',
        buckets: bucketList,
        samples: samples.slice(),
        rttMinMs: sortedRtt.length > 0 ? sortedRtt[0] : null,
        rttMedianMs: sortedRtt.length > 0 ? rttOf(sortedRtt, 50) : null,
        rttMaxMs: sortedRtt.length > 0 ? sortedRtt[sortedRtt.length - 1] : null,
        lossTotal: s ? s.rxLoss : 0,
        dropTotal: s ? s.rxDropped : 0,
        rxBytesFinal: s ? s.rxBytes : 0,
        finalStats: s,
    };
    post({ type: 'final', engine, final: f });
}
