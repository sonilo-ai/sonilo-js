import type { SoniloClient } from "../client.js";
import { buildSoundForm } from "./soundForm.js";
import type { SfxTask, SoundResult, VideoToSoundParams, WaitOptions } from "../types.js";

/** Generate a combined music + sound-effects track for a video and get back
 * the mixed audio. Async only. */
export class VideoToSound {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: VideoToSoundParams): Promise<SfxTask> {
    const res = await this.client.request("/v1/video-to-sound", {
      method: "POST",
      body: await buildSoundForm(params),
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: VideoToSoundParams, opts?: WaitOptions): Promise<SoundResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<SoundResult>(task.task_id, opts);
  }
}
