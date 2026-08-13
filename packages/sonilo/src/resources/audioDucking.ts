import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { AudioDuckingParams, DuckingResult, SfxTask, WaitOptions } from "../types.js";

/** Duck an existing music bed under a voice track. Async only (202 + poll).
 *
 * Both inputs are user-supplied — nothing is generated here. The voice may be
 * audio OR a video: the backend extracts a video's audio track, ducks the
 * music under it, and re-muxes the ducked mix back into a new video (the
 * result's `output_type` announces which came back). The music must be audio —
 * the backend never probes it for a video stream, so a video there would be
 * silently mishandled. */
export class AudioDucking {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: AudioDuckingParams): Promise<SfxTask> {
    // Both pairs are validated before any upload I/O, so a missing music
    // input is reported even when the voice side alone looks fine.
    if ((params.voice === undefined) === (params.voiceUrl === undefined)) {
      throw new SoniloError("Provide exactly one of voice or voiceUrl");
    }
    if ((params.music === undefined) === (params.musicUrl === undefined)) {
      throw new SoniloError("Provide exactly one of music or musicUrl");
    }
    const form = new FormData();
    if (params.voice !== undefined) {
      const { blob, filename } = await toUploadBlob(params.voice);
      form.set("voice_file", blob, filename);
    } else {
      form.set("voice_url", params.voiceUrl as string);
    }
    if (params.music !== undefined) {
      const { blob, filename } = await toUploadBlob(params.music);
      form.set("music_file", blob, filename);
    } else {
      form.set("music_url", params.musicUrl as string);
    }
    const res = await this.client.request("/v1/audio-ducking", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: AudioDuckingParams, opts?: WaitOptions): Promise<DuckingResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<DuckingResult>(task.task_id, opts);
  }
}
