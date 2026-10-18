// M7 muxer regression gate: the C++ muxer (harness/ts_muxer via
// build/srt_engine.mjs) vs the committed GOLDEN BASELINE
// js/fixtures/muxer.baseline.json. Contracts plan-notes/abi-census.md §2
// + plan-notes/publisher-surface.md §2 (historical).
//
// Provenance: the baseline was recorded from the C++ build at a commit
// where it was proven byte-identical to the Rust oracle over this exact
// corpus (see the provenance field in the baseline file). The recorded
// digests carry that parity forward - this gate is self-contained, it
// loads nothing outside the repo.
//
// 1. Deterministic SYNTHETIC elementary inputs - no ffmpeg, no wall
//    clock, no randomness beyond a seeded xorshift32 - drive ONE TsMuxer
//    per scenario through a scripted op timeline covering every public
//    method of the 12-method ABI (census §2): setVideoCodec,
//    setVideoEnabled, setAudioCodec, addAudioPid, setSparseEnabled,
//    setSparseThreshold, push_video, push_audio, push_pcm, push_pcm_pid,
//    poll, constructor. Corpus shape (scenarios V*/P*/S*/Q*/E*/C*):
//      - video sizes across every packetization boundary (single-PES,
//        multi-PES, exact-fit, 1-byte-stuff, AF-length-0, huge),
//        keyframe on/off (PAT/PMT rewrite cadence), dts<pts reorderings,
//        dts>pts, monotonic runs, codec strings av1/hevc/h264/unknown;
//      - Opus audio (0x7F 0xE0 AU-header path, never emits PSI), av-mix
//        (PCR on video pid only), video-disabled audio-only (PCR moves
//        to the audio pid, PAT/PMT still never emitted by push_audio);
//      - PCM: default stream, multi-pid addAudioPid configs incl. the
//        64-pid CakeMix layout (multi-packet PMT), per-pid CC, unknown
//        pid / opus-kind pid no-ops, channel counts 2/4/6/8, invalid
//        channel count (empty AES3 payload), clip values, the ±1e-6
//        silence boundary, odd sample counts, zero samples, a push big
//        enough to wrap the 16-bit audio PES_packet_length;
//      - sparse suppression around threshold boundaries (strict >:
//        exactly-at-threshold must NOT suppress), starve-then-burst,
//        the 10x PMT resend burst, PMT version_number wrap mod 32, CC
//        continuity across resume (the doc comments say "resets CC" -
//        STALE: the Rust tests assert CC CONTINUES, census §2 surprise 3;
//        this corpus pins the tested behavior), sparse-off default;
//      - the two unwrap_or(0) targeting quirks (push_pcm with no s302m
//        stream and push_audio with no Opus stream land on stream[0]'s
//        pid regardless of kind, native lib.rs:222-254);
//      - µs edge values: 0, negative (clamped), fractional (truncating
//        us->90k), huge (33-bit PTS mask wrap).
// 2. THE DRAIN SEQUENCE IS THE UNIT OF COMPARISON: poll() is scripted
//    at fixed points - after pushes, between config-only ops (empty
//    polls), twice in a row - and every poll's output must be
//    byte-identical to the recorded per-drain sha256 (plus structural
//    checks: whole 188-B packets, 0x47 sync every 188 bytes), with
//    per-scenario totals (bytes, packets, concatenated sha256) gating
//    the drain list for sanity. Integer/byte logic only - NO tolerance,
//    none ever.
// 3. Per-scenario structural asserts prove the corpus still exercises
//    what it claims (PAT/PMT iff keyframe video or the PCM PSI rules,
//    PCR pid placement, suppression actually suppressing) - guards
//    against corpus drift, not a second comparator.
// 4. Negative control: an honest scenario run compared against its own
//    baseline entry with ONE drain digest tampered in memory MUST
//    diverge, with a first-divergence style report.
//
// Usage:
//   node js/muxer_parity.mjs           gate vs the baseline (exit 0 = pass)
//   node js/muxer_parity.mjs --record  re-record the baseline from the
//                                      current build and print the drift
//                                      vs the existing file
//
// Exit 0 = pass; on divergence exit 1 with scenario id and the first
// mismatching count or drain digest.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineProvenance, currentCommit, loadBaseline, reportBaselineDrift, writeBaseline } from './baseline.js';

function fail(msg) {
    console.error(`muxer_parity: FAIL: ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`PASS: ${msg}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));

const RECORD = process.argv.slice(2).includes('--record');
for (const arg of process.argv.slice(2)) {
    if (arg !== '--record') fail(`unknown argument "${arg}" (usage: node js/muxer_parity.mjs [--record])`);
}

const COUNTS = {
    scenarios: 0, baselineCases: 0, ops: 0, polls: 0, emptyPolls: 0, pollBytes: 0, packets: 0,
};

// ---- deterministic synthetic inputs (no ffmpeg, no wall clock) -------------------

function makeRng(seed) {
    let s = seed >>> 0;
    if (s === 0) s = 0x9e3779b9;
    return () => {
        s ^= (s << 13) >>> 0; s ^= s >>> 17; s ^= (s << 5) >>> 0; // xorshift32
        return s >>> 0;
    };
}

// Video ES bytes: opaque to the muxer (it never parses NAL units), but
// sprinkle Annex-B start codes so the payloads look like the encoder
// output the real publisher feeds (stream-worker.ts:348-351).
function videoBytes(seed, len) {
    const rng = makeRng(seed);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = rng() & 0xff;
    if (len >= 4) {
        out[0] = 0x00; out[1] = 0x00; out[2] = 0x00; out[3] = 0x01;
    }
    return out;
}

function pcmSamples(seed, count, loud = true) {
    const rng = makeRng(seed);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = loud ? ((rng() / 4294967296) * 2 - 1) : 0;
    }
    return out;
}

const opusFrame = (seed, len) => videoBytes(seed, len); // opaque Opus packet

// ---- op vocabulary + executor ---------------------------------------------------
//
// ['svc',codec] ['sve',bool] ['sac',codec,ch] ['aap',pid,codec,ch]
// ['sse',bool] ['sst',ms] config ops (no output)
// ['pv',bytes,ptsUs,dtsUs,keyframe] ['pa',bytes,ptsUs]
// ['pp',f32,ptsUs] ['ppp',pid,f32,ptsUs] push ops
// ['poll'] drain - returns the compared bytes

function exec(m, op) {
    switch (op[0]) {
        case 'svc': m.setVideoCodec(op[1]); return null;
        case 'sve': m.setVideoEnabled(op[1]); return null;
        case 'sac': m.setAudioCodec(op[1], op[2]); return null;
        case 'aap': m.addAudioPid(op[1], op[2], op[3]); return null;
        case 'sse': m.setSparseEnabled(op[1]); return null;
        case 'sst': m.setSparseThreshold(op[1]); return null;
        case 'pv': m.push_video(op[1], op[2], op[3], op[4]); return null;
        case 'pa': m.push_audio(op[1], op[2]); return null;
        case 'pp': m.push_pcm(op[1], op[2]); return null;
        case 'ppp': m.push_pcm_pid(op[1], op[2], op[3]); return null;
        case 'poll': return m.poll();
        default: throw new Error(`muxer_parity: bad op "${op[0]}"`);
    }
}

// ---- TS structural helpers (corpus asserts; operate on one poll() output) --------

const PKT = 188;
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;

function* packets(out) {
    for (let o = 0; o + PKT <= out.length; o += PKT) yield out.subarray(o, o + PKT);
}
const pktPid = (p) => ((p[1] & 0x1f) << 8) | p[2];
function hasPid(out, pid) {
    for (const p of packets(out)) if (pktPid(p) === pid) return true;
    return false;
}
function pidPktCount(out, pid) {
    let n = 0;
    for (const p of packets(out)) if (pktPid(p) === pid) n++;
    return n;
}
function firstPusi(out, pid) {
    for (const p of packets(out)) if (pktPid(p) === pid && (p[1] & 0x40) !== 0) return p;
    return null;
}
// AF flags byte of a PUSI packet, null when it carries no adaptation field.
function pusiAfFlags(out, pid) {
    const p = firstPusi(out, pid);
    if (p === null) return null;
    const afc = (p[3] >> 4) & 0x03;
    return afc & 0b10 ? p[5] : null;
}
function ccSeq(out, pid) {
    const ccs = [];
    for (const p of packets(out)) if (pktPid(p) === pid) ccs.push(p[3] & 0x0f);
    return ccs;
}
// version_number of the last PMT PUSI packet in the output (section[5]
// = pkt[10] after pointer_field, 0xC1 | version<<1 - native lib.rs:402).
function lastPmtVersion(out) {
    let v = null;
    for (const p of packets(out)) {
        if (pktPid(p) === PMT_PID && (p[1] & 0x40) !== 0) v = (p[10] >> 1) & 0x1f;
    }
    return v;
}

function ck(scenario, what, cond, detail = '') {
    if (!cond) fail(`${scenario}: corpus assert failed: ${what}${detail ? ` (${detail})` : ''}`);
}

// ---- comparator -------------------------------------------------------------------

class ParityError extends Error {}

const sha = (u8) => createHash('sha256').update(u8).digest('hex');

function checkStructure(scenario, opIdx, pollIdx, out) {
    if (out.length % PKT !== 0) {
        throw new ParityError(`${scenario}: op #${opIdx} (poll #${pollIdx}): output ${out.length} B is not a whole number of 188-B packets`);
    }
    for (let o = 0; o < out.length; o += PKT) {
        if (out[o] !== 0x47) {
            throw new ParityError(`${scenario}: op #${opIdx} (poll #${pollIdx}): byte ${o} is 0x${out[o].toString(16)}, not the 0x47 sync byte`);
        }
    }
}

// First mismatch only: scenario id, the count or drain index, run value
// vs baseline (64-hex digests print as 16 chars + ellipsis).
function assertBaseline(scenarioId, r, entry) {
    for (const f of ['ops', 'drains', 'bytes', 'packets']) {
        if (r[f] !== entry[f]) {
            throw new ParityError(`${scenarioId}: ${f}: run ${r[f]} vs baseline ${entry[f]}`);
        }
    }
    for (let i = 0; i < r.drainDigests.length; i++) {
        if (r.drainDigests[i] !== entry.drainDigests[i]) {
            throw new ParityError(`${scenarioId}: drain #${i}: sha256 run ${r.drainDigests[i].slice(0, 16)}… vs baseline ${entry.drainDigests[i].slice(0, 16)}…`);
        }
    }
    if (r.totalSha256 !== entry.totalSha256) {
        throw new ParityError(`${scenarioId}: totalSha256: run ${r.totalSha256.slice(0, 16)}… vs baseline ${entry.totalSha256.slice(0, 16)}…`);
    }
}

// ---- runner ------------------------------------------------------------------------

// Drives one muxer over the op list; every 'poll' op is structure-checked
// and sha256-digested immediately (the drain sequence across the whole
// timeline is the unit of comparison).
function runScenario(spec) {
    const m = SRC.createMuxer();
    const polls = [];
    const drainDigests = [];
    const total = createHash('sha256');
    let bytes = 0;
    try {
        for (let i = 0; i < spec.ops.length; i++) {
            const op = spec.ops[i];
            const out = exec(m, op);
            COUNTS.ops++;
            if (op[0] !== 'poll') continue;
            const pollIdx = polls.length;
            checkStructure(spec.id, i, pollIdx, out);
            COUNTS.polls++;
            COUNTS.pollBytes += out.length;
            COUNTS.packets += out.length / PKT;
            if (out.length === 0) COUNTS.emptyPolls++;
            bytes += out.length;
            polls.push(out);
            drainDigests.push(sha(out));
            total.update(out);
        }
        if (spec.expect !== undefined) spec.expect({ id: spec.id, polls });
    } catch (e) {
        if (e instanceof ParityError) fail(`parity divergence — ${e.message}`);
        throw e;
    } finally {
        m.free();
        COUNTS.scenarios++;
    }
    return {
        id: spec.id, ops: spec.ops.length, drains: polls.length, bytes,
        packets: bytes / PKT, drainDigests, totalSha256: total.digest('hex'),
    };
}

// The per-scenario baseline entry: totals gate the drain list for sanity.
function baselineEntry(r) {
    return {
        ops: r.ops, drains: r.drains, bytes: r.bytes, packets: r.packets,
        drainDigests: r.drainDigests, totalSha256: r.totalSha256,
    };
}

// ---- the corpus --------------------------------------------------------------------

// Video PES packetization boundaries: first packet room is 184 - 8 (PCR
// on every video PES, video pid == pcr_pid) = 176, then 184 per packet;
// PES header is 14 B (pts) or 19 B (pts+dts). Sizes below pin every
// branch of packetize(): exact fit, 1-byte stuff, AF with length 0
// (chunk == payload_room - 1), multi-packet exact/stuffed tails.
const V_SIZES = [0, 1, 8, 161, 162, 163, 175, 176, 177, 183, 184, 185, 359, 360, 361, 3000, 8000];

function scenarioV1() {
    const ops = [
        ['poll'], // nothing pending yet
        ['pv', videoBytes(0x101, 500), 0, 0, true], ['poll'],
    ];
    let pts = 33333;
    for (const [i, size] of V_SIZES.entries()) {
        ops.push(['pv', videoBytes(0x200 + i, size), pts, pts, false]);
        ops.push(['poll']);
        pts += 33333;
    }
    ops.push(['poll']); // double poll: second must be empty
    return {
        id: 'V1 video-size sweep',
        note: 'kf PAT/PMT + PES, then one push per packetization boundary size, pts==dts monotonic',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll #0 empty', polls[0].length === 0);
            ck(this.id, 'poll #1 carries PAT+PMT+PES (keyframe)',
                hasPid(polls[1], PAT_PID) && hasPid(polls[1], PMT_PID) && hasPid(polls[1], 0x100));
            ck(this.id, 'final double poll empty', polls[polls.length - 1].length === 0);
            ck(this.id, 'PCR flag on video PUSI', (pusiAfFlags(polls[2], 0x100) & 0x10) !== 0);
        },
    };
}

function scenarioV2() {
    const ops = [];
    const kfSeq = [true, false, false, true, false, true, false, false];
    let pts = 0;
    for (const [i, kf] of kfSeq.entries()) {
        ops.push(['pv', videoBytes(0x300 + i, 300 + i * 37), pts, pts, kf]);
        ops.push(['poll']);
        pts += 40000;
    }
    return {
        id: 'V2 video keyframe cadence',
        note: 'PAT/PMT rewritten before the PES on EVERY keyframe, PES-only drains between',
        ops,
        expect({ polls }) {
            for (const [i, kf] of kfSeq.entries()) {
                const out = polls[i];
                ck(this.id, `poll ${i} ${kf ? 'has' : 'lacks'} PAT`, hasPid(out, PAT_PID) === kf);
                ck(this.id, `poll ${i} ${kf ? 'has' : 'lacks'} PMT`, hasPid(out, PMT_PID) === kf);
                ck(this.id, `poll ${i} has video PES`, hasPid(out, 0x100));
            }
        },
    };
}

function scenarioV3() {
    // B-frame reordering: pts leads dts by 2 frame intervals; one dts>pts
    // (invalid but tolerated) and fractional-µs truncation cases.
    const ops = [['pv', videoBytes(0x401, 700), 0, 0, true], ['poll']];
    const stamps = [
        [133332, 66666], [166665, 99999], [199998, 133332],
        [233331.9, 166665.4], [266664, 199998],
        [300000, 366666], // dts > pts (wrong order on purpose)
        [333333, 233332],
    ];
    for (const [i, [pts, dts]] of stamps.entries()) {
        ops.push(['pv', videoBytes(0x402 + i, 250 + i * 111), pts, dts, false]);
        ops.push(['poll']);
    }
    return {
        id: 'V3 video pts/dts patterns',
        note: 'dts<pts reorderings (PTS+DTS PES headers), one dts>pts, fractional µs truncation',
        ops,
    };
}

function scenarioV4() {
    const codecs = ['av1', 'hevc', 'nosuchcodec', 'h264'];
    const ops = [
        ['pv', videoBytes(0x501, 400), 0, 0, true], ['poll'], // default arm: H.264, no descriptor
    ];
    let pts = 100000;
    for (const [i, codec] of codecs.entries()) {
        ops.push(['svc', codec]);
        ops.push(['pv', videoBytes(0x502 + i, 400), pts, pts, true]);
        ops.push(['poll']); // PMT rewritten with the new stream type/descriptor
        ops.push(['pv', videoBytes(0x502 + i, 220), pts + 33333, pts + 33333, false]);
        ops.push(['poll']);
        pts += 100000;
    }
    return {
        id: 'V4 video codec strings',
        note: "setVideoCodec av1(0x06+AV01 desc)/hevc(0x24)/unknown→h264(0x1B) mid-stream PMT rewrites",
        ops,
    };
}

function scenarioV5() {
    const ops = [];
    let pts = 0;
    for (let i = 0; i < 8; i++) {
        ops.push(['pa', opusFrame(0x600 + i, 120 + i * 25), pts]);
        ops.push(['poll']);
        pts += 20000;
    }
    return {
        id: 'V5 opus audio (video clock)',
        note: 'push_audio prepends the 0x7F 0xE0 AU header and NEVER emits PSI; PCR stays on the video pid',
        ops,
        expect({ polls }) {
            for (const [i, out] of polls.entries()) {
                ck(this.id, `poll ${i} has audio PES`, hasPid(out, 0x101));
                ck(this.id, `poll ${i} has no PAT`, !hasPid(out, PAT_PID), 'push_audio must not emit PSI');
                const flags = pusiAfFlags(out, 0x101);
                ck(this.id, `poll ${i} audio PUSI has no PCR`, flags === null || (flags & 0x10) === 0,
                    'video enabled => pcr_pid is 0x100');
            }
        },
    };
}

function scenarioV6() {
    const ops = [['pv', videoBytes(0x701, 1200), 0, 0, true], ['poll']];
    let pts = 0;
    for (let v = 1; v <= 3; v++) {
        pts = v * 100000;
        for (let i = 0; i < 5; i++) { // 5 audio frames per video frame
            ops.push(['pa', opusFrame(0x710 + v * 8 + i, 160 + i * 10), pts - 100000 + i * 20000]);
            ops.push(['poll']);
        }
        ops.push(['pv', videoBytes(0x702 + v, 900 + v * 100), pts, pts, v === 2]);
        ops.push(['poll']);
    }
    return {
        id: 'V6 av mix',
        note: 'kf video + interleaved opus; PAT only in kf drains, PCR on video PUSI only',
        ops,
        expect({ polls }) {
            // poll 0 = kf video; then per video frame: 5 audio polls + 1 video
            // poll (only v==2's video push is a keyframe).
            ck(this.id, 'poll 0 (kf) has PAT', hasPid(polls[0], PAT_PID));
            for (let v = 1; v <= 3; v++) {
                for (let i = 0; i < 5; i++) {
                    const out = polls[(v - 1) * 6 + 1 + i];
                    ck(this.id, `v${v} audio poll ${i} has audio PES`, hasPid(out, 0x101));
                    ck(this.id, `v${v} audio poll ${i} has no PAT`, !hasPid(out, PAT_PID));
                    const flags = pusiAfFlags(out, 0x101);
                    ck(this.id, `v${v} audio poll ${i} no PCR`, flags === null || (flags & 0x10) === 0);
                }
                const vout = polls[v * 6];
                ck(this.id, `v${v} video drain has video PES`, hasPid(vout, 0x100));
                ck(this.id, `v${v} video drain PAT ${v === 2 ? 'present' : 'absent'}`,
                    hasPid(vout, PAT_PID) === (v === 2));
                ck(this.id, `v${v} video PUSI has PCR`, (pusiAfFlags(vout, 0x100) & 0x10) !== 0);
            }
        },
    };
}

function scenarioV7() {
    const ops = [
        ['sve', false], ['poll'],
        ['pa', opusFrame(0x801, 200), 0], ['poll'],
        ['pa', opusFrame(0x802, 333), 20000], ['poll'],
        ['pv', videoBytes(0x803, 500), 40000, 40000, true], ['poll'], // ignored: video disabled
        ['pa', opusFrame(0x804, 150), 60000], ['poll'],
    ];
    return {
        id: 'V7 audio-only, video disabled',
        note: 'pcr_pid moves to 0x101 (audio PES carries PCR); push_video ignored; still zero PSI ever',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 0 empty', polls[0].length === 0);
            for (const [i, out] of polls.entries()) {
                ck(this.id, `poll ${i} has no PAT`, !hasPid(out, PAT_PID), 'Opus-only streams emit no PSI at all');
                ck(this.id, `poll ${i} has no PMT`, !hasPid(out, PMT_PID));
            }
            ck(this.id, 'poll 3 (push_video while disabled) empty', polls[3].length === 0);
            ck(this.id, 'poll 1 audio PUSI carries PCR', (pusiAfFlags(polls[1], 0x101) & 0x10) !== 0,
                'video disabled => pcr_pid is the first audio pid');
        },
    };
}

function scenarioP1() {
    const ops = [
        ['sve', false], ['sac', 's302m', 2],
        ['pp', pcmSamples(0x901, 960), 0], ['poll'], // first-ever pcm push: PAT+PMT+PES
    ];
    let pts = 20000;
    for (let i = 0; i < 5; i++) {
        ops.push(['pp', pcmSamples(0x902 + i, i % 2 ? 480 : 960), pts]);
        ops.push(['poll']);
        pts += 20000;
    }
    return {
        id: 'P1 pcm basics',
        note: 'first push_pcm emits PAT+PMT before the PES; later pushes PES only (20 ms frames)',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 0 has PAT+PMT+PES',
                hasPid(polls[0], PAT_PID) && hasPid(polls[0], PMT_PID) && hasPid(polls[0], 0x101));
            ck(this.id, 'poll 1 PES only',
                hasPid(polls[1], 0x101) && !hasPid(polls[1], PAT_PID) && !hasPid(polls[1], PMT_PID));
        },
    };
}

function scenarioP2() {
    const ops = [['sve', false], ['sac', 's302m', 2]];
    let pts = 0;
    for (let i = 0; i < 26; i++) {
        ops.push(['pp', pcmSamples(0x940 + (i % 3), 1920), pts]); // 20 ms stereo @48k
        ops.push(['poll']);
        pts += 20000;
    }
    return {
        id: 'P2 pcm periodic PSI',
        note: 'periodic PAT/PMT when pts_90k - last_psi >= 9000 ticks (100 ms): every 5th push',
        ops,
        expect({ polls }) {
            for (const [i, out] of polls.entries()) {
                const psi = hasPid(out, PMT_PID);
                ck(this.id, `poll ${i} PSI=${psi}`, psi === (i % 5 === 0),
                    'expected PSI at pushes 0,5,10,15,20,25 and only there');
            }
        },
    };
}

function scenarioP3() {
    const ops = [
        ['sve', false], ['sac', 's302m', 2],
        ['aap', 0x102, 's302m', 6], ['aap', 0x103, 's302m', 8], ['aap', 0x104, 'opus', 2],
        ['pp', pcmSamples(0x960, 960), 0], ['poll'], // -> 0x101 (first s302m)
        ['ppp', 0x102, pcmSamples(0x961, 960), 20000], ['poll'], // -> 0x102, 6ch frame
        ['ppp', 0x103, pcmSamples(0x962, 960), 40000], ['poll'], // -> 0x103, 8ch
        ['ppp', 0x104, pcmSamples(0x963, 960), 60000], ['poll'], // opus-kind pid: NO-OP
        ['ppp', 0x999, pcmSamples(0x964, 960), 80000], ['poll'], // unknown pid: NO-OP
        ['pp', pcmSamples(0x965, 480), 100000], ['poll'], // back to 0x101, own CC
    ];
    return {
        id: 'P3 pcm multi-pid',
        note: 'push_pcm_pid targets registered s302m pids with independent CC; unknown/opus pids are no-ops',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 0 lands on 0x101', hasPid(polls[0], 0x101) && !hasPid(polls[0], 0x102));
            ck(this.id, 'poll 1 lands on 0x102', hasPid(polls[1], 0x102) && !hasPid(polls[1], 0x101));
            ck(this.id, 'poll 2 lands on 0x103', hasPid(polls[2], 0x103));
            ck(this.id, 'poll 3 (opus pid) empty', polls[3].length === 0, 'non-s302m pid must emit nothing');
            ck(this.id, 'poll 4 (unknown pid) empty', polls[4].length === 0, 'unknown pid must emit nothing');
            ck(this.id, 'poll 5 back on 0x101', hasPid(polls[5], 0x101));
        },
    };
}

function scenarioP4() {
    const ops = [['sve', false], ['sac', 's302m', 2]];
    for (let pid = 0x102; pid <= 0x140; pid++) ops.push(['aap', pid, 's302m', 2]);
    ops.push(['pp', pcmSamples(0x980, 4), 0]); // CakeMix 64-stream layout: PMT spans packets
    ops.push(['poll']);
    ops.push(['ppp', 0x140, pcmSamples(0x981, 480), 20000], ['poll']);
    ops.push(['ppp', 0x102, pcmSamples(0x982, 480), 40000], ['poll']);
    ops.push(['pp', pcmSamples(0x983, 480), 60000], ['poll']);
    return {
        id: 'P4 pcm 64 audio pids',
        note: 'the CakeMix 64x s302m layout: multi-packet PMT (PSI continuation packets + 0xFF tail stuffing)',
        ops,
        expect({ polls }) {
            const pmtPkts = pidPktCount(polls[0], PMT_PID);
            ck(this.id, 'multi-packet PMT', pmtPkts >= 4, `got ${pmtPkts}`);
            const ccs = ccSeq(polls[0], PMT_PID);
            for (const [i, cc] of ccs.entries()) {
                ck(this.id, `PMT CC ${i} increments`, cc === (i & 0x0f));
            }
        },
    };
}

function scenarioP5() {
    const ops = [['sve', false], ['sac', 's302m', 2]];
    const chans = [[0x102, 4], [0x103, 6], [0x104, 8]];
    ops.push(['aap', 0x102, 's302m', 4], ['aap', 0x103, 's302m', 6], ['aap', 0x104, 's302m', 8]);
    let pts = 0;
    ops.push(['pp', pcmSamples(0x9a0, 960), pts], ['poll']); pts += 20000; // 2ch
    for (const [i, [pid]] of chans.entries()) {
        ops.push(['ppp', pid, pcmSamples(0x9a1 + i, 960), pts], ['poll']);
        pts += 20000;
    }
    ops.push(['pp', pcmSamples(0x9a5, 1920), pts], ['poll']);
    return {
        id: 'P5 pcm channel counts',
        note: 'AES3 wrapping at 2/4/6/8 channels (ch_idx header field + frame pacing)',
        ops,
        expect({ polls }) {
            for (let i = 0; i < 4; i++) ck(this.id, `poll ${i} non-empty`, polls[i].length > 0);
        },
    };
}

function scenarioS1() {
    // 1920 stereo samples = 20.0 ms exactly; threshold 40.0 ms pins the
    // STRICT > boundary: silence_ms == threshold must NOT suppress.
    const ops = [
        ['sve', false], ['sac', 's302m', 2], ['sse', true], ['sst', 40.0],
        ['pp', pcmSamples(0x9c0, 1920), 0], ['poll'], // loud: PAT+PMT+PES, version 0
        ['pp', pcmSamples(0, 1920, false), 20000], ['poll'], // silence 20ms: PES still
        ['pp', pcmSamples(0, 1920, false), 40000], ['poll'], // silence 40ms == threshold: STILL PES
        ['pp', pcmSamples(0, 1920, false), 60000], ['poll'], // silence 60ms > 40: suppress (v1 + burst)
        ['pp', pcmSamples(0, 1920, false), 80000], ['poll'], // suppressed: resend tail, no PES
        ['pp', pcmSamples(0x9c1, 1920), 100000], ['poll'], // loud: resume (v2 + burst + PES)
    ];
    return {
        id: 'S1 sparse threshold boundary',
        note: 'strict > at exactly-threshold (no suppress), suppress at 60>40, PMT rewrites + resend burst, resume',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 0 version 0', lastPmtVersion(polls[0]) === 0);
            ck(this.id, 'poll 1 loud PES', hasPid(polls[1], 0x101));
            ck(this.id, 'poll 2 at-threshold still PES (strict >)', hasPid(polls[2], 0x101),
                'silence_ms == threshold must not suppress');
            ck(this.id, 'poll 2 at-threshold: no PMT rewrite (strict >)',
                lastPmtVersion(polls[2]) === null && hasPid(polls[2], 0x101));
            ck(this.id, 'poll 3 suppressed: no PES', !hasPid(polls[3], 0x101));
            ck(this.id, 'poll 3 version 1 (drop)', lastPmtVersion(polls[3]) === 1);
            ck(this.id, 'poll 3 resend burst (dirty write + first resend)',
                pidPktCount(polls[3], PMT_PID) >= 2);
            ck(this.id, 'poll 4 suppressed: no PES', !hasPid(polls[4], 0x101));
            ck(this.id, 'poll 5 resumed: PES', hasPid(polls[5], 0x101));
            ck(this.id, 'poll 5 version 2 (re-add)', lastPmtVersion(polls[5]) === 2);
        },
    };
}

function scenarioS2() {
    const ops = [['sve', false], ['sac', 's302m', 2], ['sse', true], ['sst', 0.1]];
    let pts = 0;
    // 20 cycles x (suppress, 2 silent, resume-loud, 2 loud) = 2 version
    // bumps per cycle => version 40 & 0x1F == 8 after the wrap.
    for (let c = 0; c < 20; c++) {
        ops.push(['pp', pcmSamples(0, 1920, false), pts], ['poll']); pts += 20000; // suppress
        ops.push(['pp', pcmSamples(0, 1920, false), pts], ['poll']); pts += 20000;
        ops.push(['pp', pcmSamples(0, 1920, false), pts], ['poll']); pts += 20000;
        ops.push(['pp', pcmSamples(0x9d0 + c, 1920), pts], ['poll']); pts += 20000; // resume
        ops.push(['pp', pcmSamples(0x9d0 + c, 1920), pts], ['poll']); pts += 20000;
        ops.push(['pp', pcmSamples(0x9d0 + c, 1920), pts], ['poll']); pts += 20000;
    }
    return {
        id: 'S2 sparse version wrap',
        note: '40 PMT version_number bumps: 5-bit wrap mod 32 lands on 8',
        ops,
        expect({ polls }) {
            const last = polls[polls.length - 1];
            ck(this.id, 'final version == 8 (40 & 31)', lastPmtVersion(last) === 8,
                `got ${lastPmtVersion(last)}`);
            ck(this.id, 'final loud PES present', hasPid(last, 0x101));
        },
    };
}

function scenarioS3() {
    // Mirrors the oracle test sparse_resume_keeps_cc_continuous
    // (native lib.rs:910-948): CC CONTINUES mod 16 across suppression -
    // the "resets CC on resume" doc comments are stale (census surprise 3).
    const ops = [
        ['sve', false], ['sac', 's302m', 2], ['sse', true], ['sst', 0.1],
        ['pp', pcmSamples(0x9e0, 480), 0], ['poll'], // loud 10ms frame: CC 0..9
        ['pp', pcmSamples(0, 480, false), 0], ['poll'], // 10ms > 0.1: suppress
        ['pp', pcmSamples(0, 480, false), 0], ['poll'],
        ['pp', pcmSamples(0, 480, false), 0], ['poll'],
        ['pp', pcmSamples(0x9e1, 480), 0], ['poll'], // resume: CC must be 10..
    ];
    return {
        id: 'S3 sparse CC continuity',
        note: 'CC continues mod 16 across suppression+resume (doc comments stale, tests win)',
        ops,
        expect({ polls }) {
            const pre = ccSeq(polls[0], 0x101);
            ck(this.id, 'pre-suppression CC 0..9', pre.length === 10 && pre.every((cc, i) => cc === i),
                `got [${pre}]`);
            ck(this.id, 'suppressed polls carry no PES',
                [1, 2, 3].every((i) => !hasPid(polls[i], 0x101)));
            const post = ccSeq(polls[4], 0x101);
            ck(this.id, 'resume PES present', post.length === 10);
            ck(this.id, 'resume CC continues at 10',
                post.every((cc, i) => cc === ((10 + i) & 0x0f)), `got [${post}]`);
        },
    };
}

function scenarioS4() {
    const ops = [['sve', false], ['sac', 's302m', 2]];
    let pts = 0;
    for (let i = 0; i < 30; i++) { // sparse never enabled: default off
        ops.push(['pp', pcmSamples(0, 1920, false), pts]);
        ops.push(['poll']);
        pts += 20000;
    }
    return {
        id: 'S4 sparse off (default)',
        note: 'sustained silence still PES-es; only the periodic 100 ms PSI interleaves',
        ops,
        expect({ polls }) {
            for (const [i, out] of polls.entries()) {
                ck(this.id, `poll ${i} silent PES present`, hasPid(out, 0x101), 'sparse is off');
                ck(this.id, `poll ${i} PSI=${hasPid(out, PMT_PID)}`, hasPid(out, PMT_PID) === (i % 5 === 0));
            }
        },
    };
}

function scenarioQ1() {
    const ops = [
        ['sve', false], ['sac', 's302m', 2], ['aap', 0x102, 's302m', 2],
        ['pa', opusFrame(0x9f0, 180), 0], ['poll'], // NO Opus stream: idx unwrap_or(0) -> 0x101 (s302m!)
        ['pa', opusFrame(0x9f1, 90), 20000], ['poll'],
    ];
    return {
        id: 'Q1 push_audio without an Opus stream',
        note: 'unwrap_or(0) quirk: lands on stream[0] (the s302m pid 0x101) with the 0x7F 0xE0 header anyway',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 0 PES on 0x101 despite no Opus stream', hasPid(polls[0], 0x101));
        },
    };
}

function scenarioQ2() {
    const ops = [
        ['pv', videoBytes(0x5a1, 600), 0, 0, true], ['poll'],
        ['pp', pcmSamples(0x5a2, 960), 40000], ['poll'], // NO s302m stream: idx unwrap_or(0) -> 0x101 (Opus pid)
    ];
    return {
        id: 'Q2 push_pcm without an s302m stream',
        note: 'unwrap_or(0) quirk: AES3 payload lands on the Opus pid 0x101',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 1 PES on 0x101 despite no s302m stream', hasPid(polls[1], 0x101));
        },
    };
}

function scenarioE1() {
    const clips = new Float32Array([2.0, -2.0, 10.0, -10.0, 0.99999994, 1.0, -1.0]);
    const boundary = new Float32Array([1e-6, -1e-6, 1.0000001e-6, -1.0000001e-6, 0, 0]);
    const odd = new Float32Array([0.5]); // 1 sample: 0 pairs -> AES3 header only
    const none = new Float32Array(0);
    const huge = pcmSamples(0x5b0, 18858); // 9429 pairs x7 +4 = 66007 B payload:
    //   3+5+66007 wraps the 16-bit audio PES_packet_length (release build
    //   has no debug_assert) - the port must wrap identically.
    const ops = [
        ['sve', false], ['sac', 's302m', 2],
        ['pp', clips, 0], ['poll'],
        ['pp', boundary, 20000], ['poll'],
        ['pp', odd, 40000], ['poll'],
        ['pp', none, 60000], ['poll'],
        ['pp', huge, 80000], ['poll'],
        ['sac', 's302m', 1], // invalid channel count: wrap returns EMPTY payload
        ['pp', pcmSamples(0x5b1, 480), 100000], ['poll'],
    ];
    return {
        id: 'E1 pcm edge samples',
        note: 'clip values, ±1e-6 silence boundary, odd count, zero samples, PES_packet_length u16 wrap, invalid ch',
        ops,
    };
}

function scenarioE2() {
    const ops = [
        ['pv', videoBytes(0x5c1, 400), 0, 0, true], ['poll'],
        ['pv', videoBytes(0x5c2, 300), -5000, -5000, false], ['poll'], // negative us clamps to 0
        ['pv', videoBytes(0x5c3, 300), 33333.9, 33333.9, false], ['poll'], // truncation
        ['pv', videoBytes(0x5c4, 300), 1e15, 1e15, false], ['poll'], // 33-bit PTS mask wrap
        ['pv', videoBytes(0x5c5, 300), 0.5, 0, false], ['poll'],
        ['sve', false], ['sac', 's302m', 2],
        ['pp', pcmSamples(0x5c6, 480), -1], ['poll'], // negative pcm pts -> 0
        ['pp', pcmSamples(0x5c7, 480), 1e15], ['poll'],
    ];
    return {
        id: 'E2 µs edge values',
        note: 'max(us,0) clamp, ×9/100 truncation, 33-bit PTS masking on huge values',
        ops,
    };
}

function scenarioC1() {
    const ops = [
        ['poll'], // nothing pending
        ['svc', 'av1'], ['poll'], // config-only ops emit nothing
        ['sst', 100.0], ['sse', true], ['poll'],
        ['pv', videoBytes(0x5d1, 900), 0, 0, true], ['poll'],
        ['poll'], // just drained: empty
        ['pa', opusFrame(0x5d2, 200), 33333], ['poll'],
        ['poll'],
    ];
    return {
        id: 'C1 poll cadence',
        note: 'empty polls at scripted points (before anything, after config ops, double drains)',
        ops,
        expect({ polls }) {
            ck(this.id, 'poll 0 empty', polls[0].length === 0);
            ck(this.id, 'config-op polls empty', polls[1].length === 0 && polls[2].length === 0);
            ck(this.id, 'post-drain poll empty', polls[4].length === 0 && polls[6].length === 0);
            ck(this.id, 'kf poll non-empty', polls[3].length > 0);
            ck(this.id, 'audio poll non-empty', polls[5].length > 0);
        },
    };
}

const SCENARIOS = [
    scenarioV1(), scenarioV2(), scenarioV3(), scenarioV4(),
    scenarioV5(), scenarioV6(), scenarioV7(),
    scenarioP1(), scenarioP2(), scenarioP3(), scenarioP4(), scenarioP5(),
    scenarioS1(), scenarioS2(), scenarioS3(), scenarioS4(),
    scenarioQ1(), scenarioQ2(),
    scenarioE1(), scenarioE2(),
    scenarioC1(),
];

// ---- source + baseline ==============================================================
//
// The ONLY implementation this gate loads: the C++ muxer (harness/ts_muxer)
// exported from the engine module and wrapped by js/muxer_engine.js into
// the wasm-bindgen surface the executor consumes (new TsMuxer / the 12
// public methods / free). The golden baseline IS the oracle - nothing
// outside this repo is read.

async function loadSource() {
    const engine = await import('./muxer_engine.js');
    await engine.default(); // loads build/srt_engine.mjs (built by ./build.sh engine)
    return {
        label: 'cpp:srt_engine.mjs (harness/ts_muxer)',
        createMuxer: () => new engine.TsMuxer(),
    };
}

const SRC = await loadSource();
pass(`source = ${SRC.label}`);

const BASELINE_FILE = join(HERE, 'fixtures/muxer.baseline.json');
const OLD_BASELINE = loadBaseline(BASELINE_FILE);
if (!RECORD && OLD_BASELINE === null) {
    fail(`no baseline at ${BASELINE_FILE} - record one first (node js/muxer_parity.mjs --record)`);
}
if (OLD_BASELINE !== null && (typeof OLD_BASELINE.cases !== 'object' || OLD_BASELINE.cases === null)) {
    fail(`${BASELINE_FILE}: malformed baseline (no cases object) - re-record with --record`);
}
const BASELINE_CASES = RECORD ? {} : OLD_BASELINE.cases;
const NEW_CASES = RECORD ? {} : null;
if (!RECORD) pass(`baseline = ${BASELINE_FILE} (${OLD_BASELINE.provenance})`);

// ---- run the corpus -----------------------------------------------------------------

for (const spec of SCENARIOS) {
    const r = runScenario(spec);
    pass(`${r.id} — ${r.ops} ops, ${r.drains} drains, ${r.bytes.toLocaleString('en-US')} B (${spec.note})`);
    if (RECORD) {
        NEW_CASES[spec.id] = baselineEntry(r);
        continue;
    }
    const entry = BASELINE_CASES[spec.id];
    if (entry === undefined) fail(`baseline has no entry for "${spec.id}" (stale baseline? re-record with --record)`);
    try {
        assertBaseline(spec.id, r, entry);
    } catch (e) {
        if (e instanceof ParityError) fail(`baseline divergence — ${e.message}`);
        throw e;
    }
    COUNTS.baselineCases++;
}

// ---- negative control (the gate must be able to FAIL) ---------------------------------

{
    // Honest C1 run vs its own baseline entry with ONE drain digest
    // tampered in memory: the comparison must flag exactly that drain.
    const r = runScenario(scenarioC1());
    const tampered = JSON.parse(JSON.stringify((RECORD ? NEW_CASES : BASELINE_CASES)['C1 poll cadence']));
    const k = tampered.drainDigests.length - 1;
    tampered.drainDigests[k] = (tampered.drainDigests[k][0] === '0' ? '1' : '0') + tampered.drainDigests[k].slice(1);
    let msg = null;
    try {
        assertBaseline('negative (C1 vs tampered baseline)', r, tampered);
    } catch (e) {
        if (e instanceof ParityError) msg = e.message;
        else throw e;
    }
    if (msg === null) fail('negative control (C1 vs its own baseline with one drain digest tampered in memory) did NOT diverge — the gate cannot fail');
    if (!/^negative \(C1 vs tampered baseline\): drain #\d+: sha256 run [0-9a-f]{16}… vs baseline [0-9a-f]{16}…$/.test(msg)) {
        fail(`negative control report malformed: ${msg}`);
    }
    pass(`negative control — baseline comparison flagged: ${msg}`);
}

// ---- record / summary -------------------------------------------------------------------

if (RECORD) {
    reportBaselineDrift(BASELINE_FILE, OLD_BASELINE, NEW_CASES);
    const prov = baselineProvenance('harness/ts_muxer', currentCommit());
    writeBaseline(BASELINE_FILE, prov, NEW_CASES);
    console.log(`muxer_parity: recorded ${Object.keys(NEW_CASES).length} scenarios -> ${BASELINE_FILE}`);
    console.log(`  provenance: ${prov}`);
    process.exit(0);
}

console.log(
    `muxer_parity: PASS — ${SRC.label} vs ${BASELINE_FILE}: ` +
    `${COUNTS.scenarios} scenario runs (${SCENARIOS.length} corpus + 1 negative), ` +
    `${COUNTS.baselineCases} scenarios matched the baseline, ${COUNTS.ops} ops, ` +
    `${COUNTS.polls} poll drains (${COUNTS.emptyPolls} empty), ` +
    `${COUNTS.pollBytes.toLocaleString('en-US')} B in ${COUNTS.packets.toLocaleString('en-US')} TS packets ` +
    `byte-identical to the recorded per-drain sha256s`,
);
process.exit(0);
