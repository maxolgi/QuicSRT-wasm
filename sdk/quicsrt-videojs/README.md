# @quicsrt/videojs

A [video.js](https://video.js) v8 tech that plays QuicSRT live streams
(SRT over WebTransport) through the [`@quicsrt/player`](../quicsrt-player)
SDK — stock video.js skin, live UI, no build step to replicate.

## Install

```sh
npm install @quicsrt/videojs @quicsrt/player video.js
```

## Usage

Importing the module registers the tech (`registerTech('quicsrt')`) against
the **host's** video.js instance — `video.js` is a peer dependency, so the
registry and player you already use stay the one instance.

```html
<video id="v" class="video-js" controls muted playsinline></video>

<script type="module">
  import videojs from 'video.js';
  import '@quicsrt/videojs';

  const player = videojs('v', {
    techOrder: ['quicsrt', 'html5'],
    liveui: true,
    sources: [{ src: 'quicsrt://gw.example.net:8443/browsertest', type: 'application/quicsrt' }],
    // latency/token ride the source URL (?latency=..&token=..), tech options
    // (certHash, latencyMs, hwMode, workerUrl, …) ride the `quicsrt` key:
    // quicsrt: { certHash: null },
  });
  player.play();
</script>
```

Sources:

- `quicsrt://host:port[/stream][?token=..&latency=..]` — mapped to the
  gateway's `https://host:port/wt?stream=<stream>` endpoint (stream defaults
  to `default`).
- any `https://host:port/wt?stream=..` URL with `type: 'application/quicsrt'`
  — passed through as the SDK `url` option.

Everything the player SDK needs applies here too — see the
[`@quicsrt/player` README](../quicsrt-player): the certificate hash
(`window.CERT_HASH` or the `certHash` tech option), COOP/COEP headers for the
pthreads wasm engine, and the Chromium (WebTransport + WebCodecs) support
matrix. The tech renders into its own `<video>` element via
`MediaStreamTrackGenerator` (Chromium; other engines should use the canvas
SDK directly).

## License

MPL-2.0. Source: [QuicSRT-wasm](https://github.com/maxolgi/QuicSRT-wasm).
