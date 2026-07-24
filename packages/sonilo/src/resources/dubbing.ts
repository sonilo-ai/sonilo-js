import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type { DubbingParams, DubbingResult, SfxTask, WaitOptions } from "../types.js";

/** Build the multipart body for /v1/dubbing.
 *
 * `languages` travels as one opaque form field holding a JSON array string —
 * that is the shape the backend parses. It is omitted entirely when unset so
 * the server default (["zh_cn", "es", "fr"]) applies; sending an empty array
 * instead would be rejected as a malformed payload.
 *
 * The https check is local because it is a guaranteed server-side 422: the
 * dubbing pipeline fetches the source URL itself and requires https
 * specifically, unlike the fal-backed endpoints, which accept plain http.
 * Language codes are deliberately NOT checked here — the backend owns that
 * list, and a hardcoded copy would make this SDK reject codes added later. */
export async function buildDubbingForm(params: DubbingParams): Promise<FormData> {
  if ((params.video === undefined) === (params.videoUrl === undefined)) {
    throw new SoniloError("Provide exactly one of video or videoUrl");
  }
  const form = new FormData();
  if (params.video !== undefined) {
    const { blob, filename } = await toUploadBlob(params.video);
    form.set("video", blob, filename);
  } else {
    const url = params.videoUrl as string;
    if (!url.toLowerCase().startsWith("https://")) {
      throw new SoniloError(
        "videoUrl must use https — the dubbing pipeline requires an https URL",
      );
    }
    form.set("video_url", url);
  }
  if (params.languages !== undefined) {
    form.set("languages", JSON.stringify(params.languages));
  }
  return form;
}

/** Dub a video into one or more target languages. Async only; the result
 * carries a language → dubbed-video-URL map under `outputs`. */
export class Dubbing {
  constructor(private readonly client: SoniloClient) {}

  async submit(params: DubbingParams): Promise<SfxTask> {
    const res = await this.client.request("/v1/dubbing", {
      method: "POST",
      body: await buildDubbingForm(params),
    });
    return (await res.json()) as SfxTask;
  }

  async generate(params: DubbingParams, opts?: WaitOptions): Promise<DubbingResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<DubbingResult>(task.task_id, opts);
  }
}
