# Changelog

## 0.1.0 — 2026-11-09

- Initial npm packaging of the QuicSRT player SDK (`mountPlayer` +
  `PlayerHandle` HTMLMediaElement-shaped API).
- Ships the module worker and the prebuilt wasm engine
  (`build/srt_engine.mjs` + `.wasm`) in-package; the default `workerUrl`
  resolves `./worker.js` beside the SDK module.
- TypeScript declarations for the full player surface.
