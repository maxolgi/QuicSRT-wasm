// M5 demux parity gate, phase 1: Rust vs Rust (plan-notes/parity-spec.md).
//
// 1. Load the ten golden fixtures (§1; sha/size-gated against
//    js/fixtures/manifest.sha256 per §3) and the Rust mpeg2ts-wasm pkg
//    (via the page/wasm symlink when ./build.sh page made one, else
//    straight from the WebSRT checkout - the symlink is never required).
// 2. Run every §1 fixture + every §2 crafted corruption (byte transforms
//    applied AT FEED TIME - nothing corrupted is stored) plus one extra
//    pass per 302M fixture with setMeterSelection(pid, 1) issued before
//    the first feed (§4.3), through TWO independent TsDemuxer instances in
//    1128-byte chunks (6x188, the live SRT payload size), comparing after
//    EVERY feed: canonical events (§4.1), DebugSnapshot (§4.2) and - on
//    the 302M fixtures - MeterSnapshot (§4.3). PES bytes and PCM f32
//    sample bits are compared via sha256 (bit-identical PCM is asserted,
//    never fuzzed); lufs/spectrum are tolerant at abs 1e-6 with the
//    -70/-80 sentinels matched as literals.
// 3. Chunk-boundary invariance (§5.3): each fixture re-run at chunk sizes
//    {188, 1128, 7} must produce identical concatenated event streams.
// 4. Error-text canonicalizer (§5.4): C6's raw kind-4 texts match
//    ^ts parse: (InvalidInput|Unsupported|Other): .+ \(at .+:\d+\)$ and
//    the canonicalized texts contain no " (at ".
// 5. Wall-clock isolation (§5.5): one fixture run twice must produce the
//    identical canonical digest - ringT/errorT/bitratesMbps are excluded
//    everywhere (§4.2, checked finite >= 0 only) and nothing else may
//    leak wall time.
// 6. Negative control: side A fed a_aac.ts, side B fed av_shortgop.ts -
//    the comparator MUST report the first divergence (§5.6), proving the
//    harness cannot silently pass everything.
//
// Usage:
//   node js/demux_parity.mjs [--cpp] [--m5-stage <core|nal|aes3|meter|full>]
//                            [--exclude=<entry>]...
//
// --cpp runs side B on the C++ port (build/srt_engine.mjs via
// js/demux_engine.js) instead of a second Rust instance; default stays
// Rust-vs-Rust. The comparator/canonicalizer are shared.
//
// --m5-stage <name> expands to that stage's CANONICAL exclusion set (the
// M5_STAGE_EXCLUSIONS table below): the staged fields NOT yet ported by
// that M5 step - core = the demux-core-only set (pcm kind x6, pes nal x2,
// snapshot nal x4, meter DSP x8, 20 entries), nal = core minus the 6 nal
// entries (nal.rs ported), aes3 = nal minus the pcm kind (aes3.rs
// ported), meter = aes3 minus the 8 meter DSP fields (meter.rs ported),
// full = none (identical to the flagless run; meter and full coincide -
// both kept so the flag reads forward). Default with no --m5-stage flag
// is the unchanged full comparison; --exclude entries stack on top of a
// stage's set.
//
// TEMPORARY staged exclusions for the C++ port rollout (M5 steps 2-5):
// each --exclude entry drops ONE field from comparison - "kind:field" for
// events (pat/pmt/pes/random_access/error/pcm, e.g. pes:pts) or a bare
// DebugSnapshot/MeterSnapshot field name (e.g. ringHex, lufs). Excluded
// comparisons are COUNTED and printed in the summary, never silently
// skipped. When EVERY field of one event kind is excluded, that kind is
// staged out entirely: its events are dropped from both sides before the
// count/field comparison (counted the same way). Default (no flags) is
// the full §4 rule set; every exclusion must be gone again before M5
// step 6 ships.
//
// Exit 0 = pass; on divergence exit 1 with case id, feed, byte offset,
// event index, field name and both values (§5.6).

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// §4: run with RUST_BACKTRACE unset - the fork's Error Display appends a
// backtrace when captured, which would leak into event text.
delete process.env.RUST_BACKTRACE;

function fail(msg) {
    console.error(`demux_parity: FAIL: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`PASS: ${msg}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNK = 1128; // 6x188, the live SRT payload size (§5.2)

// ---- comparator configuration (§4 field lists) -------------------------------

const KIND_NAMES = ['pat', 'pmt', 'pes', 'random_access', 'error', 'pcm'];
const EVENT_FIELDS = {
    pat: ['pid', 'programNum'],
    pmt: ['pid', 'pmtEntries', 'pmtFormatIds'],
    pes: ['pid', 'pts', 'dts', 'randomAccess', 'dataLen', 'dataSha256', 'nalOffsets', 'nalTypes'],
    random_access: ['pid'],
    error: ['text'],
    pcm: ['pid', 'pts', 'streamType', 'programNum', 'sampleCount', 'samplesSha256'],
};

// DebugSnapshot §4.2: compared exactly. The wall-clock trio below is NOT
// in this list - it is asserted finite >= 0 and never compared.
const SNAPSHOT_FIELDS = [
    'programNum', 'pmtPid',
    'pmtPids', 'pmtStreamTypes', 'pmtFormatIds',
    'pids', 'pesCounts', 'byteTotals', 'raCounts', 'lastPts', 'lastDts', 'ptsJumps',
    'ccErrors', 'teiCounts', 'pusiCounts', 'scramblingCounts', 'afControlCounts',
    'pcrPids', 'pcrIntervalsMs', 'pcrJitterMs',
    'nalPids', 'nalStats', 'errorMsg',
    'ringPid', 'ringKind', 'ringPts', 'ringDts', 'ringSize', 'ringRa', 'ringTei',
    'ringPusi', 'ringNal', 'ringNalOffsets', 'ringHex',
];
const SNAPSHOT_STRING_ARRAYS = new Set(['pmtFormatIds', 'errorMsg', 'ringHex']);
const WALL_CLOCK_FIELDS = ['ringT', 'errorT', 'bitratesMbps']; // §4.2 excluded

// MeterSnapshot §4.3 (plan-notes/meter-parity.md §2, adopted verbatim)
const METER_FIELDS = [
    'pids', 'channelCounts', 'peaks', 'clips', 'rms', 'lufs', 'phase',
    'scopeL', 'scopeR', 'spectrum', 'selectedPid', 'selectedChannel',
];
const METER_F32_EXACT = new Set(['peaks', 'rms', 'phase', 'scopeL', 'scopeR']);
const METER_TOLERANT = new Map([['lufs', -70.0], ['spectrum', -80.0]]); // sentinel literals
const METER_TOLERANCE = 1e-6; // abs, dB

// ---- staged exclusions (TEMPORARY; see header) --------------------------------

// --m5-stage canonical exclusion sets: each stage's set is the full §4
// compared surface minus everything the C++ port implements BY that stage
// (later stages are strict subsets - the shrink schedule for the M5 port
// tasks, frozen here so each task only flips the stage name):
//   core  demux core only: pcm kind staged out entirely (aes3 pending),
//         pes nal tables + snapshot nal fields empty (nal pending), meter
//         DSP empty shapes (meter pending) - M5 step 4's 20-entry set.
//   nal   + nal.rs: drops pes:nalOffsets, pes:nalTypes, nalPids, nalStats,
//         ringNal, ringNalOffsets.
//   aes3  + aes3.rs: also drops the 6 pcm:* entries (kind-5 events now
//         exist and compare in full).
//   meter + meter.rs: also drops the 8 meter DSP fields.
//   full  no exclusions - identical to the flagless run (meter/full
//         coincide; both kept so the flag reads forward).
const M5_STAGE_EXCLUSIONS = {
    core: [
        'pcm:pid', 'pcm:pts', 'pcm:streamType', 'pcm:programNum', 'pcm:sampleCount', 'pcm:samplesSha256',
        'pes:nalOffsets', 'pes:nalTypes',
        'nalPids', 'nalStats', 'ringNal', 'ringNalOffsets',
        'peaks', 'rms', 'clips', 'lufs', 'phase', 'scopeL', 'scopeR', 'spectrum',
    ],
    nal: [
        'pcm:pid', 'pcm:pts', 'pcm:streamType', 'pcm:programNum', 'pcm:sampleCount', 'pcm:samplesSha256',
        'peaks', 'rms', 'clips', 'lufs', 'phase', 'scopeL', 'scopeR', 'spectrum',
    ],
    aes3: ['peaks', 'rms', 'clips', 'lufs', 'phase', 'scopeL', 'scopeR', 'spectrum'],
    meter: [],
    full: [],
};

const EXCLUDE_EVENTS = new Map(); // kind name -> Set<field>
const EXCLUDE_SNAPSHOT = new Set();
let CPP = false; // --cpp: side B runs the C++ port instead of Rust
let M5_STAGE = null; // --m5-stage <name>: canonical staged-exclusion set
{
    // Pass 1 collects flags and expands the stage into --exclude entries;
    // pass 2 validates them all through the same path (stage entries are
    // hardcoded valid, but routing them through the identical check keeps
    // the table honest).
    const raw = process.argv.slice(2);
    const excludeArgs = [];
    for (let i = 0; i < raw.length; i++) {
        const arg = raw[i];
        if (arg === '--cpp') {
            CPP = true;
            continue;
        }
        if (arg === '--m5-stage' || arg.startsWith('--m5-stage=')) {
            const stage = arg.startsWith('--m5-stage=') ? arg.slice('--m5-stage='.length) : raw[++i];
            if (stage === undefined || !Object.prototype.hasOwnProperty.call(M5_STAGE_EXCLUSIONS, stage)) {
                fail(`bad --m5-stage "${stage ?? ''}" - expected one of {${Object.keys(M5_STAGE_EXCLUSIONS).join('|')}}`);
            }
            if (M5_STAGE !== null && M5_STAGE !== stage) {
                fail(`--m5-stage given twice (${M5_STAGE} and ${stage}) - one stage per run`);
            }
            M5_STAGE = stage;
            excludeArgs.push(...M5_STAGE_EXCLUSIONS[stage].map((e) => `--exclude=${e}`));
            continue;
        }
        if (!arg.startsWith('--exclude=')) {
            fail(`unknown argument "${arg}" (usage: node js/demux_parity.mjs [--cpp] [--m5-stage <core|nal|aes3|meter|full>] [--exclude=kind:field | --exclude=snapshot-field]...)`);
        }
        excludeArgs.push(arg);
    }
    for (const arg of excludeArgs) {
        const entry = arg.slice('--exclude='.length);
        const colon = entry.indexOf(':');
        if (colon !== -1) {
            const kind = entry.slice(0, colon);
            const field = entry.slice(colon + 1);
            if (!KIND_NAMES.includes(kind) || !EVENT_FIELDS[kind].includes(field)) {
                fail(`bad event exclusion "${entry}" - expected kind:field, kind in {${KIND_NAMES.join('|')}} and field in that kind's §4.1 canonical form`);
            }
            if (!EXCLUDE_EVENTS.has(kind)) EXCLUDE_EVENTS.set(kind, new Set());
            EXCLUDE_EVENTS.get(kind).add(field);
        } else {
            if (WALL_CLOCK_FIELDS.includes(entry)) {
                fail(`"${entry}" is excluded by spec §4.2 (wall clock) - staged exclusions apply to compared fields only`);
            }
            if (!SNAPSHOT_FIELDS.includes(entry) && !METER_FIELDS.includes(entry)) {
                fail(`bad snapshot exclusion "${entry}" - expected a DebugSnapshot or MeterSnapshot field name`);
            }
            EXCLUDE_SNAPSHOT.add(entry);
        }
    }
}
{
    if (M5_STAGE !== null) {
        const n = M5_STAGE_EXCLUSIONS[M5_STAGE].length;
        console.log(`note: --m5-stage ${M5_STAGE} - canonical staged-exclusion set${n === 0 ? ' (empty: identical to the flagless full comparison)' : ` (${n} entries)`}`);
    }
    const entries = [...EXCLUDE_EVENTS].flatMap(([k, s]) => [...s].map((f) => `${k}:${f}`)).concat([...EXCLUDE_SNAPSHOT]);
    if (entries.length > 0) {
        console.log(`note: TEMPORARY staged exclusions active (C++ port rollout): ${entries.join(', ')} - skipped comparisons are counted and reported in the summary`);
    }
}
const EXCLUDED_COUNTS = new Map(); // entry -> comparisons skipped
const countExcluded = (entry) => EXCLUDED_COUNTS.set(entry, (EXCLUDED_COUNTS.get(entry) ?? 0) + 1);

// A kind whose EVERY §4.1 field is excluded is staged out entirely (see
// runCase): its events are dropped from both sides of the comparison.
const kindStagedOut = (kind) => {
    const excl = EXCLUDE_EVENTS.get(kind);
    return excl !== undefined && excl.size === EVENT_FIELDS[kind].length;
};
const countKindStagedOut = (kind) => {
    for (const f of EVENT_FIELDS[kind]) countExcluded(`${kind}:${f}`);
};

const COUNTS = {
    caseRuns: 0,
    eventPairs: 0, eventFields: 0, streamCompares: 0,
    snaps: 0, snapFields: 0, wallClock: 0,
    meters: 0, meterFields: 0,
};

// ---- canonical forms (§4.1) ----------------------------------------------------

// §5.4 (b): the fork embeds " <cargo-checkout-path>:<line>" in every parse
// error; §4.1 kind 4 strips " \(at .+\)$" off the reason.
const ERR_RAW_RE = /^ts parse: (InvalidInput|Unsupported|Other): .+ \(at .+:\d+\)$/;
const stripAt = (s) => s.replace(/ \(at .+\)$/, '');

function int90k(caseName, what, x) {
    // pts/dts getters return f64 carrying 33-bit ints or -1 (§4.1)
    if (!Number.isInteger(x)) fail(`${caseName}: ${what} = ${x} - 90 kHz values must serialize as integers (§4.1)`);
    return x;
}

function sha256F32(f32) {
    // raw f32 bit patterns (little-endian), not decimal forms (§4.1 kind 5)
    return createHash('sha256').update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)).digest('hex');
}

function canonEvent(e, caseName, watch) {
    const kind = e.kind;
    const name = KIND_NAMES[kind];
    if (name === undefined) fail(`${caseName}: TsEvent.kind = ${kind}, expected 0-5`);
    // stream_type is a per-kind constant (always 0 except kind 5 = 0x06) -
    // compared as a constant, never inferred (§4.1).
    const st = e.stream_type;
    const stWant = kind === 5 ? 6 : 0;
    if (st !== stWant) fail(`${caseName}: ${name} event stream_type = ${st}, constant ${stWant} violated (§4.1)`);
    const c = { kind: name };
    if (kind === 0) { // pat: pid is the PMT pid
        c.pid = e.pid;
        c.programNum = e.program_num;
    } else if (kind === 1) { // pmt
        c.pid = e.pid;
        c.pmtEntries = e.pmtEntries();
        c.pmtFormatIds = e.pmtFormatIds();
    } else if (kind === 2) { // pes
        c.pid = e.pid;
        c.pts = int90k(caseName, 'pes pts', e.pts);
        c.dts = int90k(caseName, 'pes dts', e.dts);
        c.randomAccess = e.randomAccess;
        const data = e.data;
        c.dataLen = data.length;
        c.dataSha256 = createHash('sha256').update(data).digest('hex');
        c.nalOffsets = e.nalOffsets;
        c.nalTypes = e.nalTypes;
    } else if (kind === 3) { // random_access
        c.pid = e.pid;
    } else if (kind === 4) { // error
        const raw = e.text;
        const canon = stripAt(raw);
        if (watch) { // §5.4 (C6): prove the stripper is exact
            watch.errEvents++;
            if (!ERR_RAW_RE.test(raw)) watch.errRawBad++;
            if (canon.includes(' (at ')) watch.errCanonBad++;
        }
        c.text = canon;
    } else { // 5 pcm (SMPTE 302M): programNum carries channel_count
        c.pid = e.pid;
        c.pts = int90k(caseName, 'pcm pts', e.pts);
        c.streamType = st;
        c.programNum = e.program_num;
        const s = e.samples;
        c.sampleCount = s.length;
        c.samplesSha256 = sha256F32(s);
    }
    return c;
}

// ---- comparator (§4) ------------------------------------------------------------

class ParityError extends Error {}

function fmtVal(v) {
    if (v === undefined) return '<none>';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return v.length > 80 ? `${JSON.stringify(v.slice(0, 80))}…` : JSON.stringify(v);
    if (ArrayBuffer.isView(v) || Array.isArray(v)) return `${Array.isArray(v) ? 'array' : v.constructor.name}(${v.length})`;
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : (s.length > 80 ? `${s.slice(0, 80)}…` : s);
}

// First divergence only (§5.6): case id, where (event/snapshot index, feed,
// byte offset), field, both values.
function diverge(ctx, where, field, a, b) {
    throw new ParityError(`${ctx.caseName}: ${where}: ${field}: A=${fmtVal(a)} B=${fmtVal(b)}`);
}

// NaN-tolerant equality for f64 snapshot vectors (never legitimate, but a
// NaN on both sides must not read as a divergence).
const numEq = (x, y) => x === y || (Number.isNaN(x) && Number.isNaN(y));

const f32Scratch = new ArrayBuffer(4);
const f32View = new Float32Array(f32Scratch);
const u32View = new Uint32Array(f32Scratch);
function f32Bits(x) {
    f32View[0] = x;
    return u32View[0];
}
const SENTINEL_BITS = new Map([...METER_TOLERANT].map(([f, s]) => [f, f32Bits(s)]));

// The canonical digest (§5.5) covers exactly the compared data, so a
// wall-clock leak into any compared field changes it across two runs.
function digestField(ctx, tag, v) {
    if (ctx.digest === null) return;
    ctx.digest.update(`${tag}=`);
    if (ArrayBuffer.isView(v)) {
        ctx.digest.update(`#${v.length};`);
        ctx.digest.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    } else if (Array.isArray(v)) {
        ctx.digest.update(`#${v.length};`);
        for (const x of v) ctx.digest.update(`${typeof x === 'string' ? x : String(x)},`);
    } else {
        ctx.digest.update(String(v));
    }
    ctx.digest.update('\n');
}

function compareCanonFields(cA, cB, ctx, where) {
    const excl = EXCLUDE_EVENTS.get(cA.kind);
    for (const f of EVENT_FIELDS[cA.kind]) {
        if (excl !== undefined && excl.has(f)) {
            countExcluded(`${cA.kind}:${f}`);
            continue;
        }
        const a = cA[f];
        const b = cB[f];
        if (Array.isArray(a) || ArrayBuffer.isView(a)) {
            if (a.length !== b.length) diverge(ctx, where, `${f}.length`, a.length, b.length);
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) diverge(ctx, where, `${f}[${i}]`, a[i], b[i]);
            }
        } else if (a !== b) {
            diverge(ctx, where, f, a, b);
        }
        digestField(ctx, `ev.${f}`, a);
        COUNTS.eventFields++;
    }
}

function compareEvents(cA, cB, ctx, where) {
    if (cA.kind !== cB.kind) diverge(ctx, where, 'kind', cA.kind, cB.kind);
    digestField(ctx, 'ev.kind', cA.kind);
    compareCanonFields(cA, cB, ctx, where);
    COUNTS.eventPairs++;
}

function compareSnapshots(sA, sB, ctx, where) {
    for (const f of SNAPSHOT_FIELDS) {
        if (EXCLUDE_SNAPSHOT.has(f)) {
            countExcluded(f);
            continue;
        }
        let a = sA[f];
        let b = sB[f];
        if (f === 'errorMsg') { // canonicalized per §4.1
            a = a.map(stripAt);
            b = b.map(stripAt);
        }
        if (SNAPSHOT_STRING_ARRAYS.has(f)) {
            if (a.length !== b.length) diverge(ctx, where, `${f}.length`, a.length, b.length);
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) diverge(ctx, where, `${f}[${i}]`, a[i], b[i]);
            }
        } else if (typeof a === 'number') { // programNum, pmtPid
            if (!numEq(a, b)) diverge(ctx, where, f, a, b);
        } else {
            if (a.length !== b.length) diverge(ctx, where, `${f}.length`, a.length, b.length);
            for (let i = 0; i < a.length; i++) {
                if (!numEq(a[i], b[i])) diverge(ctx, where, `${f}[${i}]`, a[i], b[i]);
            }
        }
        digestField(ctx, `snap.${f}`, a);
        COUNTS.snapFields++;
    }
    // Wall-clock trio (§4.2): assert finite >= 0, never compare.
    for (const f of WALL_CLOCK_FIELDS) {
        const a = sA[f];
        for (let i = 0; i < a.length; i++) {
            if (!Number.isFinite(a[i]) || a[i] < 0) {
                diverge(ctx, where, `${f}[${i}]`, a[i], 'wall-clock fields must be finite >= 0 (§4.2)');
            }
            COUNTS.wallClock++;
        }
    }
    COUNTS.snaps++;
}

function compareMeters(mA, mB, ctx, where) {
    for (const f of METER_FIELDS) {
        if (EXCLUDE_SNAPSHOT.has(f)) {
            countExcluded(f);
            continue;
        }
        const a = mA[f];
        const b = mB[f];
        if (typeof a === 'number') { // selectedPid, selectedChannel
            if (!numEq(a, b)) diverge(ctx, where, f, a, b);
        } else {
            if (a.length !== b.length) diverge(ctx, where, `${f}.length`, a.length, b.length);
            const sentinel = METER_TOLERANT.get(f);
            if (sentinel !== undefined) {
                // tolerant abs 1e-6 dB, but the -70/-80 sentinels match as
                // literals (§4.3)
                const sbits = SENTINEL_BITS.get(f);
                for (let i = 0; i < a.length; i++) {
                    if (f32Bits(a[i]) === f32Bits(b[i])) continue;
                    if (f32Bits(a[i]) === sbits || f32Bits(b[i]) === sbits) {
                        diverge(ctx, where, `${f}[${i}] (sentinel ${sentinel} must match as a literal)`, a[i], b[i]);
                    }
                    if (Math.abs(a[i] - b[i]) > METER_TOLERANCE) {
                        diverge(ctx, where, `${f}[${i}] (abs diff > ${METER_TOLERANCE})`, a[i], b[i]);
                    }
                }
            } else if (METER_F32_EXACT.has(f)) {
                for (let i = 0; i < a.length; i++) {
                    if (f32Bits(a[i]) !== f32Bits(b[i])) diverge(ctx, where, `${f}[${i}] (exact-bit)`, a[i], b[i]);
                }
            } else { // pids, channelCounts, clips
                for (let i = 0; i < a.length; i++) {
                    if (a[i] !== b[i]) diverge(ctx, where, `${f}[${i}]`, a[i], b[i]);
                }
            }
        }
        digestField(ctx, `meter.${f}`, a);
        COUNTS.meterFields++;
    }
    COUNTS.meters++;
}

// ---- §2 crafted corruptions (feed-time transforms; nothing stored) -------------

const S1_VIDEO_PID = 0x100; // ffmpeg default first ES pid; asserted against the S1 PMT below

// Packet subsequence of one PID: {o (byte offset), pusi, afc}. §2 selector
// helpers - packet indexing is 0-based from the first byte of the buffer.
function scanPid(buf, pid) {
    const out = [];
    for (let o = 0; o + 188 <= buf.length; o += 188) {
        if (buf[o] !== 0x47 || (((buf[o + 1] & 0x1f) << 8) | buf[o + 2]) !== pid) continue;
        out.push({ o, pusi: (buf[o + 1] & 0x40) !== 0, afc: (buf[o + 3] >> 4) & 3 });
    }
    return out;
}

function requireVideoPkts(caseName, buf) {
    const pkts = scanPid(buf, S1_VIDEO_PID);
    if (pkts.length === 0) fail(`${caseName}: no pid 0x${S1_VIDEO_PID.toString(16)} packets - fixture drift?`);
    return pkts;
}

// Deep copy - fixtures are Node Buffers and Buffer#slice/subarray would
// alias the shared pristine bytes (each corruption must stand alone).
const copyOf = (buf) => new Uint8Array(buf);

// C1: TEI bit on a PesContinuation that is not the last packet of its PES
// (a continuation followed by >= 2 more before the next PesStart).
function corruptC1(buf) {
    const b = copyOf(buf);
    const pkts = requireVideoPkts('C1', b);
    for (let j = 0; j + 2 < pkts.length; j++) {
        if (!pkts[j].pusi && !pkts[j + 1].pusi && !pkts[j + 2].pusi) {
            b[pkts[j].o + 1] |= 0x80;
            return b;
        }
    }
    fail('C1: no run of >= 3 consecutive videoPid continuation packets - fixture drift?');
}

// C2: CC += 7 on the 2nd payload-bearing videoPid packet after the first PesStart.
function corruptC2(buf) {
    const b = copyOf(buf);
    const payload = requireVideoPkts('C2', b).filter((p) => (p.afc & 1) !== 0);
    const firstPes = payload.findIndex((p) => p.pusi);
    const t = payload[firstPes + 2];
    if (firstPes < 0 || t === undefined) fail('C2: no 2nd payload-bearing videoPid packet after the first PesStart - fixture drift?');
    const o = t.o + 3;
    b[o] = (b[o] & 0xf0) | ((b[o] + 7) & 0x0f);
    return b;
}

// C3: C2's CC break applied to a packet with AF (the first video PesStart,
// afc 0b11, carries PCR) plus the discontinuity_indicator - suppresses the
// CC error entirely (zero diff vs baseline).
function corruptC3(buf) {
    const b = copyOf(buf);
    const t = requireVideoPkts('C3', b).find((p) => p.pusi && p.afc === 3);
    if (t === undefined) fail('C3: no video PesStart with afc 0b11 - fixture drift?');
    b[t.o + 3] = (b[t.o + 3] & 0xf0) | ((b[t.o + 3] + 7) & 0x0f);
    b[t.o + 5] |= 0x80;
    return b;
}

// C7: null-packet span over packets [10, 60): 47 1F FF 10 + 184 x 0xFF each.
function corruptC7(buf) {
    const b = copyOf(buf);
    for (let i = 10; i < 60; i++) {
        const o = i * 188;
        b[o] = 0x47;
        b[o + 1] = 0x1f;
        b[o + 2] = 0xff;
        b[o + 3] = 0x10;
        b.fill(0xff, o + 4, o + 188);
    }
    return b;
}

function concatBuf(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

function chunkList(buf, size = CHUNK) {
    const out = [];
    for (let o = 0; o < buf.length; o += size) out.push(buf.subarray(o, Math.min(o + size, buf.length)));
    return out;
}

// ---- source loading =============================================================
//
// SEAM - the only implementation-aware code in this file. The comparator
// above consumes the wasm-bindgen surface as-is (new TsDemuxer / feed /
// debugSnapshot / meter_snapshot / setMeterSelection / free; events and
// snapshots read via property accessors, pmtEntries()/pmtFormatIds() as
// methods). The C++ port task (M5 steps 2-5) plugs in HERE: add a loader
// for build/srt_engine.mjs returning the same { label, createDemuxer }
// shape and hand it to side B below; comparator and canonicalizer stay
// untouched.

async function loadRustSource() {
    // ./build.sh page creates the page/wasm symlink (build.sh:114); without
    // it, fall back to the WebSRT checkout directly - same pkgs, the
    // symlink must not be required.
    const candidates = [
        resolve(HERE, '../page/wasm/mpeg2ts-wasm'),
        resolve(process.env.HOME ?? '', 'maxolgi/WebSRT/web/wasm/mpeg2ts-wasm'),
    ];
    const idx = candidates.findIndex((d) => existsSync(join(d, 'mpeg2ts_wasm.js')));
    if (idx < 0) fail(`mpeg2ts-wasm pkg not found (tried ${candidates.join(' and ')})`);
    const dir = candidates[idx];
    // initSync + fs bytes: the glue's default init() fetch()es its URL,
    // which node cannot do for file: URLs. One module, many demuxer
    // instances (§5.1).
    const glue = await import(pathToFileURL(join(dir, 'mpeg2ts_wasm.js')).href);
    glue.initSync({ module: new WebAssembly.Module(readFileSync(join(dir, 'mpeg2ts_wasm_bg.wasm'))) });
    return {
        label: idx === 0 ? 'rust:mpeg2ts-wasm (page/wasm symlink)' : 'rust:mpeg2ts-wasm (WebSRT checkout fallback)',
        createDemuxer: () => new glue.TsDemuxer(),
    };
}

// SEAM, C++ side: the M5 port (harness/ts_demux.{h,cpp}) exported from the
// engine module and wrapped by js/demux_engine.js into the same
// wasm-bindgen surface. Same { label, createDemuxer } shape as above.
async function loadCppSource() {
    const engine = await import('./demux_engine.js');
    await engine.default(); // loads build/srt_engine.mjs (built by ./build.sh engine)
    return {
        label: 'cpp:srt_engine.mjs (harness/ts_demux)',
        createDemuxer: () => new engine.TsDemuxer(),
    };
}

// ---- runners ---------------------------------------------------------------------

// Drives two demuxers over identical chunk lists in lockstep; after every
// feed: canonical events (§4.1), DebugSnapshot (§4.2), and - when meter is
// set - MeterSnapshot (§4.3), both sides called the same number of times at
// identical feed boundaries (meter_snapshot is &mut self and mutates).
function runCase(spec) {
    const dA = SRC_A.createDemuxer();
    const dB = SRC_B.createDemuxer();
    if (spec.selection !== undefined) {
        dA.setMeterSelection(spec.selection[0], spec.selection[1]);
        dB.setMeterSelection(spec.selection[0], spec.selection[1]);
    }
    const chunksB = spec.chunksB ?? spec.chunks;
    const feeds = Math.max(spec.chunks.length, chunksB.length);
    const ctx = { caseName: spec.id, digest: spec.digest === true ? createHash('sha256') : null };
    const watch = spec.watch === true ? { errEvents: 0, errRawBad: 0, errCanonBad: 0 } : null;
    const meta = { kinds: [0, 0, 0, 0, 0, 0], pesDtsNonNeg: 0, firstPmt: null, firstPcm: null };
    let eventIdx = 0, snapIdx = 0, meterIdx = 0, byteOff = 0;
    try {
        for (let feed = 0; feed < feeds; feed++) {
            const ca = spec.chunks[feed];
            const cb = chunksB[feed];
            if (ca === undefined || cb === undefined) {
                // mismatched sides are legitimate only for the negative
                // control; everywhere else this is a wiring bug
                diverge(ctx, `feed #${feed} @ +${byteOff}B`, 'feed count', spec.chunks.length, chunksB.length);
            }
            const evA = dA.feed(ca);
            const evB = dB.feed(cb);
            const cA = evA.map((e) => canonEvent(e, spec.id, watch));
            const cB = evB.map((e) => canonEvent(e, spec.id, null));
            try {
                // side-A metadata for the per-case gates below - collected
                // from every canonical event, including kinds staged out
                // below (the S5-S7 pcm gates must still see them)
                for (const c of cA) {
                    meta.kinds[KIND_NAMES.indexOf(c.kind)]++;
                    if (c.kind === 'pes' && c.dts >= 0) meta.pesDtsNonNeg++;
                    if (c.kind === 'pmt' && meta.firstPmt === null) meta.firstPmt = c.pmtEntries;
                    if (c.kind === 'pcm' && meta.firstPcm === null) meta.firstPcm = c;
                    if (spec.recordA !== undefined) spec.recordA.push(c);
                }
                // staged-out kinds: drop from BOTH sides before the count
                // check (a not-yet-ported kind exists on one side only),
                // counting each dropped side-A event per excluded field
                const keptA = [];
                for (const c of cA) {
                    if (kindStagedOut(c.kind)) countKindStagedOut(c.kind);
                    else keptA.push(c);
                }
                const keptB = cB.filter((c) => !kindStagedOut(c.kind));
                if (keptA.length !== keptB.length) {
                    diverge(ctx, `event #${eventIdx} (feed #${feed} @ +${byteOff}B)`, 'feed event count', keptA.length, keptB.length);
                }
                for (let i = 0; i < keptA.length; i++) {
                    compareEvents(keptA[i], keptB[i], ctx, `event #${eventIdx} (feed #${feed} @ +${byteOff}B)`);
                    eventIdx++;
                }
            } finally {
                for (const e of evA) e.free();
                for (const e of evB) e.free();
            }
            const sA = dA.debugSnapshot();
            const sB = dB.debugSnapshot();
            try {
                compareSnapshots(sA, sB, ctx, `snapshot #${snapIdx} (feed #${feed} @ +${byteOff}B)`);
                if (spec.meter === true) {
                    const mA = dA.meter_snapshot();
                    const mB = dB.meter_snapshot();
                    try {
                        compareMeters(mA, mB, ctx, `meter #${meterIdx} (feed #${feed} @ +${byteOff}B)`);
                    } finally {
                        mA.free();
                        mB.free();
                    }
                    meterIdx++;
                }
            } finally {
                sA.free();
                sB.free();
            }
            snapIdx++;
            byteOff += ca.length;
        }
    } catch (e) {
        if (e instanceof ParityError) {
            if (spec.negative === true) return { id: spec.id, failed: true, at: e.message };
            fail(`parity divergence — ${e.message}`);
        }
        throw e;
    } finally {
        dA.free();
        dB.free();
        COUNTS.caseRuns++;
    }
    return {
        id: spec.id, failed: false, feeds: spec.chunks.length, bytes: byteOff, events: eventIdx,
        snaps: snapIdx, meters: meterIdx, meta, watch,
        digest: ctx.digest === null ? null : ctx.digest.digest('hex'),
    };
}

// Side-A-only recorded canonical stream (chunk-boundary invariance §5.3,
// C4 tail-append assert).
function runStream(caseName, buf, size) {
    const d = SRC_A.createDemuxer();
    const out = [];
    try {
        for (const c of chunkList(buf, size)) {
            const evs = d.feed(c);
            for (const e of evs) {
                try {
                    out.push(canonEvent(e, caseName, null));
                } finally {
                    e.free();
                }
            }
        }
    } finally {
        d.free();
    }
    return out;
}

function compareStreams(caseName, a, b) {
    const ctx = { caseName, digest: null };
    if (a.length !== b.length) diverge(ctx, 'stream end', 'event count', a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        compareEvents(a[i], b[i], ctx, `event #${i} (recorded stream)`);
        COUNTS.streamCompares++;
    }
}

// ---- 1. fixtures (§1, manifest-gated per §3) --------------------------------------

const FIXTURES = [
    ['S1', 'av_shortgop.ts'],
    ['S2', 'v_longgop.ts'],
    ['S3', 'v_hevc.ts'],
    ['S4', 'a_aac.ts'],
    ['S5', 'a302m_16.ts'],
    ['S6', 'a302m_24.ts'],
    ['S7', 'a302m_24_6ch.ts'],
    ['S8', 'v_cbr_pad.ts'],
    ['S9', 'v_disc.ts'],
    ['S10', 'v_b_v1.ts'],
];
const METER_FIXTURES = new Set(['S5', 'S6', 'S7']); // §4.3 cadence
const FIX = new Map();
{
    let total = 0;
    for (const line of readFileSync(join(HERE, 'fixtures/manifest.sha256'), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const [sha, size, name] = line.trim().split(/\s+/);
        const buf = readFileSync(join(HERE, 'fixtures', name));
        if (buf.length !== Number(size)) fail(`fixtures/${name}: ${buf.length} B, manifest says ${size} B`);
        if (createHash('sha256').update(buf).digest('hex') !== sha) {
            fail(`fixtures/${name}: sha256 mismatch vs manifest.sha256 (regenerate with js/fixtures/gen.sh)`);
        }
        FIX.set(name, buf);
        total += buf.length;
    }
    if (FIX.size !== 10) fail(`manifest lists ${FIX.size} fixtures, expected 10`);
    const missing = FIXTURES.filter(([, n]) => !FIX.has(n)).map(([i]) => i);
    if (missing.length > 0) fail(`manifest is missing ${missing.join(', ')}`);
    pass(`10 golden fixtures match manifest.sha256 (${total.toLocaleString('en-US')} B of TS)`);
}
const S1 = FIX.get('av_shortgop.ts');

// ---- 2. sources -------------------------------------------------------------------

const SRC_A = await loadRustSource();
const SRC_B = CPP ? await loadCppSource() : SRC_A; // §5.1 Rust-vs-Rust: one
                      // pkg import, two instances. --cpp: side B = the port.
pass(`side A = ${SRC_A.label}, side B = ${SRC_B === SRC_A ? 'side A' : SRC_B.label}`);

// ---- 3. golden fixtures + crafted corruptions (§1/§2) + §4.3 selection passes ------

const pmtHas = (entries, pid, st) => {
    for (let i = 0; i + 1 < entries.length; i += 2) {
        if (entries[i] === pid && entries[i + 1] === st) return true;
    }
    return false;
};

const reportCase = (r) => pass(
    `${r.id} — ${r.bytes.toLocaleString('en-US')} B in ${r.feeds} feeds, ` +
    `${r.events} events (pat/pmt/pes/ra/err/pcm = ${r.meta.kinds.join('/')}), ` +
    `${r.snaps} debug snapshots${r.meters > 0 ? `, ${r.meters} meter snapshots` : ''}`,
);

for (const [id, name] of FIXTURES) {
    const r = runCase({ id, chunks: chunkList(FIX.get(name)), meter: METER_FIXTURES.has(id) });
    if (id === 'S1') {
        // spec §6 risk 4 + the §2 corruption selectors' pid assumptions
        if (r.meta.pesDtsNonNeg < 1) fail('S1: no pes event with dts >= 0 (-bf 3 encoder option drift?)');
        if (r.meta.firstPmt === null || !pmtHas(r.meta.firstPmt, 0x100, 0x1b) || !pmtHas(r.meta.firstPmt, 0x101, 0x0f)) {
            fail(`S1: first PMT [${r.meta.firstPmt === null ? '' : Array.from(r.meta.firstPmt).join(',')}] lacks 0x100->0x1B / 0x101->0x0F`);
        }
    }
    if (METER_FIXTURES.has(id)) {
        const ch = id === 'S7' ? 6 : 2;
        if (r.meta.firstPmt === null || !pmtHas(r.meta.firstPmt, 0x100, 0x06)) fail(`${id}: PMT lacks 0x100->0x06 (302M)`);
        if (r.meta.firstPcm === null || r.meta.firstPcm.pid !== 0x100 || r.meta.firstPcm.programNum !== ch) {
            fail(`${id}: first pcm event is not pid 0x100 with channel_count ${ch}`);
        }
    }
    reportCase(r);
}

const CORRUPTIONS = [
    { id: 'C1 (S1 TEI)', chunks: chunkList(corruptC1(S1)) },
    { id: 'C2 (S1 CC break)', chunks: chunkList(corruptC2(S1)) },
    { id: 'C3 (S1 CC break + discontinuity)', chunks: chunkList(corruptC3(S1)) },
    { id: 'C4 (S1 truncated 123 B, then tail)', chunks: [S1.subarray(0, S1.length - 123), S1.subarray(S1.length - 123)], record: [] },
    { id: 'C5 (S1 join @ packet 200)', chunks: chunkList(S1.subarray(200 * 188)) },
    { id: 'C6 (S1 misaligned @ 188*200+1)', chunks: chunkList(S1.subarray(188 * 200 + 1)), watch: true },
    { id: 'C7 (S1 null span [10,60))', chunks: chunkList(corruptC7(S1)) },
    { id: 'C8 (S1 ++ S10 PAT/PMT republish)', chunks: chunkList(concatBuf(S1, FIX.get('v_b_v1.ts'))) },
    { id: 'C9 (S1 ++ S1 PTS jump)', chunks: chunkList(concatBuf(S1, S1)) },
];
for (const c of CORRUPTIONS) {
    const r = runCase({ id: c.id, chunks: c.chunks, watch: c.watch === true, recordA: c.record });
    reportCase(r);
    if (c.id.startsWith('C4')) {
        // §2 C4 "(assert this)": leftover bytes are retained across feed()
        // calls - appending the missing tail surfaces the final packet's
        // events, so the two-phase stream equals the one-shot stream.
        const oneShot = runStream('C4 one-shot baseline', S1, CHUNK);
        compareStreams('C4 tail-append vs one-shot S1', c.record, oneShot);
        if (r.events !== oneShot.length) {
            fail(`C4: ${r.events} events across the two feeds, one-shot S1 has ${oneShot.length}`);
        }
        pass(`C4 tail-append — 123 B retained in FeedBuf across feed() calls, stream identical to one-shot S1 (${oneShot.length} events)`);
    }
    if (c.id.startsWith('C6')) {
        // §5.4 canonicalizer gate
        const w = r.watch;
        if (w.errEvents < 1) fail('C6: no kind-4 error events');
        if (w.errRawBad > 0) fail(`C6: ${w.errRawBad} raw error texts do not match ^ts parse: (InvalidInput|Unsupported|Other): … \\(at …:\\d+\\)$`);
        if (w.errCanonBad > 0) fail(`C6: ${w.errCanonBad} canonicalized texts still contain " (at "`);
        pass(`C6 error-text canonicalizer — ${w.errEvents} kind-4 events, raw texts carry the (at …) suffix, canonical texts stripped`);
    }
}

// §4.3: one extra pass per 302M fixture with setMeterSelection(pid, 1)
// issued before the first feed (scope partner swap + spectrum on ch1).
for (const [id, name] of FIXTURES.filter(([i]) => METER_FIXTURES.has(i))) {
    reportCase(runCase({ id: `${id}-sel (meter ch1)`, chunks: chunkList(FIX.get(name)), meter: true, selection: [0x100, 1] }));
}

// ---- 4. chunk-boundary invariance (§5.3) --------------------------------------------

for (const [id, name] of FIXTURES) {
    const buf = FIX.get(name);
    const s188 = runStream(`${id}@188`, buf, 188);
    const s1128 = runStream(`${id}@1128`, buf, CHUNK);
    const s7 = runStream(`${id}@7`, buf, 7);
    compareStreams(`${id} chunk invariance 1128 vs 188`, s1128, s188);
    compareStreams(`${id} chunk invariance 1128 vs 7`, s1128, s7);
    pass(`${id} chunk-boundary invariance — {188, 1128, 7} chunkings yield identical event streams (${s1128.length} events)`);
}

// ---- 5. wall-clock isolation (§5.5) ---------------------------------------------------

{
    const run1 = runCase({ id: 'wall-clock run 1 (S1)', chunks: chunkList(S1), digest: true });
    const run2 = runCase({ id: 'wall-clock run 2 (S1)', chunks: chunkList(S1), digest: true });
    if (run1.digest !== run2.digest) {
        fail(`two S1 runs produced different canonical digests (${run1.digest.slice(0, 16)}… vs ${run2.digest.slice(0, 16)}…) — a compared field leaks wall time`);
    }
    pass(`wall-clock isolation — S1 run twice, identical canonical digest (${run1.digest.slice(0, 16)}…)`);
}

// ---- 6. negative control (the comparator must be able to FAIL) ------------------------

{
    const neg = runCase({
        id: 'negative (S4 vs S1)',
        chunks: chunkList(FIX.get('a_aac.ts')),
        chunksB: chunkList(S1),
        negative: true,
    });
    if (!neg.failed) fail('negative control (side A fed a_aac, side B fed av_shortgop) did NOT diverge — comparator cannot fail');
    if (!/event #\d+ \(feed #\d+ @ \+\d+B\): [^:]+: A=.+ B=/.test(neg.at)) fail(`negative control report malformed: ${neg.at}`);
    pass(`negative control — comparator flagged: ${neg.at}`);
}

// ---- 7. summary ------------------------------------------------------------------------

const exclSummary = EXCLUDED_COUNTS.size === 0
    ? 'staged exclusions: none'
    : `staged exclusions (TEMPORARY): ${[...EXCLUDED_COUNTS].map(([k, n]) => `${k}=${n} skipped`).join(', ')}`;
console.log(
    `demux_parity: PASS — ${SRC_A.label} vs ${SRC_B === SRC_A ? 'itself' : SRC_B.label}: ` +
    `${COUNTS.caseRuns} case runs (10 fixtures + 9 corruptions + 3 selection passes + 2 wall-clock + 1 negative), ` +
    `${COUNTS.eventPairs} event pairs compared (${COUNTS.eventFields} canonical fields; ${COUNTS.streamCompares} pairs in recorded-stream checks), ` +
    `${COUNTS.snaps} debug snapshots (${COUNTS.snapFields} fields exact, ${COUNTS.wallClock} wall-clock values checked finite-only per §4.2), ` +
    `${COUNTS.meters} meter snapshots (${COUNTS.meterFields} fields), ${exclSummary}`,
);
process.exit(0);
