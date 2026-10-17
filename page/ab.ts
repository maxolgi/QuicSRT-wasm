// M4 A/B harness main thread: runs the Rust engine and the C++ engine side
// by side on the SAME live WebSRT stream, one dedicated module worker + one
// WebTransport session each (a single session cannot serve two subscribers:
// their SRT handshakes and ACKs would collide), then compares what each
// engine DELIVERED after TSBPD:
//
//   - per-engine table: duration, delivered msgs/bytes, SHA-256 of the
//     concatenated delivered payload, loss/drop totals, rtt min/median/max,
//     final rxBytes
//   - COMPARE verdict: full-run hash equal/differ + msg/byte deltas, plus
//     the aligned-window view - per-wall-second bucket digests compared over
//     seconds interior to BOTH engines (each engine's first/last active
//     second is excluded: session join/leave edges differ by construction).
//   - VERDICT line: the machine-readable decision on the same data
//     (computeVerdict: PASS / FAIL / NOT-EVALUABLE) - thresholds encode the
//     noise the docs call expected (README: "a single mismatched bucket",
//     small totals deltas), so a run is decided, not eyeballed. Full-run
//     hash equality is NOT a criterion (both engines join at independent
//     content offsets, so `hashes differ` is the normal clean outcome).
//   - "final stats" lines: each engine's FINAL full getStats() snapshot
//     (all 17 fields, raw values, fixed key order) so every bw/ack/nak/
//     buffered/belated/tx* field can be diffed Rust-vs-C++ directly, plus
//     a trailing outDropped token: the C++ shim's outgoing-ring drop count
//     (n/a for Rust, which has no ring) - handshake/ACK datagrams dropped
//     by a stalled drain are invisible in getStats.
//
// Two live sessions receive independent copies of the stream, so full-run
// hashes match only when both engines joined at the same content offset -
// on a clean loopback (zero loss both sides) the practical gates are the
// loss/drop totals and the aligned-bucket digests. URL params match the
// player: ?stream= (default "ab"), ?latency= (default 120), ?host=, ?port=
// (default window.WT_PORT from cert-hash.js, then 4433).

import type { AbFinal, AbWorkerMsg, StatsSample, Bucket } from './ab_worker';

type Engine = 'rust' | 'cpp';

// Same order as ab_worker's STATS_KEYS (both engines return exactly these
// keys) so the rust and cpp "final stats" lines align field-by-field.
const FINAL_STATS_KEYS = [
    'elapsedMs', 'rttMs', 'bandwidthBps',
    'rxData', 'rxBytes', 'rxLoss', 'rxRetransmit', 'rxDropped', 'rxBelated',
    'rxBuffered', 'rxAck', 'rxNak',
    'txData', 'txBytes', 'txRetransmit', 'txLoss', 'txBuffered',
];

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.replace(/[:\s]/g, '');
    if (clean.length !== 64) throw new Error(`expected 64 hex chars, got ${clean.length}`);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    return out;
}

function fmtBytes(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
    return `${n} B`;
}

function fmtMs(n: number | null): string {
    return n === null ? '-' : `${n.toFixed(1)} ms`;
}

interface EngineState {
    worker: Worker;
    state: string;
    live: string;
    final: AbFinal | null;
}

/** Bucket secs with a neighbour on both sides (edges excluded).
 *
 *  CAVEAT (gap propagation): a one-second gap - a second with no delivered
 *  messages, e.g. a mid-run stall - also removes BOTH of its neighbours
 *  from this set (each loses a neighbour), so one missing second silently
 *  drops three seconds from the bucket comparison. The full-run msgs-delta
 *  threshold in computeVerdict is the remaining backstop: a gap's missing
 *  messages still show up as a totals delta even though no bucket diff
 *  covers them. */
function interiorSecs(buckets: Bucket[]): Set<number> {
    const s = new Set(buckets.map((b) => b.sec));
    const out = new Set<number>();
    for (const sec of s) if (s.has(sec - 1) && s.has(sec + 1)) out.add(sec);
    return out;
}

// ---------------------------------------------------------------------------
// Machine-readable verdict: the thresholds below encode what the docs already
// call expected noise, so PASS/FAIL is decided by data, not by how lenient
// the reader of the COMPARE prose feels.
// ---------------------------------------------------------------------------

export type VerdictStatus = 'PASS' | 'FAIL' | 'NOT-EVALUABLE';

export interface AbVerdict {
    status: VerdictStatus;
    /** common interior seconds whose digests were compared. */
    bucketsCompared: number;
    /** of those, seconds whose digests differ. */
    bucketMismatches: number;
    mismatched: { sec: number; dMsgs: number }[];
    /** |a.msgs - b.msgs| over the full runs. */
    msgsDelta: number;
    /** |a.bytes - b.bytes| over the full runs. */
    bytesDelta: number;
    /** per-engine outgoing-ring drops; null = engine has no ring (n/a). */
    outDroppedA: number | null;
    outDroppedB: number | null;
    /** threshold violations when FAIL, or why the byte gate could not run
     *  when NOT-EVALUABLE; empty on PASS. */
    reasons: string[];
}

export const VERDICT_THRESHOLDS = {
    /** README: expected noise is "a single mismatched bucket" (a boundary
     *  packet released across a second edge in one engine only). */
    maxBucketMismatches: 1,
    /** below this many common interior seconds the byte gate cannot tell
     *  the one-bucket noise budget from real divergence - NOT-EVALUABLE,
     *  never a silent PASS. */
    minBucketsCompared: 3,
    /** full-run totals deltas: the clean-loopback reference run measured
     *  Δ20 msgs / ~20 kB (0.27%, 34/34 buckets exact), so allow the larger
     *  of these floors (short runs) or deltaRel of the smaller engine
     *  (rate-agnostic: ~7x the observed relative delta). */
    msgsDeltaFloor: 32,
    bytesDeltaFloor: 128 * 1024,
    deltaRel: 0.02,
    /** header of this file: on a clean loopback "the practical gates are
     *  the loss/drop totals and the aligned-bucket digests" - both zero. */
    maxLossTotal: 0,
    maxDropTotal: 0,
} as const;

/** Decide the A/B comparison from VERDICT_THRESHOLDS. Any threshold breach
 *  is FAIL even when the bucket gate itself could not run (too few common
 *  interior seconds); only a breach-free run that also lacks enough aligned
 *  seconds is NOT-EVALUABLE. outDropped null means the engine has no
 *  outgoing ring (rust) and never fails. */
export function computeVerdict(a: AbFinal, b: AbFinal): AbVerdict {
    const ia = interiorSecs(a.buckets);
    const ib = interiorSecs(b.buckets);
    const common = [...ia].filter((s) => ib.has(s)).sort((x, y) => x - y);
    const ma = new Map(a.buckets.map((x) => [x.sec, x]));
    const mb = new Map(b.buckets.map((x) => [x.sec, x]));
    const mismatched: { sec: number; dMsgs: number }[] = [];
    for (const sec of common) {
        if (ma.get(sec)!.sha256 !== mb.get(sec)!.sha256) {
            mismatched.push({ sec, dMsgs: ma.get(sec)!.msgs - mb.get(sec)!.msgs });
        }
    }
    const msgsDelta = Math.abs(a.msgs - b.msgs);
    const bytesDelta = Math.abs(a.bytes - b.bytes);
    const t = VERDICT_THRESHOLDS;
    const msgsMax = Math.max(t.msgsDeltaFloor, t.deltaRel * Math.min(a.msgs, b.msgs));
    const bytesMax = Math.max(t.bytesDeltaFloor, t.deltaRel * Math.min(a.bytes, b.bytes));
    const reasons: string[] = [];
    if (mismatched.length > t.maxBucketMismatches) {
        reasons.push(`${mismatched.length} mismatched aligned buckets (> ${t.maxBucketMismatches} expected noise)`);
    }
    if (msgsDelta > msgsMax) reasons.push(`msgs Δ${msgsDelta} > ${msgsMax.toFixed(0)}`);
    if (bytesDelta > bytesMax) reasons.push(`bytes Δ${fmtBytes(bytesDelta)} > ${fmtBytes(bytesMax)}`);
    if (a.lossTotal > t.maxLossTotal || b.lossTotal > t.maxLossTotal) {
        reasons.push(`rxLoss ${a.lossTotal}/${b.lossTotal}, expected 0`);
    }
    if (a.dropTotal > t.maxDropTotal || b.dropTotal > t.maxDropTotal) {
        reasons.push(`rxDropped ${a.dropTotal}/${b.dropTotal}, expected 0`);
    }
    if (a.outDropped !== null && a.outDropped > 0) reasons.push(`${a.engine} outDropped=${a.outDropped}`);
    if (b.outDropped !== null && b.outDropped > 0) reasons.push(`${b.engine} outDropped=${b.outDropped}`);
    let status: VerdictStatus;
    if (reasons.length > 0) {
        status = 'FAIL';
    } else if (common.length < t.minBucketsCompared) {
        status = 'NOT-EVALUABLE';
        reasons.push(`only ${common.length} common interior second${common.length === 1 ? '' : 's'} (need >= ${t.minBucketsCompared})`);
    } else {
        status = 'PASS';
    }
    return {
        status,
        bucketsCompared: common.length,
        bucketMismatches: mismatched.length,
        mismatched,
        msgsDelta,
        bytesDelta,
        outDroppedA: a.outDropped,
        outDroppedB: b.outDropped,
        reasons,
    };
}

export function compareVerdict(a: AbFinal, b: AbFinal): string {
    const v = computeVerdict(a, b);
    const parts: string[] = [];
    parts.push(a.sha256 === b.sha256 ? 'hashes EQUAL' : 'hashes differ');
    parts.push(`msgs Δ=${v.msgsDelta}`);
    parts.push(`bytes Δ=${fmtBytes(v.bytesDelta)}`);
    if (v.bucketsCompared > 0) {
        parts.push(`aligned buckets ${v.bucketsCompared - v.bucketMismatches}/${v.bucketsCompared}${v.mismatched.length > 0 ? ` mismatch ${v.mismatched.map((m) => `s${m.sec}(Δ${m.dMsgs}m)`).join(' ')}` : ''}`);
    } else {
        parts.push('aligned buckets n/a (no common interior seconds)');
    }
    return parts.join(' | ');
}

export function mountAbHarness(doc: Document = document): void {
    const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.querySelector<T>(`#${id}`)!;
    const startBtn = $('start');
    const stopBtn = $('stop');
    const cfg = $('cfg');
    const verdictEl = $('verdict');
    const finalStatsEl = $('finalstats');
    const table = $('results') as HTMLTableElement;

    const params = new URLSearchParams(doc.location.search);
    const stream = params.get('stream') ?? 'ab';
    const latencyMs = Math.max(10, +(params.get('latency') ?? 120) || 120);
    const certHex = (window as any).CERT_HASH as string | null | undefined;

    const pageHost = doc.location.hostname || '127.0.0.1';
    const wtHost = params.get('host') ?? (pageHost === 'localhost' ? '127.0.0.1' : pageHost);
    const wtPort = params.get('port') ?? (window as any).WT_PORT?.toString() ?? '4433';
    const url = `https://${wtHost}:${wtPort}/wt?stream=${encodeURIComponent(stream)}`;
    cfg.textContent = `${url} | latency ${latencyMs} ms | cert ${certHex ? `pinned ${certHex.slice(0, 8)}…` : 'PKI'}`;

    const engines = new Map<Engine, EngineState>();
    let running = false;

    function row(id: string, label: string): void {
        const tr = table.insertRow();
        tr.id = id;
        tr.innerHTML = `<th>${label}</th><td class="state"></td><td class="dur"></td><td class="msgs"></td><td class="bytes"></td><td class="hash"></td><td class="loss"></td><td class="rtt"></td><td class="rxbytes"></td>`;
    }
    if (!table.rows.length) {
        const head = table.createTHead().insertRow();
        head.innerHTML = '<th>engine</th><th>state</th><th>duration</th><th>msgs</th><th>bytes</th><th>sha256 (delivered)</th><th>loss/drop</th><th>rtt min/med/max</th><th>rxBytes final</th>';
        row('row-rust', 'Rust (srt-wasm)');
        row('row-cpp', 'C++ (srt-wasm-cpp)');
    }

    function cell(engine: Engine, cls: string): HTMLTableCellElement {
        return table.querySelector(`#row-${engine} .${cls}`)!;
    }

    function onMsg(engine: Engine, msg: AbWorkerMsg): void {
        const st = engines.get(engine)!;
        switch (msg.type) {
            case 'ready':
                st.state = 'engine loaded';
                break;
            case 'wtReady':
                st.state = 'wt ready';
                break;
            case 'handshakeComplete':
                st.state = 'srt handshake ✓';
                break;
            case 'log':
                st.live = msg.msg;
                break;
            case 'wtClosed':
                st.state = msg.error ? `wt closed (${msg.error})` : 'wt closed';
                break;
            case 'stats': {
                const s = msg.sample;
                st.state = 'live';
                st.live = `rtt ${s.rttMs.toFixed(1)} ms | delivered ${s.dMsgs} msg / ${fmtBytes(s.dBytes)} | loss ${s.rxLoss} drop ${s.rxDropped}`;
                break;
            }
            case 'final':
                st.final = msg.final;
                st.state = msg.final.error ? `final (error: ${msg.final.error})` : `final (${msg.final.reason})`;
                renderFinal(engine, msg.final);
                renderFinalStats();
                break;
        }
        cell(engine, 'state').textContent = st.state === 'live' ? `${st.state} — ${st.live}` : st.state;
    }

    function renderFinal(engine: Engine, f: AbFinal): void {
        cell(engine, 'dur').textContent = `${(f.durationMs / 1000).toFixed(1)} s`;
        cell(engine, 'msgs').textContent = `${f.msgs}`;
        cell(engine, 'bytes').textContent = fmtBytes(f.bytes);
        const hashCell = cell(engine, 'hash');
        hashCell.textContent = f.sha256.slice(0, 16) + '…';
        hashCell.title = f.sha256;
        cell(engine, 'loss').textContent = `${f.lossTotal} / ${f.dropTotal}`;
        cell(engine, 'rtt').textContent = `${fmtMs(f.rttMinMs)} / ${fmtMs(f.rttMedianMs)} / ${fmtMs(f.rttMaxMs)}`;
        cell(engine, 'rxbytes').textContent = fmtBytes(f.rxBytesFinal);
    }

    /** One monospace line per engine: the final full getStats(), raw values,
     *  plus the shim's outgoing-ring drop count (outDropped, cpp only). */
    function renderFinalStats(): void {
        const lines: string[] = [];
        for (const engine of ['rust', 'cpp'] as Engine[]) {
            const f = engines.get(engine)?.final;
            if (!f) continue; // engine has not finished yet
            const fs = f.finalStats;
            const body = fs
                ? FINAL_STATS_KEYS.map((k) => `${k}=${fs[k]}`).join(' ')
                : '(no stats sample)';
            lines.push(`${engine} final stats: ${body} outDropped=${f.outDropped === null ? 'n/a' : f.outDropped}`);
        }
        finalStatsEl.textContent = lines.join('\n');
    }

    function maybeVerdict(): void {
        const a = engines.get('rust')?.final;
        const b = engines.get('cpp')?.final;
        if (a && b) {
            const v = computeVerdict(a, b);
            verdictEl.className = v.status === 'FAIL' ? 'verdict-fail' : v.status === 'NOT-EVALUABLE' ? 'verdict-na' : '';
            verdictEl.textContent =
                `VERDICT: ${v.status}${v.reasons.length > 0 ? ` — ${v.reasons.join('; ')}` : ''}\n` +
                `COMPARE: ${compareVerdict(a, b)}`;
            running = false;
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    }

    startBtn.addEventListener('click', () => {
        if (running) return;
        running = true;
        verdictEl.textContent = 'running…';
        verdictEl.className = '';
        for (const st of engines.values()) st.worker.terminate(); // previous round
        engines.clear();
        finalStatsEl.textContent = '';
        for (const engine of ['rust', 'cpp'] as Engine[]) {
            for (const cls of ['dur', 'msgs', 'bytes', 'hash', 'loss', 'rtt', 'rxbytes']) {
                cell(engine, cls).textContent = '';
            }
            const worker = new Worker('/bundle/ab_worker.js', { type: 'module' });
            const st: EngineState = { worker, state: 'starting', live: '', final: null };
            engines.set(engine, st);
            worker.onmessage = (e: MessageEvent) => {
                onMsg(engine, e.data as AbWorkerMsg);
                maybeVerdict();
            };
            worker.onerror = (e) => {
                st.state = `worker error: ${e.message}`;
                cell(engine, 'state').textContent = st.state;
            };
            cell(engine, 'state').textContent = st.state;
            const certBytes = certHex ? hexToBytes(certHex) : null;
            worker.postMessage(
                { cmd: 'start', engine, url, certHash: certBytes, latencyMs, epoch: Date.now() },
                certBytes ? [certBytes.buffer as ArrayBuffer] : [],
            );
        }
        startBtn.disabled = true;
        stopBtn.disabled = false;
    });

    stopBtn.addEventListener('click', () => {
        for (const st of engines.values()) st.worker.postMessage({ cmd: 'stop' });
        // Engines free and reply 'final' on stop; terminate stragglers after 8 s.
        setTimeout(() => {
            for (const [engine, st] of engines) {
                if (!st.final) {
                    st.state = 'terminated (no final)';
                    cell(engine, 'state').textContent = st.state;
                    st.worker.terminate();
                }
            }
        }, 8000);
        stopBtn.disabled = true;
    });
}

if (typeof document !== 'undefined') {
    mountAbHarness(document);
}
