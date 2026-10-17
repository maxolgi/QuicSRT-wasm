// Static server for the player page (no deps, node builtins only).
// - page/ at /, engine build/ at /build/: the emcc module must stay its own
//   file - it spawns its pthread workers by self-importing srt_engine.mjs
//   and fetches srt_engine.wasm relative to itself.
// - COOP/COEP on EVERY response: emscripten pthreads need SharedArrayBuffer,
//   i.e. a cross-origin-isolated context.
// - /cert-hash.js is proxied from the local C++ gateway's web port
//   (https://127.0.0.1:8443, TLS unchecked - loopback target only, per
//   WebSRT docs/embedding.md "backend injects the cert hash").
import http from 'node:http';
import https from 'node:https';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('.', import.meta.url));
const REPO = normalize(join(PAGE, '..'));
const GATEWAY_WEB = 'https://127.0.0.1:8443';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };
const COI = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/cert-hash.js') {
        https.get(`${GATEWAY_WEB}/cert-hash.js`, { rejectUnauthorized: false }, (gw) => {
            res.writeHead(gw.statusCode, { 'Content-Type': 'text/javascript', ...COI });
            if (req.method === 'HEAD') { gw.resume(); res.end(); } else gw.pipe(res);
        }).on('error', () => {
            res.writeHead(502, { 'Content-Type': 'text/plain', ...COI });
            res.end('cert-hash proxy: gateway unreachable');
        });
        return;
    }
    const base = url.startsWith('/build/') ? REPO : PAGE;
    const file = normalize(join(base, url === '/' ? 'index.html' : url));
    const ok = file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
    if (!ok) { res.writeHead(403, COI); return res.end('forbidden'); }
    let st;
    try { st = statSync(file); } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...COI });
        return res.end('not found');
    }
    if (!st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...COI });
        return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...COI });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
}).listen(8099, () => console.log('player page: http://localhost:8099/'));
