// video.js demo page for the QuicSrtTech (page/adapters/videojs/tech):
// importing the tech registers it, then the stock video.js skin plays a
// QuicSRT source resolved with the viewer page's conventions
// (page/vendor/shared/viewer.ts): ?stream= (default 'default'), ?host=
// and ?port= fallbacks (page hostname, localhost→127.0.0.1, window.WT_PORT
// from the gateway's /cert-hash.js, last resort 4433), ?token=, ?latency=;
// ?wt=<full WT url> passes an explicit endpoint through instead. The
// status line under the player reflects the tech's state so live
// verification can read it from the DOM.

import videojs from 'video.js';
import 'video.js/dist/video-js.css';

import './adapters/videojs/tech';
import type { PlayerOptions as QuicSrtPlayerOptions } from './vendor/player/index';

const params = new URLSearchParams(location.search);
const token = params.get('token');
const latency = params.get('latency');

// ?wt= hands the tech the full WT endpoint as the source; otherwise build
// a quicsrt:// URL, which the tech maps to the same https://host:port/wt
// address the viewer would connect to.
const explicitUrl = params.get('wt');
let src: string;
if (explicitUrl) {
  src = explicitUrl;
} else {
  const pageHost = location.hostname || '127.0.0.1';
  const host = params.get('host') ?? (pageHost === 'localhost' ? '127.0.0.1' : pageHost);
  const port = params.get('port') ?? String((window as any).WT_PORT ?? '4433');
  const stream = params.get('stream') ?? 'default';
  const qp = new URLSearchParams();
  if (token) qp.set('token', token);
  if (latency) qp.set('latency', latency);
  const q = qp.toString();
  src = `quicsrt://${host}:${port}/${encodeURIComponent(stream)}${q ? `?${q}` : ''}`;
}

// Tech options ride the player's `quicsrt` key: video.js namespaces tech
// options by tech name and the tech hands them to mountPlayer.
const quicsrt: QuicSrtPlayerOptions = { workerUrl: '/bundle/worker.js' };

const el = document.getElementById('player')!;
const player = videojs(el, {
  techOrder: ['quicsrt', 'html5'],
  liveui: true,
  controls: true,
  muted: true,
  responsive: true,
  fluid: true,
  sources: [{ src, type: 'application/quicsrt' }],
  quicsrt,
});

// Autoplay stays off: playback starts on the skin's play button. The
// state label follows the player-level events the tech bridges.
const statusEl = document.getElementById('status')!;
let state = 'idle — press play';
const renderStatus = () => { statusEl.textContent = `${player.currentSrc()} — ${state}`; };
player.on('waiting', () => { state = 'waiting'; renderStatus(); });
player.on('playing', () => { state = 'playing'; renderStatus(); });
player.on('error', () => {
  state = `error: ${player.error()?.message ?? 'unknown'}`;
  renderStatus();
});
renderStatus();
