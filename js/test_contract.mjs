// M3 contract gate: drives the JS wrapper (js/srt_engine.js) exactly the
// way WebSRT's player worker (web/src/worker.ts) drives the Rust engine -
// construct via newWithLatencyAndRtt, pump handle_datagram/poll, process
// the action list, read getStats - against the in-wasm synthetic publisher
// (js/engine_shim.c, the replay_test.cpp caller pattern). JS stays in the
// loop for BOTH directions:
//
//   publisher ring -> rx.handle_datagram   (the "WT datagram received" path)
//   kind-0 actions -> testPublisherInject  (the "writeDatagram" path)
//
// Gate criteria: the mirrored API surface exists, the handshake completes
// through the poll cycle, the outgoing ring delivered the receiver's
// handshake/ACK datagrams, all 2000 messages arrive byte-identical in
// order, and getStats() has exactly the 17 StatsMsg keys worker.ts reads
// with sane values (rxData == 2000, seeded RTT refined below 300 ms).
// Exit 0 = pass. srt's pthreads keep node alive, hence the explicit exits.

import init, { SrtReceiver, decodeI64Words } from './srt_engine.js';

const PAYLOAD_SIZE = 1128;
const NUM_MESSAGES = 2000;
const LATENCY_MS = 120;
const SEED_RTT_MS = 300;
const TIMEOUT_MS = 20000;

// Exactly the StatsMsg/SrtStats fields worker.ts reads
// (serializeStats + emitLossEvents, in lib.rs SrtStats order).
const EXPECTED_STATS_KEYS = [
    'elapsedMs', 'rttMs', 'bandwidthBps',
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxBelated',
    'rxBuffered', 'rxAck', 'rxNak',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];

function fail(msg) {
    console.error(`test_contract: FAIL: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`PASS: ${msg}`);
}

// The harness/replay_test.cpp FillMessage xorshift32 stream, regenerated in
// JS for byte-exact comparison.
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

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

// ---- init + mirrored API surface -----------------------------------------

await init();
if (typeof SrtReceiver.newWithLatency !== 'function') fail('SrtReceiver.newWithLatency is not a static function');
if (typeof SrtReceiver.newWithLatencyAndRtt !== 'function') fail('SrtReceiver.newWithLatencyAndRtt is not a static function');
for (const m of ['handle_datagram', 'poll', 'isHandshakeComplete', 'isClosed', 'getStats', 'free']) {
    if (typeof SrtReceiver.prototype[m] !== 'function') fail(`SrtReceiver.prototype.${m} is not a function`);
}
pass('init (module load + mirrored SrtReceiver surface)');

// The plain-constructor + free path (wasm-bindgen's `new SrtReceiver()`).
{
    const probe = new SrtReceiver();
    const s = probe.getStats();
    for (const k of EXPECTED_STATS_KEYS) {
        if (s[k] !== 0) fail(`pre-connection getStats().${k} = ${s[k]}, expected 0`);
    }
    if (probe.isHandshakeComplete() || probe.isClosed()) fail('fresh receiver must be neither connected nor closed');
    probe.free();
    probe.free(); // idempotent
    if (probe.poll(nowUs()).length !== 0) fail('poll() after free() must return []');
}
pass('ctor/free (default 120 ms constructor, zeroed stats, idempotent free)');

// ---- the worker.ts flow against the in-wasm publisher --------------------

const rx = SrtReceiver.newWithLatencyAndRtt(LATENCY_MS, SEED_RTT_MS);
if (rx.startTestPublisher() !== 0) fail('startTestPublisher');

const delivered = [];
let outgoing = 0;
let handshakeActions = 0;
let closeActions = 0;
const unknownKinds = new Set();
let hsAfterFirstDeliver = false;

function processActions(actions) {
    for (const a of actions) {
        switch (a.kind) {
            case 0: { // SendDatagram -> worker.ts writeDatagram
                const d = a.takeData();
                if (!(d instanceof Uint8Array) || d.length === 0) fail('kind-0 action carries no datagram');
                if (rx.testPublisherInject(d) !== 0) fail('testPublisherInject rejected a kind-0 datagram');
                outgoing++;
                break;
            }
            case 1: { // DeliverMessage -> worker.ts demux.feed
                const d = a.takeData();
                if (!(d instanceof Uint8Array)) fail('kind-1 action carries no message');
                if (d.length !== PAYLOAD_SIZE) fail(`kind-1 message is ${d.length} bytes, expected ${PAYLOAD_SIZE}`);
                if (typeof a.schedUs !== 'number') fail('kind-1 action has no numeric schedUs');
                delivered.push(d);
                break;
            }
            case 2: // HandshakeComplete
                if (delivered.length > 0) hsAfterFirstDeliver = true;
                handshakeActions++;
                break;
            case 3: // WaitForData: never emitted (documented delta)
                break;
            case 4: // Close
                closeActions++;
                break;
            case 5: // Log: never emitted (documented delta)
                break;
            default:
                unknownKinds.add(a.kind);
        }
        a.free();
    }
}

const deadline = Date.now() + TIMEOUT_MS;
while (delivered.length < NUM_MESSAGES) {
    if (Date.now() > deadline) fail(`timeout after ${delivered.length}/${NUM_MESSAGES} messages`);
    // The "WT read" direction: publisher datagrams -> handle_datagram.
    for (;;) {
        const dg = rx.testPublisherPoll();
        if (dg === null) break;
        processActions(rx.handle_datagram(dg, nowUs()));
    }
    processActions(rx.poll(nowUs()));
    await new Promise((r) => setTimeout(r, 2));
}

if (handshakeActions !== 1) fail(`HandshakeComplete emitted ${handshakeActions} times, expected exactly 1`);
if (hsAfterFirstDeliver) fail('HandshakeComplete arrived after data (worker.ts expects it at HS time)');
if (outgoing === 0) fail('outgoing ring delivered no handshake/ACK datagrams');
if (closeActions !== 0) fail(`unexpected Close action(s): ${closeActions}`);
if (unknownKinds.size !== 0) fail(`unknown action kinds: ${[...unknownKinds]}`);
if (!rx.isHandshakeComplete()) fail('isHandshakeComplete() false after delivery');
if (rx.isClosed()) fail('isClosed() true on a live connection');
pass(`handshake (kind-2 exactly once, ${outgoing} kind-0 datagrams through the outgoing ring)`);

const expect = new Uint8Array(PAYLOAD_SIZE);
for (let i = 0; i < NUM_MESSAGES; i++) {
    fillMessage(i, expect);
    const got = Buffer.from(delivered[i]);
    if (!got.equals(Buffer.from(expect))) {
        fail(`message ${i} content mismatch`);
    }
}
pass(`data (${NUM_MESSAGES} messages byte-identical in order via handle_datagram/poll)`);

// ---- stats ---------------------------------------------------------------

const s = rx.getStats();
const gotKeys = Object.keys(s).sort().join(',');
const wantKeys = [...EXPECTED_STATS_KEYS].sort().join(',');
if (gotKeys !== wantKeys) fail(`getStats() keys [${gotKeys}] != StatsMsg keys [${wantKeys}]`);
for (const k of EXPECTED_STATS_KEYS) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) fail(`getStats().${k} is ${s[k]}, expected a finite Number`);
}
// int64-mapped counters must decode as integers: the u32-pair read always
// yields integers; a mis-typed f64 read of an int64 field would surface a
// denormal (this is exactly how a bandwidthBps misdecode would slip past
// the finite check above).
const INT64_KEYS = [
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxAck', 'rxNak',
    'bandwidthBps', 'rxBuffered', 'rxBelated',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];
for (const k of INT64_KEYS) {
    if (!Number.isInteger(s[k])) fail(`getStats().${k} = ${s[k]}, expected an integer`);
}
// The negative int64 case the live loopback session never produces (its
// estimate seeds positive): srt's -1 "no estimate" mbpsBandwidth maps to
// bandwidth_bps -1000000 (0xFFFFFFFFFFF0BDC0 -> u32 pair 0xFFF0BDC0 /
// 0xFFFFFFFF), which must decode sign-extended to the Rust engine's
// -1000000, not the raw unsigned pair ~1.8e19.
if (decodeI64Words(0xFFF0BDC0, 0xFFFFFFFF) !== -1000000) {
    fail(`int64 pair decode of -1000000 gave ${decodeI64Words(0xFFF0BDC0, 0xFFFFFFFF)}, not sign-extended`);
}
if (s.rxData !== NUM_MESSAGES) fail(`rxData = ${s.rxData}, expected ${NUM_MESSAGES}`);
if (!(s.rttMs > 0 && s.rttMs < SEED_RTT_MS)) fail(`rttMs = ${s.rttMs}, expected refined 0 < rtt < ${SEED_RTT_MS}`);
if (s.rxLoss !== 0) fail(`rxLoss = ${s.rxLoss}, expected 0`);
if (s.rxDropped !== 0) fail(`rxDropped = ${s.rxDropped}, expected 0`);
if (s.txData !== 0 || s.txBytes !== 0) fail('receive-only session reported tx traffic');
pass(`stats (17 StatsMsg keys, rxData=${s.rxData}, rttMs=${s.rttMs.toFixed(1)} < ${SEED_RTT_MS}, rxLoss=0, rxDropped=0, int64 decode sign-extends -1000000)`);

rx.free();
pass('free (engine + test publisher teardown)');
process.exit(0);
