import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { SfxTask, VideoResult, VideoToVideoMusicParams, WaitOptions } from "../types.js";

/** Generate an original score for a video and get back a re-hosted video with
 * the music muxed in. Async only: `submit()` returns a task ack; poll with
 * `client.tasks.wait<VideoResult>(id)`, or use `generate()` to do both. */
export class VideoToVideoMusic {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: VideoToVideoMusicParams): Promise<SfxTask> {
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
    if (params.preserveSpeech !== undefined) {
      form.set("preserve_speech", String(params.preserveSpeech));
    }
    if (params.isolateVocals !== undefined) {
      form.set("isolate_vocals", String(params.isolateVocals));
    }
    const res = await this.client.request("/v1/video-to-video-music", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: VideoToVideoMusicParams, opts?: WaitOptions): Promise<VideoResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<VideoResult>(task.task_id, opts);
  }
}
