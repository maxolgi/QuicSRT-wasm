// Minimal main-thread player: mount the vendored WebSRT player SDK
// (page/vendor/) against the bundled receiver worker (page/bundle/worker.js,
// which runs the C++ wasm engine via js/srt_engine.js).
// host/port/stream/token come from ?host=&port=&stream=&token= URL params
// (reference-viewer behavior); defaults: page host + window.WT_PORT from
// cert-hash.js + stream "default". cert-hash.js is proxied by serve.mjs.
import { mountPlayer } from './vendor/player/index';

const canvas = document.querySelector('canvas')!;
const status = document.querySelector('#status')!;
const stats = document.querySelector('#stats')!;

const handle = mountPlayer(canvas, { workerUrl: '/bundle/worker.js' });

handle.addEventListener('statechange', () => { status.textContent = handle.state; });
handle.addEventListener('error', (e) => {
    const msg = (e as CustomEvent<{ message?: string }>).detail?.message;
    status.textContent = `error: ${msg ?? 'unknown'}`;
});
handle.addEventListener('stats', (e) => {
    const s = (e as CustomEvent<{ stats: { rttMs: number; rxData: number; rxBytes: number } }>).detail.stats;
    stats.textContent = `rtt ${s.rttMs.toFixed(1)} ms | rx ${s.rxData} msg / ${(s.rxBytes / 1e6).toFixed(1)} MB`;
});
canvas.addEventListener('click', () => handle.setMuted(!handle.muted));

handle.connect();
