import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { VideoToSoundParams } from "../types.js";

/** Build the multipart body shared by /v1/video-to-sound and
 * /v1/video-to-video-sound. The two differ only in the path they POST to and
 * in `outputFormat`, which the video endpoint does not accept — it always
 * returns an mp4. Taking the wider `VideoToSoundParams` here is what lets
 * both callers pass through: `VideoToVideoSoundParams` satisfies it
 * structurally, and with `outputFormat` absent from that type the field can
 * never be set on a video-endpoint call.
 *
 * Every optional field is omitted when unset rather than sent with a default:
 * `ducking` in particular is default-ON server-side, so an unset value must
 * not become an explicit "false" on the wire. */
export async function buildSoundForm(params: VideoToSoundParams): Promise<FormData> {
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
