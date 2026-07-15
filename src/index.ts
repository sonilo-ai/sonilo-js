export { generateMusicForVideo } from "./generate.js";
export type { GenerateMusicForVideoOptions, VideoMusicClient } from "./generate.js";
export { mixWithVideo } from "./mix.js";
export type { MixWithVideoOptions } from "./mix.js";
export { duckMusicUnderSpeech, MAX_DUCKED_MIX_BYTES, MAX_DUCKING_DURATION_SECONDS } from "./duck.js";
export type { DuckMusicUnderSpeechOptions } from "./duck.js";
// DuckingClient only: the `client` option genuinely needs it. DuckingResult is
// deliberately NOT exported -- no public signature mentions it
// (duckMusicUnderSpeech returns the output path), and its `"video"` variant
// would semver-lock a wire shape describing a state this package refuses to
// produce, since it never uploads anything but an extracted audio track.
export type { DuckingClient } from "./ducking-api.js";
export { DuckingFailedError, FfmpegError, FfmpegNotFoundError, VideoKitError } from "./errors.js";
export {
  DELIVERY_TARGET_LUFS,
  FALLBACK_MUSIC_LUFS,
  GAP_BELOW_VOICE_LU,
  OUTPUT_CEILING_DBFS,
} from "./loudness.js";
export type { Segment, Track, VideoInput } from "sonilo";
