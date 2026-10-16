// Minimal main-thread player: mount the vendored WebSRT player SDK
// (page/vendor/) against the bundled receiver worker (page/bundle/worker.js,
// which runs the C++ wasm engine via js/srt_engine.js).
// host/port/stream/token come from ?host=&port=&stream=&token= URL params
// (reference-viewer behavior); defaults: page host + window.WT_PORT from
// cert-hash.js + stream "default". cert-hash.js is proxied by serve.mjs.
import { mountPlayer } from './vendor/player/index';

const canvas = document.querySelector('canvas')!;
const stats = document.querySelector('#stats')!;

// Hw/sw decode preference. The vendored VideoPipeline reads localStorage
// 'websrt-hw-mode' when it is built (main thread, at mount) and defaults to
// prefer-hardware, which throws OperationError on software-only machines.
// ?decode=software|hardware seeds the preference before mount; the button
// above the stats line flips it and reloads (simplest re-apply).
const decodeParam = new URLSearchParams(location.search).get('decode');
if (decodeParam === 'software' || decodeParam === 'hardware') {
    localStorage.setItem('websrt-hw-mode', decodeParam === 'software' ? 'prefer-software' : 'prefer-hardware');
}
const decodeBtn = document.createElement('button');
decodeBtn.textContent = `decode: ${localStorage.getItem('websrt-hw-mode') === 'prefer-software' ? 'sw' : 'hw'}`;
decodeBtn.addEventListener('click', () => {
    const sw = localStorage.getItem('websrt-hw-mode') === 'prefer-software';
    localStorage.setItem('websrt-hw-mode', sw ? 'prefer-hardware' : 'prefer-software');
    location.reload();
});
stats.before(decodeBtn);

const handle = mountPlayer(canvas, { workerUrl: '/bundle/worker.js' });

handle.addEventListener('error', (e) => {
    const msg = (e as CustomEvent<{ message?: string }>).detail?.message;
    console.error(`player error: ${msg ?? 'unknown'}`);
});
handle.addEventListener('stats', (e) => {
    // All 17 SrtwStats fields from the engine's getStats(), camelCase as
    // delivered by the worker's StatsMsg - one line per field in the
    // right-side overlay panel (label padded left, value right of it).
    const s = (e as CustomEvent<{ stats: {
        elapsedMs: number; rttMs: number; bandwidthBps: number;
        rxData: number; rxBytes: number; rxLoss: number; rxRetransmit: number;
        rxDropped: number; rxAck: number; rxNak: number; rxBuffered: number; rxBelated: number;
        txData: number; txBytes: number; txRetransmit: number; txLoss: number; txBuffered: number;
    } }>).detail.stats;
    const line = (label: string, value: string) => label.padEnd(13) + value;
    stats.textContent = [
        line('rtt', `${s.rttMs.toFixed(1)}ms`),
        line('bw', `${(s.bandwidthBps / 1e6).toFixed(1)}Mbps`),
        line('elapsed', `${(s.elapsedMs / 1000).toFixed(1)}s`),
        line('rxData', `${s.rxData} msg`),
        line('rxBytes', `${(s.rxBytes / 1e6).toFixed(1)}MB`),
        line('rxLoss', `${s.rxLoss}`),
        line('rxRetransmit', `${s.rxRetransmit}`),
        line('rxDropped', `${s.rxDropped}`),
        line('rxAck', `${s.rxAck}`),
        line('rxNak', `${s.rxNak}`),
        line('rxBuffered', `${s.rxBuffered}`),
        line('rxBelated', `${s.rxBelated}`),
        line('txData', `${s.txData} msg`),
        line('txBytes', `${(s.txBytes / 1e6).toFixed(1)}MB`),
        line('txLoss', `${s.txLoss}`),
        line('txRetransmit', `${s.txRetransmit}`),
        line('txBuffered', `${s.txBuffered}`),
    ].join('\n');
});
canvas.addEventListener('click', () => handle.setMuted(!handle.muted));

handle.connect();
