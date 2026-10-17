// M4 A/B harness static gate (node; the live browser run is the parent's).
//
// 1. Parse + import both bundles (page/bundle/ab_worker.js with BOTH engine
//    glues inlined and ../build/srt_engine.mjs left external, and
//    page/bundle/ab.js - its top-level is document-guarded, so node import
//    is side-effect free).
// 2. Streaming SHA-256 self-test (ab_worker.Sha256 vs crypto.subtle).
// 3. End-to-end run of the ab WORKER against the C++ engine with a fake
//    WebTransport (js/test_contract.mjs's in-wasm publisher pattern): pump
//    publisher datagrams into the worker's WT readable, route the worker's
//    kind-0 writes back into the publisher, stop after 2000 messages, and
//    verify the final report - totals, the full-run SHA-256 against node's
//    crypto over the known deterministic stream, bucket sums, handshake
//    event, stats samples, zero loss/drop (rx stats and the shim's
//    outgoing ring alike).
//
// Exit 0 = pass. srt's pthreads keep node alive, hence the explicit exit.

import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import init, { SrtReceiver } from '../js/srt_engine.js';

const PAYLOAD_SIZE = 1128;
const NUM_MESSAGES = 2000;
const LATENCY_MS = 120;
const TIMEOUT_MS = 60000;

function fail(msg) {
    console.error(`ab_smoke: FAIL: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`PASS: ${msg}`);
}

// js/test_contract.mjs's deterministic payload (harness/replay_test.cpp
// FillMessage xorshift32) - the expected delivered byte stream.
function fillMessage(index, out) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let state = (0x9E3779B9 ^ Math.imul(index, 2654435761)) >>> 0;
    for (let i = 0; i < PAYLOAD_SIZE / 4; i++) {
        state = (state ^ (state << 13)) >>> 0;
        state = (state ^ (state >>> 17)) >>> 0;
        state = (state ^ (state << 5)) >>> 0;
        dv.setUint32(i * 4, state, true);
    }
    return out;
}

// ---- 1. bundle imports -----------------------------------------------------

const workerMod = await import('./bundle/ab_worker.js');
if (typeof workerMod.__sha256SelfTest !== 'function') fail('ab_worker.js does not export __sha256SelfTest');
if (typeof workerMod.Sha256 !== 'function') fail('ab_worker.js does not export Sha256');
pass('ab_worker.js bundle imports in node (both engine glues parse)');

const mainMod = await import('./bundle/ab.js');
if (typeof mainMod.mountAbHarness !== 'function') fail('ab.js does not export mountAbHarness');
if (typeof mainMod.compareVerdict !== 'function') fail('ab.js does not export compareVerdict');
if (typeof document !== 'undefined') fail('node suddenly has a document?');
pass('ab.js bundle imports in node (document-guarded top level)');

// ---- 2. streaming SHA-256 --------------------------------------------------

if (!(await workerMod.__sha256SelfTest())) fail('streaming SHA-256 disagrees with crypto.subtle');
pass('streaming SHA-256 self-test (tricky lengths, chunked updates)');

// ---- 3. worker e2e over a fake WebTransport (cpp engine + test publisher) ---

let finalMsg = null;
const events = [];
const statsMsgs = [];
globalThis.postMessage = (m) => {
    if (m.type === 'final') finalMsg = m.final;
    else if (m.type === 'stats') statsMsgs.push(m.sample);
    else events.push(m);
};

let lastWt = null;
class FakeWT {
    constructor(url, opts) {
        this.url = url;
        this.opts = opts;
        this.datagrams = {
            readable: new ReadableStream({ start: (c) => { this._ctl = c; } }),
            writable: new WritableStream({ write: (d) => pub?.testPublisherInject(d) }),
        };
        this.ready = Promise.resolve();
        this.closed = Promise.resolve();
        lastWt = this;
    }
    async getStats() { return { smoothedRtt: 0.5 }; }
    close() { try { this._ctl?.close(); } catch { /* already closed */ } }
}
globalThis.WebTransport = FakeWT;

// The publisher end: its own engine instance, wired to the worker's engine
// through the fake pipe (test_contract's loopback split across two stacks).
await init();
const pub = SrtReceiver.newWithLatencyAndRtt(LATENCY_MS, 5);
if (pub.startTestPublisher() !== 0) fail('startTestPublisher');

const pump = setInterval(() => {
    if (!lastWt) return;
    for (;;) {
        const dg = pub.testPublisherPoll();
        if (dg === null) break;
        try { lastWt._ctl.enqueue(dg); } catch { /* worker closed the stream */ }
    }
}, 2);

globalThis.onmessage({ data: {
    cmd: 'start',
    engine: 'cpp',
    url: 'https://wt.invalid/wt?stream=ab',
    certHash: null,
    latencyMs: LATENCY_MS,
    epoch: Date.now(),
} });

const deliveredBytes = () => {
    let seen = 0;
    for (const s of statsMsgs) seen = Math.max(seen, s.dMsgs);
    return seen;
};

const deadline = Date.now() + TIMEOUT_MS;
while (finalMsg === null && deliveredBytes() < NUM_MESSAGES) {
    if (Date.now() > deadline) fail(`timeout: ${deliveredBytes()}/${NUM_MESSAGES} messages`);
    await new Promise((r) => setTimeout(r, 5));
}
await new Promise((r) => setTimeout(r, 300)); // let trailing buckets/stats settle

if (finalMsg === null) {
    globalThis.onmessage({ data: { cmd: 'stop' } });
    const stopDeadline = Date.now() + 5000;
    while (finalMsg === null && Date.now() < stopDeadline) await new Promise((r) => setTimeout(r, 20));
}
clearInterval(pump);
if (finalMsg === null) fail('no final message after stop');

if (finalMsg.error) fail(`final carries error: ${finalMsg.error}`);
if (finalMsg.engine !== 'cpp') fail(`final.engine = ${finalMsg.engine}`);
if (finalMsg.msgs !== NUM_MESSAGES) fail(`final.msgs = ${finalMsg.msgs}, expected ${NUM_MESSAGES}`);
if (finalMsg.bytes !== NUM_MESSAGES * PAYLOAD_SIZE) fail(`final.bytes = ${finalMsg.bytes}, expected ${NUM_MESSAGES * PAYLOAD_SIZE}`);
pass(`delivered accounting (${finalMsg.msgs} msgs / ${finalMsg.bytes} bytes)`);

// expected full-run digest: the known deterministic stream, in order
const expectHash = createHash('sha256');
const scratch = new Uint8Array(PAYLOAD_SIZE);
for (let i = 0; i < NUM_MESSAGES; i++) expectHash.update(fillMessage(i, scratch));
if (finalMsg.sha256 !== expectHash.digest('hex')) {
    fail(`final.sha256 mismatch: got ${finalMsg.sha256}`);
}
pass(`full-run SHA-256 matches the known stream (${finalMsg.sha256.slice(0, 16)}…)`);

const bucketMsgs = finalMsg.buckets.reduce((a, b) => a + b.msgs, 0);
const bucketBytes = finalMsg.buckets.reduce((a, b) => a + b.bytes, 0);
if (bucketMsgs !== finalMsg.msgs) fail(`bucket msgs ${bucketMsgs} != total ${finalMsg.msgs}`);
if (bucketBytes !== finalMsg.bytes) fail(`bucket bytes ${bucketBytes} != total ${finalMsg.bytes}`);
for (const b of finalMsg.buckets) {
    if (!/^[0-9a-f]{64}$/.test(b.sha256)) fail(`bucket s${b.sec} digest malformed: ${b.sha256}`);
    if (b.sec < 0) fail(`bucket sec ${b.sec} before epoch`);
}
pass(`per-second buckets (${finalMsg.buckets.length} buckets, sums match, digests well-formed)`);

if (!events.some((e) => e.type === 'wtReady')) fail('no wtReady event');
if (!events.some((e) => e.type === 'handshakeComplete')) fail('no handshakeComplete event');
if (finalMsg.handshakeDelayMs === null) fail('handshakeDelayMs null');
if (finalMsg.firstDeliverDelayMs === null) fail('firstDeliverDelayMs null');
if (statsMsgs.length < 1) fail('no 1 Hz stats samples');
pass(`events (wtReady, handshakeComplete after ${(finalMsg.handshakeDelayMs).toFixed(0)} ms, first deliver after ${(finalMsg.firstDeliverDelayMs).toFixed(0)} ms, ${statsMsgs.length} stats samples)`);

// final full getStats() snapshot: every STATS_KEYS field present, raw number
const STATS_KEYS = [
    'elapsedMs', 'rttMs', 'bandwidthBps',
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxBelated',
    'rxBuffered', 'rxAck', 'rxNak',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];
if (!finalMsg.finalStats) fail('final.finalStats missing');
for (const k of STATS_KEYS) {
    if (typeof finalMsg.finalStats[k] !== 'number') {
        fail(`final.finalStats.${k} = ${finalMsg.finalStats[k]}, expected a raw number`);
    }
}
if (finalMsg.finalStats.rxData !== finalMsg.msgs) fail(`finalStats.rxData ${finalMsg.finalStats.rxData} != delivered ${finalMsg.msgs}`);
pass(`final stats snapshot (all 17 raw fields, rxData=${finalMsg.finalStats.rxData})`);

if (finalMsg.lossTotal !== 0) fail(`rxLoss = ${finalMsg.lossTotal}, expected 0`);
if (finalMsg.dropTotal !== 0) fail(`rxDropped = ${finalMsg.dropTotal}, expected 0`);
if (finalMsg.outDropped !== 0) fail(`outDropped = ${finalMsg.outDropped}, expected 0 on a clean run`);
if (finalMsg.rxBytesFinal < finalMsg.bytes) fail(`rxBytes ${finalMsg.rxBytesFinal} < delivered ${finalMsg.bytes}`);
if (finalMsg.rttMedianMs === null) fail('no rtt samples');
pass(`stats totals (loss 0, drop 0, outDropped 0, rtt med ${finalMsg.rttMedianMs.toFixed(2)} ms, rxBytes ${finalMsg.rxBytesFinal})`);

// ---- 4. compareVerdict over synthetic finals (pure function) ---------------

{
    const mk = (over) => Object.assign({
        engine: 'x', reason: 'stop', durationMs: 30000,
        firstDeliverDelayMs: 150, handshakeDelayMs: 90,
        msgs: 1000, bytes: 1_128_000, sha256: 'a'.repeat(64),
        buckets: [
            { sec: 0, msgs: 100, bytes: 112800, sha256: '0'.repeat(64) },
            { sec: 1, msgs: 400, bytes: 451200, sha256: '1'.repeat(64) },
            { sec: 2, msgs: 400, bytes: 451200, sha256: '2'.repeat(64) },
            { sec: 3, msgs: 100, bytes: 112800, sha256: '3'.repeat(64) },
        ],
        samples: [], rttMinMs: 0.4, rttMedianMs: 0.5, rttMaxMs: 0.9,
        lossTotal: 0, dropTotal: 0, rxBytesFinal: 1_200_000,
    }, over);
    // identical interior buckets (s1, s2): all match
    const v1 = mainMod.compareVerdict(mk({}), mk({}));
    if (!v1.includes('hashes EQUAL') || !v1.includes('aligned buckets 2/2')) fail(`verdict identical: ${v1}`);
    // one interior bucket differs: 1/2 + the mismatch is called out
    const b = mk({});
    b.buckets[2] = { sec: 2, msgs: 401, bytes: 452328, sha256: 'x'.repeat(64) };
    const v2 = mainMod.compareVerdict(mk({}), b);
    if (!v2.includes('hashes EQUAL') || !v2.includes('aligned buckets 1/2') || !v2.includes('s2')) fail(`verdict mismatch: ${v2}`);
    // edges excluded: first/last active seconds never compared
    const c = mk({});
    c.buckets[0].sha256 = 'y'.repeat(64); // s0 is edge for BOTH engines
    c.buckets[3].sha256 = 'y'.repeat(64);
    const v3 = mainMod.compareVerdict(mk({}), c);
    if (!v3.includes('aligned buckets 2/2')) fail(`verdict edges: ${v3}`);
    // full-run hash difference reported
    const v4 = mainMod.compareVerdict(mk({}), mk({ sha256: 'b'.repeat(64), msgs: 1010 }));
    if (!v4.includes('hashes differ') || !v4.includes('msgs Δ=10')) fail(`verdict differ: ${v4}`);
    pass('compareVerdict (interior alignment, edge exclusion, mismatch localization)');
}

pub.free();
process.exit(0);
