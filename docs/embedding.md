# Embedding the QuicSRT player

The player engine this repo builds — srt compiled to WebAssembly, driven
from a web worker, MPEG-TS demux and WebCodecs decode in the browser — is
consumable at three levels. Pick by how much of the page you want to own:

| Route                        | What you get                                       |
| ---------------------------- | -------------------------------------------------- |
| npm packages (§1)            | the SDK in your own app: handle, `<quicsrt-video>`, video.js tech |
| iframe a gateway page (§2)   | a ready page, zero integration                     |
| gateway-served bundles (§3)  | the SDK bundles off the gateway, same-origin pages |

Full API detail lives in the package READMEs; this page is the map.

## 1. npm packages in your own app

The primary route. [`@quicsrt/player`](../sdk/quicsrt-player/README.md)
ships the engine and the module worker inside the package — no build step
to replicate:

    npm install @quicsrt/player

    import { mountPlayer } from '@quicsrt/player';

    const player = mountPlayer(null, {
      video: document.getElementById('v'),   // or a <canvas>
      url: 'https://gw.example.net:8443/wt?stream=browsertest',
      // certHash: '<64 hex chars>' — or null for PKI
    });
    player.play();

- `@quicsrt/player` — `mountPlayer()` returns an HTMLMediaElement-shaped
  `PlayerHandle` (media methods, media events, live semantics).
- `@quicsrt/player/element` — importing it registers the chrome-free
  `<quicsrt-video>` custom element (self-registering; its default
  `workerUrl` resolves beside the module, zero-config).
- [`@quicsrt/videojs`](../sdk/quicsrt-videojs/README.md) — a video.js v8
  tech (peer dependency on the host's video.js) playing `quicsrt://` and
  `application/quicsrt` sources through the same handle.

`./build.sh sdk` assembles both from the `sdk/` templates into
`sdk-dist/` (gitignored); `node sdk/smoke.mjs` is the packaging gate.

## 2. iframe a gateway page

The zero-integration route: the [QuicSRT-gateway](https://github.com/maxolgi/QuicSRT-gateway)
serves the built pages (this repo's `dist/`, embedded in the gateway
binary), and the page's own origin carries the isolation:

    <iframe src="https://gw.example.com:8443/?stream=test"
            allow="autoplay; fullscreen"
            style="width:100%;aspect-ratio:16/9;border:0"></iframe>

Pages: the viewer (`/?stream=NAME`), the browser publisher
(`/publish.html`), the 1:1 call (`/call.html`), and the SDK demos
(`/element.html`, `/videojs.html`). Common URL params: `stream`, `token`,
`latency` (ms), plus endpoint overrides `host`/`port` (default: the page
host and the `WT_PORT` from cert-hash.js); the demo pages also take `wt=`
for a full source URL passed through verbatim.

## 3. The gateway-served bundles

For a page the gateway itself serves (`[server].web_root` in the gateway
config), the bundles are available under `/bundle/` with `/cert-hash.js`
same-origin — the demo pages' arrangement.

**Wiring caveat:** `/bundle/element.js` and `/bundle/videojs.js` are also
the demo-page entries — on load they resolve the first `<quicsrt-video>`
(resp. the `<video-js id="player">`) from the page's query string
(`?wt=`, else `?host=`/`?port=`/`?stream=`/`?token=`/`?latency=`),
overwriting a hardcoded `src`. Drive same-origin embeds from the URL, or
use the npm packages, which carry no such wiring.

## Source URLs

Everything takes the same grammar (resolved by the vendored
`page/vendor/source.ts`):

    quicsrt://host:port[/stream][?token=T&latency=MS]
    https://host:port/wt?stream=NAME[&token=T]

The `quicsrt://` form maps to the gateway's `https://host:port/wt`
WebTransport endpoint. The stream name defaults to `default`; `token`
must match the stream's allowlist entry on the gateway; `latency` is the
TSBPD target in milliseconds.

## Certificate pinning

Self-signed gateways are pinned browser-style (SHA-256 of the certificate
DER): the gateway serves `/cert-hash.js`, which sets `window.CERT_HASH`
(hex pin, or `null` when the gateway runs a PKI certificate — then normal
validation) and `window.WT_PORT`. Your own pages can set `window.CERT_HASH`
themselves or pass the `certHash` option / `cert_hash` URL parameter. The
pin rotates on every boot of a self-cert gateway — re-fetch after a
restart. With neither present, playback aborts with "No cert-hash.js".

## Cross-origin isolation

The wasm engine uses pthreads (`SharedArrayBuffer`), so the embedding
document must be COOP+COEP isolated (`crossOriginIsolated === true`).
The gateway sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every player response —
for the embedded dist and for `web_root` pages alike. Serving the
packages yourself means sending those headers yourself.

## Browser support

WebTransport + WebCodecs + WebAssembly (the video.js tech's
`isSupported()` is exactly that check): Chromium today. The `<video>`
output path additionally needs `MediaStreamTrackGenerator` (Chromium);
other engines fall back to the canvas path with a console warning.

## In this repo

- `sdk/` — the npm package templates (READMEs, package.json) + the
  packaging smoke gate; `./build.sh sdk` assembles `sdk-dist/`.
- `page/vendor/` — the vendored SDK sources both the packages and the
  demo pages build from (`element.ts`, `source.ts`, `player/`).
- [`page/README.md`](../page/README.md) — the demo pages' own doc
  (viewer / publisher / call how-to, serving flow).
- `./build.sh deploy` assembles `dist/` — the tree the gateway embeds.
