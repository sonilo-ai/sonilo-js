import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { VideoToSoundParams } from "../types.js";

/** Build the multipart body shared by /v1/video-to-sound and
 * /v1/video-to-video-sound — their form fields are identical, so the two
 * resources differ only in the path they POST to.
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
  return form;
}
