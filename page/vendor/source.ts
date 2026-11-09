// QuicSRT source-URL resolution, shared by the source-consuming hosts (the
// video.js tech, the <quicsrt-video> element):
//   quicsrt://host:port[/stream][?token=..&latency=..]
//       → SDK url https://host:port/wt?stream=<stream>&token=.. (stream
//         defaults to "default", latency maps to latencyMs clamped 20..8000)
//   https://host:port/wt?stream=..&token=..&latency=.. (type application/quicsrt)
//       → passed through as the SDK url option, stream/latency read from query

export interface ResolvedSource {
  /** Full WebTransport endpoint (the SDK `url` option). */
  url: string;
  /** Stream name resolved from the source. */
  stream: string;
  /** Connection identity minus the stream name: url origin + path. */
  endpoint: string;
  token: string | null;
  latencyMs: number | undefined;
}

const MIN_LATENCY_MS = 20;
const MAX_LATENCY_MS = 8000;

function clampLatencyMs(value: number): number {
  return Math.min(MAX_LATENCY_MS, Math.max(MIN_LATENCY_MS, value));
}

export function resolveSource(src: string): ResolvedSource | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  const token = u.searchParams.get('token');
  const latencyRaw = u.searchParams.get('latency');
  const latencyMs = latencyRaw !== null && Number.isFinite(+latencyRaw)
    ? clampLatencyMs(+latencyRaw)
    : undefined;

  if (u.protocol === 'quicsrt:') {
    const stream = decodeURIComponent(u.pathname.replace(/^\/+/, '').split('/')[0] || '') || 'default';
    const wt = new URL(`https://${u.host}/wt`);
    wt.searchParams.set('stream', stream);
    if (token !== null) wt.searchParams.set('token', token);
    return { url: wt.href, stream, endpoint: `https://${u.host}/wt`, token, latencyMs };
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    return {
      url: u.href,
      stream: u.searchParams.get('stream') || 'default',
      endpoint: u.origin + u.pathname,
      token,
      latencyMs,
    };
  }
  return null;
}
