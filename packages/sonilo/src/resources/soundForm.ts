import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { VideoToSoundParams, VideoToVideoSoundParams } from "../types.js";

/** The widest shape either endpoint can send. Neither public param type can
 * serve as the parameter here, because the two now differ in opposite
 * directions: `outputFormat` exists only on `VideoToSoundParams` (audio),
 * while `keepOriginalSound` is video-only and is therefore typed `never` on
 * `VideoToSoundParams`. That makes each public type unassignable to the other,
 * so the shared builder takes their union and each endpoint's own param type
 * stays the thing that rejects the wrong field at compile time. */
type SoundFormParams = VideoToVideoSoundParams & Pick<VideoToSoundParams, "outputFormat">;

/** Build the multipart body shared by /v1/video-to-sound and
 * /v1/video-to-video-sound. The two differ only in the path they POST to and
 * in the two endpoint-specific fields described on `SoundFormParams`.
 *
 * Every optional field is omitted when unset rather than sent with a default,
 * so the server's own default decides. `ducking` and `keepOriginalSound` are
 * both default-OFF server-side today, but neither is hardcoded here — pinning
 * either one on the wire is what would have to change the next time a server
 * default moves, and this builder deliberately does not. */
export async function buildSoundForm(params: SoundFormParams): Promise<FormData> {
  if ((params.video === undefined) === (params.videoUrl === undefined)) {
    throw new SoniloError("Provide exactly one of video or videoUrl");
  }
  const form = new FormData();
  if (params.video !== undefined) {
    const { blob, filename } = await toUploadBlob(params.video);
    form.set("video", blob, filename);
  } else {
    form.set("video_url", params.videoUrl as string);
  }
  if (params.musicPrompt !== undefined) form.set("music_prompt", params.musicPrompt);
  if (params.sfxPrompt !== undefined) form.set("sfx_prompt", params.sfxPrompt);
  if (params.segments !== undefined) {
    form.set("segments", JSON.stringify(params.segments));
  }
  if (params.keepOriginalSound !== undefined) {
    form.set("keep_original_sound", String(params.keepOriginalSound));
  }
  if (params.preserveSpeech !== undefined) {
    form.set("preserve_speech", String(params.preserveSpeech));
  }
  if (params.ducking !== undefined) form.set("ducking", String(params.ducking));
  if (params.outputFormat !== undefined) {
    form.set("output_format", params.outputFormat);
  }
  if (params.variantsNum !== undefined) {
    form.set("variants_num", String(params.variantsNum));
  }
  return form;
}
