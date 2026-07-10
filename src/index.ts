export { generateMusicForVideo } from "./generate.js";
export type { GenerateMusicForVideoOptions, VideoMusicClient } from "./generate.js";
export { mixWithVideo } from "./mix.js";
export type { MixWithVideoOptions } from "./mix.js";
export { FfmpegError, FfmpegNotFoundError, VideoKitError } from "./errors.js";
export {
  DELIVERY_TARGET_LUFS,
  FALLBACK_MUSIC_LUFS,
  GAP_BELOW_VOICE_LU,
  OUTPUT_CEILING_DBFS,
} from "./loudness.js";
export type { Segment, Track, VideoInput } from "sonilo";
