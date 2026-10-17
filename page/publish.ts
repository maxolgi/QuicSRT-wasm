// M6 publisher page main thread: drives the vendored WebSRT publisher worker
// (page/bundle/publish_worker.js, built from page/vendor/stream-worker.ts -
// WebCodecs encode + Rust TS mux in the worker, the C++ wasm engine behind
// js/srt_engine.js as the SRT layer) through its postMessage protocol,
// mirroring WebSRT's publish UI (web/src/stream.tsx @ 854c25c). Deltas vs
// that UI are deliberate and listed in page/README.md: webcam-only
// getUserMedia capture (no screen capture / tab audio / camera picker), a
// ?source=canvas hardware-free test-source mode (README), a plain <pre>
// log instead of the preact debug panel, no stream-back player
// (the viewer link points at the M3 player), and a publish URL input
// (wt://host:port shorthand, default the local websrt-cpp gateway) instead
// of ?host=/?port=/window.WT_PORT resolution. cert-hash.js is proxied by
// serve.mjs; window.CERT_HASH pins the WT session exactly as in WebSRT
// (null hash = PKI mode, no pinning).
import type { PublishCmd, PublishMsg, EncodeStats } from './vendor/stream-worker';
import type { StatsMsg } from './vendor/worker';
import {
    CODEC_CANDIDATES,
    detectCodec,
    AudioGraphManager,
    FramePump,
    formatPubStats,
    hexToBytes,
} from './vendor/shared/publish';

const previewEl = document.querySelector<HTMLVideoElement>('#preview')!;
const captureBtn = document.querySelector<HTMLButtonElement>('#capture-btn')!;
const publishBtn = document.querySelector<HTMLButtonElement>('#publish-btn')!;
const stopBtn = document.querySelector<HTMLButtonElement>('#stop-btn')!;
const pubUrlInput = document.querySelector<HTMLInputElement>('#pub-url')!;
const streamNameInput = document.querySelector<HTMLInputElement>('#stream-name')!;
const latencyNum = document.querySelector<HTMLInputElement>('#latency-num')!;
const codecSelect = document.querySelector<HTMLSelectElement>('#codec-select')!;
const bitrateNum = document.querySelector<HTMLInputElement>('#bitrate-num')!;
const framerateSelect = document.querySelector<HTMLSelectElement>('#framerate-select')!;
const audioSourceSelect = document.querySelector<HTMLSelectElement>('#audio-source')!;
const viewerLink = document.querySelector<HTMLAnchorElement>('#viewer-link')!;
const statusText = document.querySelector<HTMLDivElement>('#status')!;
const pubStatsText = document.querySelector<HTMLDivElement>('#pub-stats')!;
const logPre = document.querySelector<HTMLPreElement>('#log')!;

function log(msg: string, cls = ''): void {
    const line = document.createElement('span');
    line.textContent = `${msg}\n`;
    if (cls) line.className = cls;
    logPre.appendChild(line);
    logPre.scrollTop = logPre.scrollHeight;
}

function setStatus(s: string): void {
    statusText.textContent = s;
}

// ─── State ────────────────────────────────────────────────────────

let worker: Worker | null = null;
let captureStream: MediaStream | null = null;
let publishing = false;
let capturing = false;
let detectedCodec: string | null = null;

const audio = new AudioGraphManager((msg) => log(msg, 'err'));

const framePump = new FramePump({
    getPreviewEl: () => previewEl,
    isPublishing: () => publishing && worker !== null,
    postFrame: (frame) => {
        const cmd: PublishCmd = { cmd: 'frame', frame };
        worker!.postMessage(cmd, [frame]);
    },
    getFps: () => +framerateSelect.value,
});

// ─── Codec + audio source selects ─────────────────────────────────

function populateCodecSelect(): void {
    codecSelect.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'auto';
    codecSelect.appendChild(autoOpt);
    for (const c of CODEC_CANDIDATES) {
        const opt = document.createElement('option');
        opt.value = c.codec;
        opt.textContent = c.label;
        codecSelect.appendChild(opt);
    }
    codecSelect.value = 'auto';
}

let micOptions: HTMLOptionElement[] = [];

function populateAudioSources(): void {
    const current = audioSourceSelect.value;
    audioSourceSelect.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(none)';
    audioSourceSelect.appendChild(none);
    for (const opt of micOptions) {
        audioSourceSelect.appendChild(opt.cloneNode(true) as HTMLOptionElement);
    }
    audioSourceSelect.value = current || '';
}

async function enumerateMics(): Promise<void> {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        micOptions = mics.map((m) => {
            const opt = document.createElement('option');
            opt.value = m.deviceId;
            opt.textContent = m.label || `Device ${m.deviceId.slice(0, 8)}`;
            return opt;
        });
        populateAudioSources();
    } catch { /* ignore */ }
}

// ─── Capture (webcam getUserMedia / ?source=canvas) ───────────────

// ?source=canvas: hardware-free mode for the automated live gate - an
// animated canvas replaces getUserMedia as the MediaStream source; the
// downstream path (preview element, FramePump/rVFC, codec detection,
// worker protocol) is identical. No audio in this mode: the selector
// stays disabled at (none) - no mic is acquired either. Without the
// param, behavior is unchanged (getUserMedia).
const canvasMode = new URLSearchParams(location.search).get('source') === 'canvas';
const CANVAS_W = 1280;
const CANVAS_H = 720;

let canvasEl: HTMLCanvasElement | null = null;
let canvasRafId = 0;
let canvasFrame = 0;

async function getUserMediaStream(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            aspectRatio: { ideal: 16 / 9 },
            frameRate: { ideal: +framerateSelect.value },
        },
        audio: true,
    });
    await enumerateMics();
    // Auto-pair the webcam's mic in the audio dropdown (stream.tsx): the
    // audio track from this getUserMedia is stopped - connect() re-acquires
    // the mic at publish time via the deviceId path.
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
        const micDeviceId = audioTrack.getSettings().deviceId;
        audioTrack.stop();
        stream.removeTrack(audioTrack);
        if (micDeviceId) {
            await enumerateMics();
            audioSourceSelect.value = micDeviceId;
        }
    }
    return stream;
}

// Animated test pattern: crawling color bars over a per-frame counter +
// wall-clock timestamp and a per-run random id - visibly unique per run,
// so playback/ffprobe can eyeball motion. Painted via rAF, sampled by
// captureStream(30).
function startCanvasSource(): MediaStream {
    const runId = Math.random().toString(16).slice(2, 8);
    const cv = document.createElement('canvas');
    cv.width = CANVAS_W;
    cv.height = CANVAS_H;
    // Laid out offscreen rather than display:none so paints stay live; the
    // preview video element shows the content, the status line marks the mode.
    cv.style.cssText = 'position:fixed;left:-9999px;bottom:0';
    document.body.appendChild(cv);
    canvasEl = cv;
    const ctx = cv.getContext('2d')!;
    const bars = ['#c33', '#3c3', '#33c', '#cc3', '#c3c', '#3cc'];
    const t0 = performance.now();
    const paint = (): void => {
        const t = (performance.now() - t0) / 1000;
        const bw = CANVAS_W / bars.length;
        const slide = Math.round((t * 90) % bw); // crawl left at 90 px/s
        for (let i = 0; i <= bars.length; i++) {
            ctx.fillStyle = bars[i % bars.length];
            ctx.fillRect(Math.round(i * bw) - slide, 0, Math.ceil(bw) + 1, CANVAS_H);
        }
        ctx.fillStyle = 'rgba(0,0,0,.75)';
        ctx.fillRect(0, CANVAS_H / 2 - 96, CANVAS_W, 192);
        ctx.textAlign = 'center';
        ctx.font = 'bold 64px monospace';
        ctx.fillStyle = '#fff';
        const d = new Date();
        ctx.fillText(
            `#${canvasFrame} ${d.toLocaleTimeString('en-GB')}.${String(d.getMilliseconds()).padStart(3, '0')}`,
            CANVAS_W / 2,
            CANVAS_H / 2 - 12,
        );
        ctx.font = 'bold 36px monospace';
        ctx.fillStyle = '#6cf';
        ctx.fillText(`websrt canvas run ${runId}`, CANVAS_W / 2, CANVAS_H / 2 + 56);
        canvasFrame++;
        canvasRafId = requestAnimationFrame(paint);
    };
    paint();
    return cv.captureStream(30);
}

async function startCapture(): Promise<void> {
    const stream = canvasMode ? startCanvasSource() : await getUserMediaStream();

    captureStream = stream;
    previewEl.srcObject = stream;
    await previewEl.play();

    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopCapture();
    });

    capturing = true;
    captureBtn.textContent = 'Stop Capture';
    publishBtn.disabled = false;

    const vTrack = stream.getVideoTracks()[0];
    const settings = vTrack?.getSettings();
    const w = canvasMode ? CANVAS_W : (settings?.width ?? 1280);
    const h = canvasMode ? CANVAS_H : (settings?.height ?? 720);
    log(`Captured ${w}x${h} (${canvasMode ? 'canvas test source' : 'webcam'})`, 'info');
    setStatus(canvasMode ? 'canvas test source - ready to publish' : 'webcam captured - ready to publish');

    const fps = +framerateSelect.value;
    const br = +bitrateNum.value;
    const detected = await detectCodec(w, h, fps, br);
    if (detected) {
        detectedCodec = detected.codec;
        log(`Codec auto-detected: ${detected.label} (${detected.codec})`, 'info');
    } else {
        log('No supported codec found!', 'err');
    }
}

function stopCapture(): void {
    if (publishing) stopAll();
    if (captureStream) {
        captureStream.getTracks().forEach((t) => t.stop());
    }
    if (canvasRafId) {
        cancelAnimationFrame(canvasRafId);
        canvasRafId = 0;
    }
    if (canvasEl) {
        canvasEl.remove();
        canvasEl = null;
    }
    captureStream = null;
    previewEl.srcObject = null;
    capturing = false;
    captureBtn.textContent = 'Capture';
    publishBtn.disabled = true;
    populateAudioSources();
    setStatus('capture stopped');
}

captureBtn.addEventListener('click', async () => {
    if (capturing) {
        stopCapture();
        return;
    }
    try {
        await startCapture();
    } catch (e) {
        log(`Capture failed: ${e}`, 'err');
        setStatus('capture failed');
    }
});

// ─── Publish URL ──────────────────────────────────────────────────

// wt://host:port is shorthand for https://host:port/wt (the WebTransport
// URL the worker expects); the publish query param always comes from the
// stream-name field, ?token= on the page URL passes through (stream.tsx).
function buildWtUrl(): string {
    const raw = pubUrlInput.value.trim();
    let u: URL;
    if (raw.startsWith('wt://')) {
        u = new URL(`https://${raw.slice('wt://'.length)}`);
        if (u.pathname === '/') u.pathname = '/wt';
    } else {
        u = new URL(raw);
    }
    u.searchParams.set('publish', streamNameInput.value || 'default');
    const authToken = new URLSearchParams(location.search).get('token');
    if (authToken) u.searchParams.set('token', authToken);
    return u.toString();
}

// ─── Publishing ───────────────────────────────────────────────────

publishBtn.addEventListener('click', async () => {
    if (publishing) return;
    if (!captureStream) { log('Capture the webcam first', 'err'); return; }

    publishing = true;
    publishBtn.disabled = true;
    stopBtn.disabled = false;
    viewerLink.style.display = '';
    const sn = streamNameInput.value || 'default';
    const viewerUrl = `${location.origin}/?stream=${encodeURIComponent(sn)}`;
    viewerLink.href = viewerUrl;
    viewerLink.textContent = viewerUrl;
    setStatus('starting\u2026');

    // Determine codec
    const vTrack = captureStream.getVideoTracks()[0];
    const settings = vTrack?.getSettings();
    const width = canvasMode ? CANVAS_W : (settings?.width ?? 1280);
    const height = canvasMode ? CANVAS_H : (settings?.height ?? 720);
    const framerate = +framerateSelect.value;
    const bitrate = +bitrateNum.value;
    const chosenCodec = codecSelect.value === 'auto' ? (detectedCodec ?? 'avc1.640028') : codecSelect.value;
    const isAv1 = chosenCodec.startsWith('av01');

    // Determine audio config + set up the capture graph (stream.tsx minus
    // the tab-audio options - webcam-only page)
    const audioSource = audioSourceSelect.value;
    const audioCfg = audioSource ? { bitrate: 128000, channels: 2 } : null;
    if (audioSource) {
        await audio.setup();
        await audio.connect(audioSource);
        await audio.resumeIfSuspended();
    }

    // Cert hash (cert-hash.js via serve.mjs; null = PKI, no pinning)
    const hashHex = (window as any).CERT_HASH as string | null | undefined;
    let certHash: Uint8Array | null = null;
    if (hashHex) certHash = hexToBytes(hashHex);

    const wtUrl = buildWtUrl();
    const latencyMs = +latencyNum.value;

    // Create worker (the pre-bundled vendored stream-worker - the esbuild
    // equivalent of stream.tsx's vite new URL('./stream-worker.ts'))
    worker = new Worker('/bundle/publish_worker.js', { type: 'module' });
    worker.onmessage = (e: MessageEvent) => handleWorkerMsg(e.data as PublishMsg);
    worker.onerror = (e) => { log(`worker error: ${e.message}`, 'err'); };

    const cmd: PublishCmd = {
        cmd: 'init',
        url: wtUrl,
        certHash,
        latencyMs,
        video: { codec: chosenCodec, width, height, bitrate, framerate },
        audio: audioCfg,
    };
    const transfer: ArrayBuffer[] = [];
    if (certHash) transfer.push(certHash.buffer as ArrayBuffer);
    worker.postMessage(cmd, transfer);

    // Transfer audio port
    if (audioSource) {
        audio.transferPort(worker);
    }

    log(`Publishing to ${wtUrl} (${isAv1 ? 'AV1' : 'H.264'})`, 'info');
    log(`latency: ${latencyMs}ms, bitrate: ${bitrate}Mbps, fps: ${framerate}`, 'info');
});

stopBtn.addEventListener('click', () => stopAll());

function stopAll(): void {
    publishing = false;
    framePump.stop();
    viewerLink.style.display = 'none';
    if (worker) {
        worker.postMessage({ cmd: 'stop' } as PublishCmd);
        worker.terminate();
        worker = null;
    }
    audio.close();
    publishBtn.disabled = !captureStream;
    stopBtn.disabled = true;
    framePump.resetCredits();
    setStatus('stopped');
}

// ─── Worker message handler ───────────────────────────────────────

function handleWorkerMsg(msg: PublishMsg): void {
    if (msg.type === 'batch') {
        for (const m of msg.msgs) handleWorkerMsg(m);
        return;
    }
    switch (msg.type) {
        case 'log':
            log(msg.msg, msg.cls);
            break;
        case 'credit':
            framePump.credit();
            break;
        case 'wtReady':
            log('WT connected', 'ok');
            setStatus('WT ready; awaiting SRT handshake');
            break;
        case 'handshakeComplete':
            log('SRT handshake complete', 'ok');
            setStatus('LIVE');
            framePump.start();
            break;
        case 'close':
            log('SRT closed', 'err');
            setStatus('closed');
            framePump.stop();
            break;
        case 'wtClosed':
            if (msg.error) log(`WT closed: ${msg.error}`, 'err');
            else log('WT closed', 'info');
            setStatus('disconnected');
            framePump.stop();
            break;
        case 'stats':
            if (msg.encode) updateEncodeStats(msg.stats, msg.encode);
            break;
    }
}

function updateEncodeStats(srt: StatsMsg, enc: EncodeStats): void {
    pubStatsText.innerHTML = formatPubStats(srt, enc, +framerateSelect.value);
}

// ─── Init ─────────────────────────────────────────────────────────

// Persistent stream key: load from localStorage or generate a random 8-char
// one (stream.tsx, verbatim).
const STREAM_KEY_KEY = 'websrt-stream-name';
const savedName = localStorage.getItem(STREAM_KEY_KEY);
streamNameInput.value = savedName ?? Array.from(
    { length: 8 },
    () => Math.floor(Math.random() * 36).toString(36),
).join('');
localStorage.setItem(STREAM_KEY_KEY, streamNameInput.value);
streamNameInput.addEventListener('change', () => {
    localStorage.setItem(STREAM_KEY_KEY, streamNameInput.value);
});

populateCodecSelect();
if (canvasMode) {
    audioSourceSelect.disabled = true; // no mic path in canvas mode
    setStatus('canvas test source mode - ready to Capture');
} else {
    enumerateMics();
}

document.addEventListener('visibilitychange', () => {
    if (publishing) framePump.schedule();
});

if ((window as any).CERT_HASH !== undefined) {
    if ((window as any).CERT_HASH) {
        log('Cert hash loaded', 'info');
    } else {
        log('mkcert mode', 'info');
    }
} else {
    log('No cert-hash.js. Start the gateway first, then reload.', 'info');
}
