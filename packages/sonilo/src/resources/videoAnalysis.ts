import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type {
  SfxTask,
  VideoAnalysisParams,
  VideoAnalysisResult,
  WaitOptions,
} from "../types.js";

/** Analyze a video and get back a creative brief for scoring it. Async only.
 *
 * This endpoint generates nothing — no audio, no video, no artifact to
 * download. The result is the work order: `segments` (a time-aligned section
 * plan) plus one `prompt` per requested variation, each ready to hand
 * straight to videoToMusic, videoToSfx, videoToSound or their
 * video-to-video counterparts.
 *
 * The method is `analyze`, not `generate`, for that reason: every other
 * resource's `generate` returns something you download, and this one never
 * does.
 *
 * The 1-5 bound on `variantsNum` and the 2000-character bound on `prompt`
 * are deliberately not checked here — the backend owns them, and a hardcoded
 * copy would make this SDK reject values a later API widens. */
export class VideoAnalysis {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: VideoAnalysisParams): Promise<SfxTask> {
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
    if (params.variantsNum !== undefined) {
      form.set("variants_num", String(params.variantsNum));
    }
    const res = await this.client.request("/v1/video-analysis", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }

  async analyze(
    params: VideoAnalysisParams,
    opts?: WaitOptions,
  ): Promise<VideoAnalysisResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<VideoAnalysisResult>(task.task_id, opts);
  }
}
