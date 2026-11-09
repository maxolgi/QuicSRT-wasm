// MediaStreamTrackGenerator is not in TypeScript's bundled lib.dom.d.ts,
// but the package's declaration output references it (the audio pipeline
// base's generator field). This ambient declaration ships in types/ and is
// referenced from the types entry; delete it when lib.dom catches up
// (interface merging makes the overlap benign under skipLibCheck).
interface MediaStreamTrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame | AudioData>;
}
declare var MediaStreamTrackGenerator: {
  new (init: { kind: string }): MediaStreamTrackGenerator;
};
