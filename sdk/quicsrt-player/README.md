# @quicsrt/player

QuicSRT player SDK: [SRT](https://github.com/Haivision/srt) over
WebTransport, received and decoded in the browser (WebAssembly + WebCodecs),
behind an HTMLMediaElement-shaped handle. The receiving engine
(`srt_engine.wasm`) and the module worker ship inside the package — no build
step to replicate.

## Install

```sh
npm install @quicsrt/player
```

## Usage

```html
<video id="v" muted playsinline></video>

<script type="module">
  import { mountPlayer } from '@quicsrt/player';

  const player = mountPlayer(null, {
    video: document.getElementById('v'),          // or pass a <canvas> + null here
    url: 'https://gw.example.net:8443/wt?stream=browsertest',
    // certHash: 'aa:bb:…64 hex chars…',          // or null for PKI/mkcert
  });

  player.addEventListener('playing', () => console.log('live'));
  player.play();                                   // resolves on the first frame
</script>
```

`mountPlayer(canvas | null, options)` returns a `PlayerHandle`:
`play/pause/volume/muted/currentTime/duration/buffered/seekable` with media
events (`loadstart`, `loadedmetadata`, `canplay`, `playing`, `timeupdate`,
`waiting`, `ended`, …). Live semantics: `duration` is `Infinity` once
connected, `buffered`/`seekable` stay empty, `currentTime` is a 0-based
per-connection media clock.

## Requirements & gotchas

- **Certificate hash.** For self-signed gateways the WebTransport connection
  pins the server certificate: set `window.CERT_HASH` (the QuicSRT gateway
  serves it at `/cert-hash.js`, which sets `window.CERT_HASH` and
  `window.WT_PORT`) or pass `certHash` explicitly — a DER SHA-256 hex string
  to pin, or `null` for PKI/mkcert. With neither, playback aborts with
  "No cert-hash.js".
- **COOP/COEP.** The wasm engine uses pthreads (`SharedArrayBuffer`): serve
  your page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, and serve the package
  assets same-origin or CORS-enabled (`crossOriginIsolated` must be true).
- **Worker + engine assets.** The worker and engine load relative to the SDK
  module (`./worker.js`, `./build/srt_engine.mjs` + `.wasm` beside
  `index.js`) — with a bundler or CDN that resolves
  `new URL('./worker.js', import.meta.url)` this is zero-config. When you
  serve the worker yourself, pass `workerUrl` and keep
  `build/srt_engine.mjs` + `.wasm` in a `build/` directory beside it.
- **Browsers.** WebTransport + WebCodecs: Chromium today (the tech's
  `isSupported()` checks both). The `<video>` element output
  (`options.video`) needs video `MediaStreamTrackGenerator` — Chromium only;
  elsewhere it falls back to the canvas path with a console warning.

## License

MPL-2.0. Source: [QuicSRT-wasm](https://github.com/maxolgi/QuicSRT-wasm).
