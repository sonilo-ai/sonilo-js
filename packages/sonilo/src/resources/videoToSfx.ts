import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { SfxResult, SfxTask, VideoToSfxParams, WaitOptions } from "../types.js";

export class VideoToSfx {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: VideoToSfxParams): Promise<SfxTask> {
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
    if (params.prompt !== undefined) form.set("prompt", params.prompt);
    if (params.segments !== undefined) {
      form.set("segments", JSON.stringify(params.segments));
    }
    if (params.audioFormat !== undefined) form.set("audio_format", params.audioFormat);
    const res = await this.client.request("/v1/video-to-sfx", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: VideoToSfxParams, opts?: WaitOptions): Promise<SfxResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait(task.task_id, opts);
  }
}
