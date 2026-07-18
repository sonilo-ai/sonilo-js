import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { SfxTask, VideoResult, VideoToVideoSfxParams, WaitOptions } from "../types.js";

/** Generate sound effects for a video and get back a re-hosted video with the
 * SFX muxed in. Async only. */
export class VideoToVideoSfx {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: VideoToVideoSfxParams): Promise<SfxTask> {
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
    const res = await this.client.request("/v1/video-to-video-sfx", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: VideoToVideoSfxParams, opts?: WaitOptions): Promise<VideoResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<VideoResult>(task.task_id, opts);
  }
}
