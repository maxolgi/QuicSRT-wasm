// M5 demux regression gate: the C++ demux (harness/ts_demux via
// build/srt_engine.mjs) vs the committed GOLDEN BASELINE
// js/fixtures/demux.baseline.json. The corpus and §-canonicalization
// below follow the recorded contract.
//
// Provenance: the baseline was recorded from the C++ build at a commit
// where it was proven byte-identical to the Rust oracle over this exact
// corpus (see the provenance field in the baseline file). The recorded
// digests carry that parity forward - this gate is self-contained, it
// loads nothing outside the repo.
//
// 1. Load the ten golden fixtures (§1; sha/size-gated against
//    js/fixtures/manifest.sha256 per §3).
// 2. Run every §1 fixture + every §2 crafted corruption (byte transforms
//    applied AT FEED TIME - nothing corrupted is stored) plus one extra
//    pass per 302M fixture with setMeterSelection(pid, 1) issued before
//    the first feed (§4.3), through a TsDemuxer in 1128-byte chunks (6x188,
//    the live SRT payload size), digesting after EVERY feed: canonical
//    events (§4.1) into the per-case event-stream digest, DebugSnapshot
//    (§4.2) into the snapshot digest and - on the 302M fixtures -
//    MeterSnapshot (§4.3) into the meter digest. PES bytes and PCM f32
//    sample bits enter the digest via sha256 (bit-exact pinning);
//    ringT/errorT/bitratesMbps stay excluded everywhere (§4.2, checked
//    finite >= 0 only) so nothing leaks wall time into the baseline.
//    Per-case counts (feeds/bytes/events/snaps/meters/kinds) gate the
//    digests for sanity.
// 3. Chunk-boundary invariance (§5.3): each fixture re-run at chunk sizes
//    {188, 1128, 7} must produce identical concatenated event streams.
// 4. Error-text canonicalizer (§5.4, ported form): C6's raw kind-4 texts
//    match ^ts parse: (InvalidInput|Unsupported|Other): .+$ - the C++
//    port omits the Rust fork's machine-specific " (at file:line)"
//    location suffix (harness/ts_demux.cpp), so its reappearance is
//    flagged too; the canonicalized texts contain no " (at " either way.
// 5. Wall-clock isolation (§5.5): one fixture run twice must produce the
//    identical canonical digests, and both must match the baseline entry.
// 6. Negative control: an honest S4 run compared against its own baseline
//    entry with ONE digest tampered in memory MUST be flagged - the gate
//    is provably able to fail.
//
// Usage:
//   node js/demux_parity.mjs           gate vs the baseline (exit 0 = pass)
//   node js/demux_parity.mjs --record  re-record the baseline from the
//                                      current build and print the drift
//                                      vs the existing file
//
// On divergence exit 1 with case id and the first mismatching count or
// digest.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineProvenance, currentCommit, loadBaseline, reportBaselineDrift, writeBaseline } from './baseline.js';

function fail(msg) {
    console.error(`demux_parity: FAIL: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`PASS: ${msg}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CHUNK = 1128; // 6x188, the live SRT payload size (§5.2)

const RECORD = process.argv.slice(2).includes('--record');
for (const arg of process.argv.slice(2)) {
    if (arg !== '--record') fail(`unknown argument "${arg}" (usage: node js/demux_parity.mjs [--record])`);
}

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

// DebugSnapshot §4.2: digested exactly. The wall-clock trio below is NOT
// in this list - it is asserted finite >= 0 and never digested.
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
const WALL_CLOCK_FIELDS = ['ringT', 'errorT', 'bitratesMbps']; // §4.2 excluded

// MeterSnapshot §4.3 (adopted verbatim):
// all 12 fields digested raw - the baseline pins exact f32 bits, the
// cross-implementation ±1e-6 dB tolerance is retired.
const METER_FIELDS = [
    'pids', 'channelCounts', 'peaks', 'clips', 'rms', 'lufs', 'phase',
    'scopeL', 'scopeR', 'spectrum', 'selectedPid', 'selectedChannel',
];

const COUNTS = {
    caseRuns: 0, baselineCases: 0,
    events: 0, eventFields: 0, streamCompares: 0,
    snaps: 0, snapFields: 0, wallClock: 0,
    meters: 0, meterFields: 0,
};

// ---- canonical forms (§4.1) ----------------------------------------------------

// §5.4: the Rust fork's Display embedded " <cargo-checkout-path>:<line>"
// in every parse error, so §4.1 kind 4 strips " \(at .+\)$" off the
// reason; the C++ port omits the suffix already (harness/ts_demux.cpp)
// and the strip must stay a no-op, never a hiding place.
const ERR_RAW_RE = /^ts parse: (InvalidInput|Unsupported|Other): .+$/;
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
        if (watch) { // §5.4 (C6): prove the canonical form holds
            watch.errEvents++;
            if (!ERR_RAW_RE.test(raw)) watch.errRawBad++;
            if (raw.includes(' (at ')) watch.errAtBad++;
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

// ---- digests (the baseline pins exactly what §4 compared) -----------------------

class ParityError extends Error {}

function fmtVal(v) {
    if (v === undefined) return '<none>';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return v.length > 80 ? `${JSON.stringify(v.slice(0, 80))}…` : JSON.stringify(v);
    if (ArrayBuffer.isView(v) || Array.isArray(v)) return `${Array.isArray(v) ? 'array' : v.constructor.name}(${v.length})`;
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : (s.length > 80 ? `${s.slice(0, 80)}…` : s);
}

// First divergence only (§5.6 style): case id, where, field, both values.
function diverge(ctx, where, field, a, b) {
    throw new ParityError(`${ctx.caseName}: ${where}: ${field}: A=${fmtVal(a)} B=${fmtVal(b)}`);
}

// 64-hex digests print as 16 chars + ellipsis; anything else as JSON.
const shortVal = (v) => (typeof v === 'string' && v.length > 24 ? `${v.slice(0, 16)}…` : JSON.stringify(v));

function digestField(h, tag, v) {
    h.update(`${tag}=`);
    if (ArrayBuffer.isView(v)) {
        h.update(`#${v.length};`);
        h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    } else if (Array.isArray(v)) {
        h.update(`#${v.length};`);
        for (const x of v) h.update(`${typeof x === 'string' ? x : String(x)},`);
    } else {
        h.update(String(v));
    }
    h.update('\n');
}

function digestEvent(c, h) {
    digestField(h, 'ev.kind', c.kind);
    for (const f of EVENT_FIELDS[c.kind]) {
        digestField(h, `ev.${f}`, c[f]);
        COUNTS.eventFields++;
    }
    COUNTS.events++;
}

function digestSnapshot(s, ctx, where) {
    for (const f of SNAPSHOT_FIELDS) {
        const a = f === 'errorMsg' ? s[f].map(stripAt) : s[f]; // §4.1 canonical
        digestField(ctx.snap, `snap.${f}`, a);
        COUNTS.snapFields++;
    }
    // Wall-clock trio (§4.2): assert finite >= 0, never digest.
    for (const f of WALL_CLOCK_FIELDS) {
        const a = s[f];
        for (let i = 0; i < a.length; i++) {
            if (!Number.isFinite(a[i]) || a[i] < 0) {
                fail(`${ctx.caseName}: ${where}: ${f}[${i}] = ${a[i]} - wall-clock fields must be finite >= 0 (§4.2)`);
            }
            COUNTS.wallClock++;
        }
    }
    COUNTS.snaps++;
}

function digestMeter(m, ctx) {
    for (const f of METER_FIELDS) {
        digestField(ctx.meter, `meter.${f}`, m[f]);
        COUNTS.meterFields++;
    }
    COUNTS.meters++;
}

// ---- in-run stream comparisons (self-consistency; no baseline involved) --------

function compareCanonFields(cA, cB, ctx, where) {
    for (const f of EVENT_FIELDS[cA.kind]) {
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
        COUNTS.eventFields++;
    }
}

function compareEvents(cA, cB, ctx, where) {
    if (cA.kind !== cB.kind) diverge(ctx, where, 'kind', cA.kind, cB.kind);
    compareCanonFields(cA, cB, ctx, where);
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
// The ONLY implementation this gate loads: the C++ demux (harness/ts_demux)
// exported from the engine module and wrapped by js/demux_engine.js into
// the wasm-bindgen surface the canonicalizer consumes (new TsDemuxer /
// feed / debugSnapshot / meter_snapshot / setMeterSelection / free). The
// golden baseline IS the oracle - nothing outside this repo is read.

async function loadSource() {
    const engine = await import('./demux_engine.js');
    await engine.default(); // loads build/srt_engine.mjs (built by ./build.sh engine)
    return {
        label: 'cpp:srt_engine.mjs (harness/ts_demux)',
        createDemuxer: () => new engine.TsDemuxer(),
    };
}

// ---- runners ---------------------------------------------------------------------

// Drives one demuxer over the chunk list; after every feed: canonical
// events (§4.1) into the event-stream digest, DebugSnapshot (§4.2) into
// the snapshot digest and - when meter is set - MeterSnapshot (§4.3) into
// the meter digest (meter_snapshot is &mut self and mutates, so it is
// called at the same feed boundaries the baseline was recorded at).
function runCase(spec) {
    const d = SRC.createDemuxer();
    if (spec.selection !== undefined) {
        d.setMeterSelection(spec.selection[0], spec.selection[1]);
    }
    const metered = spec.meter === true;
    const evH = createHash('sha256');
    const ctx = {
        caseName: spec.id,
        snap: createHash('sha256'),
        meter: metered ? createHash('sha256') : null,
    };
    const watch = spec.watch === true ? { errEvents: 0, errRawBad: 0, errAtBad: 0, errCanonBad: 0 } : null;
    const meta = { kinds: [0, 0, 0, 0, 0, 0], pesDtsNonNeg: 0, firstPmt: null, firstPcm: null };
    let eventIdx = 0, snapIdx = 0, meterIdx = 0, byteOff = 0;
    try {
        for (let feed = 0; feed < spec.chunks.length; feed++) {
            const chunk = spec.chunks[feed];
            const evs = d.feed(chunk);
            const canon = evs.map((e) => canonEvent(e, spec.id, watch));
            try {
                for (const c of canon) {
                    meta.kinds[KIND_NAMES.indexOf(c.kind)]++;
                    if (c.kind === 'pes' && c.dts >= 0) meta.pesDtsNonNeg++;
                    if (c.kind === 'pmt' && meta.firstPmt === null) meta.firstPmt = c.pmtEntries;
                    if (c.kind === 'pcm' && meta.firstPcm === null) meta.firstPcm = c;
                    if (spec.record !== undefined) spec.record.push(c);
                    digestEvent(c, evH);
                }
            } finally {
                for (const e of evs) e.free();
            }
            eventIdx += canon.length;
            const s = d.debugSnapshot();
            try {
                digestSnapshot(s, ctx, `snapshot #${snapIdx} (feed #${feed} @ +${byteOff}B)`);
                if (metered) {
                    const m = d.meter_snapshot();
                    try {
                        digestMeter(m, ctx);
                    } finally {
                        m.free();
                    }
                    meterIdx++;
                }
            } finally {
                s.free();
            }
            snapIdx++;
            byteOff += chunk.length;
        }
    } finally {
        d.free();
        COUNTS.caseRuns++;
    }
    const digests = { evDigest: evH.digest('hex'), snapDigest: ctx.snap.digest('hex') };
    if (metered) digests.meterDigest = ctx.meter.digest('hex');
    return {
        id: spec.id, feeds: spec.chunks.length, bytes: byteOff, events: eventIdx,
        snaps: snapIdx, meters: meterIdx, meta, watch, digests,
    };
}

// Recorded canonical stream (chunk-boundary invariance §5.3, C4
// tail-append assert).
function runStream(caseName, buf, size) {
    const d = SRC.createDemuxer();
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
    const ctx = { caseName };
    if (a.length !== b.length) diverge(ctx, 'stream end', 'event count', a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        try {
            compareEvents(a[i], b[i], ctx, `event #${i} (recorded stream)`);
        } catch (e) {
            if (e instanceof ParityError) fail(`stream divergence — ${e.message}`);
            throw e;
        }
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

// ---- 2. source + baseline ----------------------------------------------------------

const SRC = await loadSource();
pass(`source = ${SRC.label}`);

const BASELINE_FILE = join(HERE, 'fixtures/demux.baseline.json');
const OLD_BASELINE = loadBaseline(BASELINE_FILE);
if (!RECORD && OLD_BASELINE === null) {
    fail(`no baseline at ${BASELINE_FILE} - record one first (node js/demux_parity.mjs --record)`);
}
if (OLD_BASELINE !== null && (typeof OLD_BASELINE.cases !== 'object' || OLD_BASELINE.cases === null)) {
    fail(`${BASELINE_FILE}: malformed baseline (no cases object) - re-record with --record`);
}
const BASELINE_CASES = RECORD ? {} : OLD_BASELINE.cases;
const NEW_CASES = RECORD ? {} : null;
if (!RECORD) pass(`baseline = ${BASELINE_FILE} (${OLD_BASELINE.provenance})`);

// The per-case baseline entry: counts gate the digests for sanity.
function baselineEntry(r) {
    const e = {
        feeds: r.feeds, bytes: r.bytes, events: r.events, snaps: r.snaps, meters: r.meters,
        kinds: r.meta.kinds,
        evDigest: r.digests.evDigest,
        snapDigest: r.digests.snapDigest,
    };
    if (r.digests.meterDigest !== undefined) e.meterDigest = r.digests.meterDigest;
    return e;
}

// First mismatch only, §5.6 style: case id, field, run value vs baseline.
function assertBaseline(caseId, r, entry) {
    const run = baselineEntry(r);
    const keys = new Set([...Object.keys(run), ...Object.keys(entry)]);
    for (const f of keys) {
        const a = run[f];
        const b = entry[f];
        if (a === undefined || b === undefined) {
            throw new ParityError(`${caseId}: ${f}: ${a === undefined ? 'the run lacks it' : 'the baseline entry lacks it'} (stale baseline? re-record with --record)`);
        }
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            throw new ParityError(`${caseId}: ${f}: run ${shortVal(a)} vs baseline ${shortVal(b)}`);
        }
    }
}

const checkCase = (r) => {
    if (RECORD) {
        NEW_CASES[r.id] = baselineEntry(r);
        return;
    }
    const entry = BASELINE_CASES[r.id];
    if (entry === undefined) fail(`baseline has no entry for "${r.id}" (stale baseline? re-record with --record)`);
    try {
        assertBaseline(r.id, r, entry);
    } catch (e) {
        if (e instanceof ParityError) fail(`baseline divergence — ${e.message}`);
        throw e;
    }
    COUNTS.baselineCases++;
};

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
    checkCase(r);
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
    const r = runCase({ id: c.id, chunks: c.chunks, watch: c.watch === true, record: c.record });
    reportCase(r);
    checkCase(r);
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
        // §5.4 canonicalizer gate (ported form, see header)
        const w = r.watch;
        if (w.errEvents < 1) fail('C6: no kind-4 error events');
        if (w.errRawBad > 0) fail(`C6: ${w.errRawBad} raw error texts do not match ^ts parse: (InvalidInput|Unsupported|Other): …$`);
        if (w.errAtBad > 0) fail(`C6: ${w.errAtBad} raw error texts carry the " (at …)" location suffix the port omits`);
        if (w.errCanonBad > 0) fail(`C6: ${w.errCanonBad} canonicalized texts still contain " (at "`);
        pass(`C6 error-text canonicalizer — ${w.errEvents} kind-4 events, raw texts in §4.1 form with no location suffix`);
    }
}

// §4.3: one extra pass per 302M fixture with setMeterSelection(pid, 1)
// issued before the first feed (scope partner swap + spectrum on ch1).
for (const [id, name] of FIXTURES.filter(([i]) => METER_FIXTURES.has(i))) {
    const r = runCase({ id: `${id}-sel (meter ch1)`, chunks: chunkList(FIX.get(name)), meter: true, selection: [0x100, 1] });
    reportCase(r);
    checkCase(r);
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
    const run1 = runCase({ id: 'wall-clock run 1 (S1)', chunks: chunkList(S1) });
    const run2 = runCase({ id: 'wall-clock run 2 (S1)', chunks: chunkList(S1) });
    for (const k of new Set([...Object.keys(run1.digests), ...Object.keys(run2.digests)])) {
        if (run1.digests[k] !== run2.digests[k]) {
            fail(`two S1 runs produced different ${k} (${shortVal(run1.digests[k])} vs ${shortVal(run2.digests[k])}) — a digested field leaks wall time`);
        }
    }
    // Both reruns must also match the recorded S1 entry (gate mode: the
    // committed file; record mode: the entry captured this run).
    try {
        assertBaseline('wall-clock rerun (S1)', run1, (RECORD ? NEW_CASES : BASELINE_CASES)['S1']);
    } catch (e) {
        if (e instanceof ParityError) fail(`baseline divergence — ${e.message}`);
        throw e;
    }
    pass(`wall-clock isolation — S1 run twice, identical canonical digests (${run1.digests.evDigest.slice(0, 16)}…), both matching the baseline`);
}

// ---- 6. negative control (the gate must be able to FAIL) ------------------------------

{
    // Honest S4 run vs its own baseline entry with ONE digest tampered in
    // memory: the comparison must flag exactly that digest.
    const r = runCase({ id: 'S4 (negative control input)', chunks: chunkList(FIX.get('a_aac.ts')) });
    const tampered = JSON.parse(JSON.stringify((RECORD ? NEW_CASES : BASELINE_CASES)['S4']));
    tampered.evDigest = (tampered.evDigest[0] === '0' ? '1' : '0') + tampered.evDigest.slice(1);
    let msg = null;
    try {
        assertBaseline('negative (S4 vs tampered baseline)', r, tampered);
    } catch (e) {
        if (e instanceof ParityError) msg = e.message;
        else throw e;
    }
    if (msg === null) fail('negative control (S4 vs its own baseline with evDigest tampered in memory) did NOT diverge — the gate cannot fail');
    if (!/^negative \(S4 vs tampered baseline\): evDigest: run [0-9a-f]{16}… vs baseline [0-9a-f]{16}…$/.test(msg)) {
        fail(`negative control report malformed: ${msg}`);
    }
    pass(`negative control — baseline comparison flagged: ${msg}`);
}

// ---- 7. record / summary ----------------------------------------------------------------

if (RECORD) {
    reportBaselineDrift(BASELINE_FILE, OLD_BASELINE, NEW_CASES);
    const prov = baselineProvenance('harness/ts_demux', currentCommit());
    writeBaseline(BASELINE_FILE, prov, NEW_CASES);
    console.log(`demux_parity: recorded ${Object.keys(NEW_CASES).length} cases -> ${BASELINE_FILE}`);
    console.log(`  provenance: ${prov}`);
    process.exit(0);
}

console.log(
    `demux_parity: PASS — ${SRC.label} vs ${BASELINE_FILE}: ` +
    `${COUNTS.caseRuns} case runs (10 fixtures + 9 corruptions + 3 selection passes + 2 wall-clock + 1 negative), ` +
    `${COUNTS.baselineCases} cases matched the baseline, ` +
    `${COUNTS.events} events digested (${COUNTS.eventFields} canonical fields; ${COUNTS.streamCompares} pairs in recorded-stream checks), ` +
    `${COUNTS.snaps} debug snapshots (${COUNTS.snapFields} fields digested, ${COUNTS.wallClock} wall-clock values checked finite-only per §4.2), ` +
    `${COUNTS.meters} meter snapshots (${COUNTS.meterFields} fields digested)`,
);
process.exit(0);
