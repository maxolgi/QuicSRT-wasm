// Packaging smoke gate for ./build.sh sdk — imports BOTH built entries from
// sdk-dist with no DOM and asserts the assembled packages are coherent:
// the player entry constructs a handle, the worker/engine layout matches the
// worker's external engine import, the declarations cover the public API,
// and the adapter registers its tech against the host's video.js (resolved
// through sdk-dist/node_modules/@quicsrt/player + the repo's video.js, the
// same shape an embedder's tree has). Exit 0 = pass.
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../sdk-dist', import.meta.url));
const playerDir = `${dist}/quicsrt-player`;
const videojsDir = `${dist}/quicsrt-videojs`;

const fail = (msg) => { console.error(`sdk smoke: ${msg}`); process.exit(1); };
const read = (p) => readFileSync(p, 'utf8');

// --- @quicsrt/player: files, package metadata, asset wiring -------------
for (const f of ['index.js', 'worker.js', 'build/srt_engine.mjs', 'build/srt_engine.wasm',
  'package.json', 'README.md', 'CHANGELOG.md', 'types/player/index.d.ts']) {
  if (!existsSync(`${playerDir}/${f}`)) fail(`missing ${playerDir}/${f}`);
}
const playerPkg = JSON.parse(read(`${playerDir}/package.json`));
assert.equal(playerPkg.name, '@quicsrt/player');
assert.equal(playerPkg.version, '0.1.0');
assert.ok(!playerPkg.dependencies, 'the player package must have no dependencies');

// The worker must keep the engine import EXTERNAL and re-rooted to the
// package layout: './build/srt_engine.mjs' beside the worker, not the
// page-bundle '../build/srt_engine.mjs'.
const workerJs = read(`${playerDir}/worker.js`);
assert.ok(workerJs.includes('./build/srt_engine.mjs'),
  'worker.js must import ./build/srt_engine.mjs (in-package engine)');
assert.ok(!workerJs.includes('../build/srt_engine.mjs'),
  'worker.js still carries the page-bundle ../build/srt_engine.mjs path');

// The default workerUrl must have survived bundling.
const indexJs = read(`${playerDir}/index.js`);
assert.ok(indexJs.includes('new URL("./worker.js", import.meta.url)'),
  'index.js must resolve ./worker.js beside itself via import.meta.url');

// --- @quicsrt/player: import + construct with no DOM --------------------
const { mountPlayer } = await import(`${playerDir}/index.js`);
assert.equal(typeof mountPlayer, 'function');
const handle = mountPlayer(null, {});
assert.equal(handle.state, 'idle');
assert.equal(handle.paused, true);
assert.equal(handle.duration, 0);
assert.equal(typeof handle.connect, 'function');
handle.destroy();

// Declarations cover the public API surface.
const indexDts = read(`${playerDir}/types/player/index.d.ts`);
for (const sym of ['mountPlayer', 'PlayerHandle', 'PlayerOptions']) {
  assert.ok(indexDts.includes(sym), `types/player/index.d.ts must declare ${sym}`);
}

// --- @quicsrt/videojs: files, package metadata, import wiring ------------
for (const f of ['index.js', 'index.d.ts', 'package.json', 'README.md', 'CHANGELOG.md']) {
  if (!existsSync(`${videojsDir}/${f}`)) fail(`missing ${videojsDir}/${f}`);
}
const videojsPkg = JSON.parse(read(`${videojsDir}/package.json`));
assert.equal(videojsPkg.name, '@quicsrt/videojs');
assert.equal(videojsPkg.version, '0.1.0');
assert.equal(videojsPkg.peerDependencies['video.js'], '^8.0.0');
assert.equal(videojsPkg.peerDependencies['@quicsrt/player'], '0.1.0');

const adapterJs = read(`${videojsDir}/index.js`);
assert.ok(adapterJs.includes('from "@quicsrt/player"'),
  'index.js must import the @quicsrt/player peer, not the vendored path');
assert.ok(adapterJs.includes('from "video.js"'),
  'index.js must keep video.js external');

// --- @quicsrt/videojs: import with the host's video.js ------------------
// '@quicsrt/player' resolves via sdk-dist/node_modules/@quicsrt/player (the
// symlink ./build.sh sdk lays down), 'video.js' via the repo node_modules.
const { QuicSrtTech } = await import(`${videojsDir}/index.js`);
const videojs = (await import('video.js')).default;
assert.equal(typeof QuicSrtTech, 'function');
assert.equal(videojs.getTech('quicsrt'), QuicSrtTech,
  "importing '@quicsrt/videojs' must register the 'quicsrt' tech");
assert.equal(QuicSrtTech.canPlayType('application/quicsrt'), 'probably');

const techDts = read(`${videojsDir}/index.d.ts`);
assert.ok(techDts.includes('QuicSrtTech'), 'index.d.ts must declare QuicSrtTech');
assert.ok(techDts.includes("'@quicsrt/player'"),
  'index.d.ts must type the player dependency as @quicsrt/player');

console.log('sdk smoke: @quicsrt/player + @quicsrt/videojs OK');
