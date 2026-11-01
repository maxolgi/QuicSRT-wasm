// ABR decision-engine gate: proves page/vendor/abr.ts as a pure module -
// no DOM, no player imports, just the StatsMsg counter-delta state
// machine. The gate cannot import .ts directly, so the repo's esbuild
// JS API transforms it at runtime into a temp file under /tmp/opencode,
// which is then imported. Samples are built the way the worker's ~1 Hz
// stats arrive: CUMULATIVE since-connect counters (verified in
// js/srt_engine.js getStats + harness/stats_map.cpp: rxData =
// pktRecvTotal data pkts received incl. retrans, rxLoss = pktRcvLossTotal
// detected-missing, rxDropped = pktRcvDropTotal too-late TLPKTDROP
// drops, never cleared - srt_bstats clear=0), so each scenario advances
// counters and the engine judges per-tick deltas. Per-tick data+loss is
// kept at 100 so lossPct = lossDelta exactly. Exit 0 = pass.

import { readFileSync, writeFileSync } from 'node:fs';
import { transform } from 'esbuild';

function fail(msg) {
    console.error(`abr_gate: FAIL: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`PASS: ${msg}`);
}

// ---- load the engine (ts -> esm via the repo's esbuild) -------------------

const SRC = new URL('../page/vendor/abr.ts', import.meta.url);
const TMP = `/tmp/opencode/abr_gate_engine-${process.pid}.mjs`;
const compiled = await transform(readFileSync(SRC.pathname, 'utf8'), { loader: 'ts', format: 'esm' });
writeFileSync(TMP, compiled.code);
const { createAbr, DEFAULT_ABR_THRESHOLDS } = await import(TMP);

if (typeof createAbr !== 'function') fail('createAbr is not a function');
for (const [k, v] of Object.entries({ badLossPct: 10, goodLossPct: 1, badMs: 5000, goodMs: 60000, tickGapResetMs: 5000 })) {
    if (DEFAULT_ABR_THRESHOLDS[k] !== v) fail(`DEFAULT_ABR_THRESHOLDS.${k} = ${DEFAULT_ABR_THRESHOLDS[k]}, expected ${v}`);
}
pass('load (esbuild transform of page/vendor/abr.ts, createAbr + exact default thresholds)');

// ---- helpers ----------------------------------------------------------------

// Monotonic StatsMsg counters; advance() returns the cumulative sample.
function counters() {
    let rxData = 0, rxLoss = 0, rxDropped = 0;
    return {
        advance(data, loss, drops) {
            rxData += data; rxLoss += loss; rxDropped += drops;
            return { rxData, rxLoss, rxDropped };
        },
    };
}

// Per-tick counter rates (data+loss = 100 per tick -> lossPct = loss).
const CLEAN = { data: 100, loss: 0, drops: 0 }; // lossPct 0 -> GOOD
const BAD15 = { data: 85, loss: 15, drops: 0 }; // lossPct 15 > 10 -> BAD
const DROPS = { data: 100, loss: 0, drops: 1 }; // dropDelta 1 -> BAD
const MID5 = { data: 95, loss: 5, drops: 0 }; // lossPct 5 -> middle zone

// Drive n 1 s ticks after tStart; records [t, decision] for non-null ones.
function runTicks(abr, c, tStart, n, rates) {
    const out = [];
    for (let i = 1; i <= n; i++) {
        const t = tStart + i * 1000;
        const d = abr.tick(c.advance(rates.data, rates.loss, rates.drops), t);
        if (d !== null) out.push([t, d]);
    }
    return out;
}

function expectSeq(got, want, what) {
    const fmt = (a) => a.map(([t, d]) => `${d}@${t / 1000}s`).join(', ') || '(none)';
    if (got.length !== want.length || got.some(([t, d], i) => t !== want[i][0] || d !== want[i][1])) {
        fail(`${what}: decisions [${fmt(got)}] != expected [${fmt(want)}]`);
    }
}

// ---- scenarios --------------------------------------------------------------

// 1. First-ever tick is a pure baseline: no deltas exist yet, so null.
{
    const abr = createAbr();
    const c = counters();
    const d = abr.tick(c.advance(100, 0, 0), 0);
    if (d !== null) fail(`scenario 1: first tick returned ${JSON.stringify(d)}, expected null`);
    pass('1. first-ever tick -> null (baseline only)');
}

// 2. 59 s clean never reaches the 60 s GOOD rung; one BAD tick voids the
// streak; after a further 60 s clean exactly one 'up' at the 60 s mark.
{
    const abr = createAbr();
    const c = counters();
    abr.tick(c.advance(CLEAN.data, CLEAN.loss, CLEAN.drops), 0); // baseline
    const got = [
        ...runTicks(abr, c, 0, 59, CLEAN), // clean 1..59 s
        ...runTicks(abr, c, 59 * 1000, 1, BAD15), // one BAD tick at 60 s
        ...runTicks(abr, c, 60 * 1000, 62, CLEAN), // clean 61..122 s
    ];
    expectSeq(got, [[120 * 1000, 'up']], 'scenario 2');
    pass(`2. 59 s clean + 1 BAD + clean -> no 'up' before the full 60 s, exactly one 'up' at t=120s (60 s past the BAD tick)`);
}

// 3. 15% loss every tick from t0 -> 'down' exactly at t=5 s (badMs).
{
    const abr = createAbr();
    const c = counters();
    abr.tick(c.advance(BAD15.data, BAD15.loss, BAD15.drops), 0); // baseline
    const got = runTicks(abr, c, 0, 5, BAD15);
    expectSeq(got, [[5 * 1000, 'down']], 'scenario 3');
    pass('3. 15% loss every tick -> exactly one \'down\' at t=5s');
}

// 4. drops for only 3 ticks (3 s < badMs) then clean for 10 s: the bad
// streak dies before 5 s and the good streak is nowhere near 60 s.
{
    const abr = createAbr();
    const c = counters();
    abr.tick(c.advance(CLEAN.data, CLEAN.loss, CLEAN.drops), 0); // baseline
    const got = [
        ...runTicks(abr, c, 0, 3, DROPS), // drops>0 for 3 ticks
        ...runTicks(abr, c, 3 * 1000, 10, CLEAN), // clean for 10 s
    ];
    expectSeq(got, [], 'scenario 4');
    pass('4. 3 drop ticks then 10 s clean -> no decision ever');
}

// 5. Bad sustained 11 s -> two 'down's: the first at 5 s, the second
// exactly 5 s later (the decision clears the streaks and re-anchors the
// baseline on its own tick, so the next tick is judged immediately; the
// engine is rung-position-agnostic, the caller bounds the ladder).
{
    const abr = createAbr();
    const c = counters();
    abr.tick(c.advance(CLEAN.data, CLEAN.loss, CLEAN.drops), 0); // baseline
    const got = runTicks(abr, c, 0, 11, BAD15);
    expectSeq(got, [[5 * 1000, 'down'], [10 * 1000, 'down']], 'scenario 5');
    if (got[1][0] - got[0][0] !== 5 * 1000) fail('scenario 5: second down is not 5 s after the first');
    pass(`5. bad sustained 11 s -> 'down' at t=5s, second 'down' exactly 5 s later (t=10s)`);
}

// 6. 40 s GOOD streak, then an 8 s tick gap (reconnect) voids it; 'up'
// only after a FULL 60 s of clean post-gap ticks (not 60-8).
{
    const abr = createAbr();
    const c = counters();
    abr.tick(c.advance(CLEAN.data, CLEAN.loss, CLEAN.drops), 0); // baseline
    const got = runTicks(abr, c, 0, 40, CLEAN); // clean 1..40 s
    // 8 s gap (40s -> 48s > tickGapResetMs): fresh baseline tick -> null
    const gapD = abr.tick(c.advance(CLEAN.data, CLEAN.loss, CLEAN.drops), 48 * 1000);
    if (gapD !== null) fail(`scenario 6: gap tick returned ${JSON.stringify(gapD)}, expected null`);
    const post = runTicks(abr, c, 48 * 1000, 62, CLEAN); // clean 49..110 s
    expectSeq([...got, ...post], [[108 * 1000, 'up']], 'scenario 6');
    pass(`6. 40 s GOOD + 8 s gap -> pre-gap streak void, exactly one 'up' at t=108s (full 60 s post-gap)`);
}

// 7. Middle zone (5% loss, no drops) for 70 s: hysteresis clears both
// streaks every tick - never a decision in either direction.
{
    const abr = createAbr();
    const c = counters();
    abr.tick(c.advance(MID5.data, MID5.loss, MID5.drops), 0); // baseline
    const got = runTicks(abr, c, 0, 70, MID5);
    expectSeq(got, [], 'scenario 7');
    pass('7. middle zone (5% loss, no drops) 70 s -> no decision ever');
}

process.exit(0);
