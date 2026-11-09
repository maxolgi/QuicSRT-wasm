// <quicsrt-video> demo page for the component (page/vendor/element):
// importing the module registers the element, then the declarative
// <quicsrt-video> in element.html plays a QuicSRT source resolved with
// the viewer page's conventions (page/vendor/shared/viewer.ts): ?stream=
// (default 'browsertest'), ?host= and ?port= fallbacks (page hostname,
// localhost→127.0.0.1, window.WT_PORT from the gateway's /cert-hash.js,
// last resort 4433), ?token=, ?latency=; ?wt=<full WT url> passes an
// explicit endpoint through instead. The worker default is pinned to the
// page bundle's /bundle/worker.js — the SDK's asset-relative default does
// not match this page's layout — before the element's deferred autoplay
// start runs. The status line under the player reflects the element's
// events so live verification can read it from the DOM.

import { setDefaultWorkerUrl } from './vendor/element';

setDefaultWorkerUrl('/bundle/worker.js');

const params = new URLSearchParams(location.search);
const token = params.get('token');
const latency = params.get('latency');

const el = document.querySelector('quicsrt-video')!;

// ?wt= hands the element the full WT endpoint as the source; otherwise
// build a quicsrt:// URL, which the element maps to the same
// https://host:port/wt address the viewer would connect to.
const explicitUrl = params.get('wt');
let src: string;
if (explicitUrl) {
  src = explicitUrl;
} else {
  const pageHost = location.hostname || '127.0.0.1';
  const host = params.get('host') ?? (pageHost === 'localhost' ? '127.0.0.1' : pageHost);
  const port = params.get('port') ?? String((window as any).WT_PORT ?? '4433');
  const stream = params.get('stream') ?? 'browsertest';
  const qp = new URLSearchParams();
  if (token) qp.set('token', token);
  if (latency) qp.set('latency', latency);
  const q = qp.toString();
  src = `quicsrt://${host}:${port}/${encodeURIComponent(stream)}${q ? `?${q}` : ''}`;
}

// The attribute lands in the same evaluation turn as the worker default
// above, i.e. before the element's deferred autoplay start — playback
// begins on the resolved source.
el.setAttribute('src', src);

// The status line follows the element's re-dispatched media events.
const statusEl = document.getElementById('status')!;
let state = 'loading';
const renderStatus = () => { statusEl.textContent = `${el.getAttribute('src')} — ${state}`; };
el.addEventListener('waiting', () => { state = 'waiting'; renderStatus(); });
el.addEventListener('playing', () => { state = 'playing'; renderStatus(); });
el.addEventListener('pause', () => { state = 'paused'; renderStatus(); });
el.addEventListener('error', (event) => {
  state = `error: ${(event as CustomEvent<{ message?: string }>).detail?.message ?? 'unknown'}`;
  renderStatus();
});
renderStatus();
