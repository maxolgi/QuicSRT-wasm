// Engine end-to-end smoke gate (node; standalone - imports js/srt_engine.js
// directly, no page bundle). Extracted from the retired M4 A/B harness's
// static gate when its Rust oracle arm went away (see git history): this
// keeps the valuable Rust-free half - the fake-WebTransport drive of the
// C++ engine.
//
//   1. Subscriber loop with the vendored worker.ts mechanics (WT-readable
//      datagrams -> rx.handle_datagram, adaptive-tick poll cycle, batched
//      reads, kind-0 writes -> WT writable) against a fake WebTransport
//      whose far end is a SECOND engine instance running the in-wasm
//      synthetic publisher (js/engine_shim.c, the js/test_contract.mjs
//      loopback pattern split across two stacks).
//   2. Every kind-1 DeliverMessage payload feeds message/byte counters, a
//      streaming SHA-256 of the delivered stream (node crypto; the ab
//      worker's hand-rolled incremental SHA-256 was browser-only and went
//      with it) and per-wall-second buckets keyed off the run epoch.
//   3. Final report verified: totals, the full-run digest against node's
//      crypto over the known deterministic stream, bucket sums, handshake
//      event, 1 Hz stats samples, zero loss/drop (rx stats and the shim's
//      outgoing ring alike).
//
// Exit 0 = pass. srt's pthreads keep node alive, hence the explicit exit.

import { createHash } from 'node:crypto';
import init, { SrtReceiver } from './srt_engine.js';

const PAYLOAD_SIZE = 1128;
const NUM_MESSAGES = 2000;
const LATENCY_MS = 120;
const TIMEOUT_MS = 60000;
const TICK_MS = 5; // worker.ts TICK_MAX_MS; the C++ engine never emits
// kind-3 WaitForData (documented delta), so the adaptive tick pins here
const BATCH_SIZE = 16; // worker.ts read-burst size

function fail(msg) {
    console.error(`engine_smoke: FAIL: ${msg}`);
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

// ---- the fake WebTransport (far end: the publisher engine instance) -------

await init();
const pub = SrtReceiver.newWithLatencyAndRtt(LATENCY_MS, 5);
if (pub.startTestPublisher() !== 0) fail('startTestPublisher');

let readableCtl = null;
let lastWt = null;
class FakeWT {
    constructor() {
        this.datagrams = {
            readable: new ReadableStream({ start: (c) => { readableCtl = c; } }),
            writable: new WritableStream({ write: (d) => pub.testPublisherInject(d) }),
        };
        this.ready = Promise.resolve();
        this.closed = Promise.resolve();
        lastWt = this;
    }
    async getStats() { return { smoothedRtt: 0.5 }; } // seeds the subscriber's RTT
    close() { try { readableCtl?.close(); } catch { /* already closed */ } }
}

// ---- the subscriber side (worker.ts mechanics, inline) ---------------------

const wt = new FakeWT();
await wt.ready;

let handshakeAt = null;
let firstDeliverAt = null;
let wtReady = false;
const startPerf = performance.now();
const epoch = Date.now();
const nowRelMs = () => performance.now() - startPerf;
const nowUs = () => Math.round(nowRelMs() * 1000);

// the worker seeds SRT's RTT from QUIC's smoothed RTT (draft-sharabayko-
// srt-over-quic §4.5) before constructing the receiver
const qs = await wt.getStats();
const rx = SrtReceiver.newWithLatencyAndRtt(LATENCY_MS, qs.smoothedRtt);
const reader = wt.datagrams.readable.getReader();
const writer = wt.datagrams.writable.getWriter();
wtReady = true;

// accounting state (what the ab worker accounted, minus the A/B verdict)
let dMsgs = 0;
let dBytes = 0;
const totalSha = createHash('sha256');
const buckets = new Map();
const samples = [];
const rtts = [];

const statsTimer = setInterval(() => {
    const s = rx.getStats();
    if (typeof s.rttMs === 'number' && s.rttMs > 0) rtts.push(s.rttMs);
    samples.push({
        at: Date.now(),
        rttMs: s.rttMs, rxLoss: s.rxLoss, rxDropped: s.rxDropped,
        rxRetransmit: s.rxRetransmit, bandwidthBps: s.bandwidthBps,
        rxBytes: s.rxBytes, rxData: s.rxData, elapsedMs: s.elapsedMs,
        dMsgs, dBytes,
    });
}, 1000);

// the network direction: publisher datagrams -> the WT readable, like the
// gateway pushing datagrams (the retired harness's 2 ms pump)
const pump = setInterval(() => {
    for (;;) {
        const dg = pub.testPublisherPoll();
        if (dg === null) break;
        try { readableCtl.enqueue(dg); } catch { /* subscriber closed */ }
    }
}, 2);

function writeDatagram(bytes) {
    try { writer.write(bytes).catch(() => {}); } catch { /* writer closed */ }
}

function processActions(actions) {
    for (const a of actions) {
        try {
            switch (a.kind) {
                case 0: // SendDatagram -> the WT writable -> publisher
                    writeDatagram(a.takeData());
                    break;
                case 1: { // DeliverMessage -> hash + count
                    const d = a.takeData();
                    dMsgs++;
                    dBytes += d.length;
                    totalSha.update(d);
                    const sec = Math.floor((Date.now() - epoch) / 1000);
                    let b = buckets.get(sec);
                    if (!b) {
                        b = { msgs: 0, bytes: 0, sha: createHash('sha256') };
                        buckets.set(sec, b);
                    }
                    b.msgs++;
                    b.bytes += d.length;
                    b.sha.update(d);
                    if (firstDeliverAt === null) firstDeliverAt = performance.now();
                    break;
                }
                case 2: // HandshakeComplete
                    if (handshakeAt === null) handshakeAt = performance.now();
                    break;
                case 4: // Close: stream ended
                    fail('engine closed the session mid-run');
                    break;
                default:
                    break;
            }
        } finally {
            a.free?.();
        }
    }
}

// worker.ts's runLoop shape: race the WT read against the tick, burst-read
// up to BATCH_SIZE datagrams, then drain the poll cycle
async function runLoop() {
    let readPromise = reader.read();
    for (;;) {
        if (dMsgs >= NUM_MESSAGES) break;
        let timeoutId;
        const tick = new Promise((resolve) => {
            timeoutId = setTimeout(resolve, TICK_MS);
        });
        const winner = await Promise.race([
            readPromise.then((res) => ({ kind: 'dgram', res })),
            tick.then(() => ({ kind: 'tick' })),
        ]);
        clearTimeout(timeoutId);
        if (dMsgs >= NUM_MESSAGES) break;

        if (winner.kind === 'dgram') {
            if (winner.res.done || !winner.res.value) break;
            processActions(rx.handle_datagram(winner.res.value, nowUs()));
            readPromise = reader.read();
            for (let i = 1; i < BATCH_SIZE; i++) {
                const next = await Promise.race([
                    readPromise.then((res) => ({ kind: 'dgram', res })),
                    Promise.resolve({ kind: 'idle' }),
                ]);
                if (next.kind === 'idle') break;
                if (next.res.done || !next.res.value) return; // stream end
                processActions(rx.handle_datagram(next.res.value, nowUs()));
                readPromise = reader.read();
                if (dMsgs >= NUM_MESSAGES) break;
            }
        }
        processActions(rx.poll(nowUs()));
    }
}

const deadline = Date.now() + TIMEOUT_MS;
try {
    await runLoop();
    while (dMsgs < NUM_MESSAGES) {
        if (Date.now() > deadline) fail(`timeout: ${dMsgs}/${NUM_MESSAGES} messages`);
        processActions(rx.poll(nowUs()));
        await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 300)); // let trailing buckets/stats settle
    // the ab worker sampled until its stop command arrived (> 1 s of wall
    // time); this loop runs hotter, so wait for the first 1 Hz sample the
    // same way before tearing the session down
    while (samples.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
    }
} catch (e) {
    fail(`subscriber loop threw: ${e}`);
}

clearInterval(pump);
clearInterval(statsTimer);
wt.close();

if (!wtReady) fail('wt ready never fired');
if (handshakeAt === null) fail('no handshakeComplete event');
if (firstDeliverAt === null) fail('no delivery - firstDeliverDelay null');
const handshakeDelayMs = handshakeAt - startPerf;
const firstDeliverDelayMs = firstDeliverAt - startPerf;
pass(`events (wt ready, handshake after ${handshakeDelayMs.toFixed(0)} ms, first deliver after ${firstDeliverDelayMs.toFixed(0)} ms, ${samples.length} stats samples)`);

if (dMsgs !== NUM_MESSAGES) fail(`msgs = ${dMsgs}, expected ${NUM_MESSAGES}`);
if (dBytes !== NUM_MESSAGES * PAYLOAD_SIZE) fail(`bytes = ${dBytes}, expected ${NUM_MESSAGES * PAYLOAD_SIZE}`);
pass(`delivered accounting (${dMsgs} msgs / ${dBytes} bytes)`);

// expected full-run digest: the known deterministic stream, in order
const expectHash = createHash('sha256');
const scratch = new Uint8Array(PAYLOAD_SIZE);
for (let i = 0; i < NUM_MESSAGES; i++) expectHash.update(fillMessage(i, scratch));
const gotSha = totalSha.digest('hex');
if (gotSha !== expectHash.digest('hex')) fail(`full-run SHA-256 mismatch: got ${gotSha}`);
pass(`full-run SHA-256 matches the known stream (${gotSha.slice(0, 16)}…)`);

const bucketList = [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([sec, b]) => ({ sec, msgs: b.msgs, bytes: b.bytes, sha256: b.sha.digest('hex') }));
const bucketMsgs = bucketList.reduce((a, b) => a + b.msgs, 0);
const bucketBytes = bucketList.reduce((a, b) => a + b.bytes, 0);
if (bucketMsgs !== dMsgs) fail(`bucket msgs ${bucketMsgs} != total ${dMsgs}`);
if (bucketBytes !== dBytes) fail(`bucket bytes ${bucketBytes} != total ${dBytes}`);
for (const b of bucketList) {
    if (!/^[0-9a-f]{64}$/.test(b.sha256)) fail(`bucket s${b.sec} digest malformed: ${b.sha256}`);
    if (b.sec < 0) fail(`bucket sec ${b.sec} before epoch`);
}
pass(`per-second buckets (${bucketList.length} buckets, sums match, digests well-formed)`);

if (samples.length < 1) fail('no 1 Hz stats samples');

// final full getStats() snapshot: every STATS_KEYS field present, raw number
const STATS_KEYS = [
    'elapsedMs', 'rttMs', 'bandwidthBps',
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxBelated',
    'rxBuffered', 'rxAck', 'rxNak',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];
const s = rx.getStats();
for (const k of STATS_KEYS) {
    if (typeof s[k] !== 'number') fail(`getStats().${k} = ${s[k]}, expected a raw number`);
}
if (s.rxData !== dMsgs) fail(`rxData ${s.rxData} != delivered ${dMsgs}`);
pass(`final stats snapshot (all 17 raw fields, rxData=${s.rxData})`);

if (s.rxLoss !== 0) fail(`rxLoss = ${s.rxLoss}, expected 0`);
if (s.rxDropped !== 0) fail(`rxDropped = ${s.rxDropped}, expected 0`);
const outDropped = rx.getDroppedOutgoing();
if (outDropped !== 0) fail(`outDropped = ${outDropped}, expected 0 on a clean run`);
if (s.rxBytes < dBytes) fail(`rxBytes ${s.rxBytes} < delivered ${dBytes}`);
const sortedRtt = [...rtts].sort((a, b) => a - b);
if (sortedRtt.length === 0) fail('no rtt samples');
const rttMedianMs = sortedRtt[Math.min(sortedRtt.length - 1, Math.ceil(0.5 * sortedRtt.length) - 1)];
pass(`stats totals (loss 0, drop 0, outDropped 0, rtt med ${rttMedianMs.toFixed(2)} ms, rxBytes ${s.rxBytes})`);

rx.free();
pub.free();
process.exit(0);
