import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type {
  ProofreadParams,
  ProofreadResult,
  SfxTask,
  WaitOptions,
} from "../types.js";

/** Build the multipart body for /v1/proofread.
 *
 * The same wire shape as /v1/dubbing, deliberately: `languages` travels as one
 * opaque form field holding a JSON array string, and is omitted entirely when
 * unset — omitting it is what asks for the source-language transcript alone,
 * so there is nothing to default to here.
 *
 * The https check is local for the same reason it is on dubbing: the pipeline
 * fetches the source URL itself and requires https specifically, unlike the
 * fal-backed endpoints, which accept plain http. Language codes are
 * deliberately NOT checked here — the backend owns that list and names the
 * code it refused, and a hardcoded copy would make this SDK reject codes
 * added later. */
export async function buildProofreadForm(params: ProofreadParams): Promise<FormData> {
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
        "videoUrl must use https — the proofread pipeline requires an https URL",
      );
    }
    form.set("video_url", url);
  }
  if (params.languages !== undefined) {
    form.set("languages", JSON.stringify(params.languages));
  }
  if (params.sourceLanguage !== undefined) {
    form.set("source_language", params.sourceLanguage);
  }
  return form;
}

/** Transcribe one video and translate the transcript into editable subtitle
 * files. Async only; the result carries a language → `.srt`-URL map under
 * `subtitles`.
 *
 * This is the step before `client.dubbing`, not a replacement for it:
 * proofread returns one `.srt` per language plus the source-language
 * transcript, you review or correct the wording, and the corrected files go to
 * `client.dubbing` as `subtitles[<language>]` so the dub speaks exactly the
 * approved lines. The language codes are the same on both endpoints, so a
 * proofread script can go straight into a dub.
 *
 * Billing is per second of video multiplied by the number of target languages;
 * a transcript-only request counts as one. */
export class Proofread {
  constructor(private readonly client: SoniloClient) {}

  /** Returns the shared `SfxTask` acknowledgement: unlike dubbing, this 202
   * carries nothing beyond the task id and status. */
  async submit(params: ProofreadParams): Promise<SfxTask> {
    const res = await this.client.request("/v1/proofread", {
      method: "POST",
      body: await buildProofreadForm(params),
    });
    return (await res.json()) as SfxTask;
  }

  /** Submit and poll to the finished result. The SDK's normal wait default
   * applies — a proofread job typically finishes in well under a minute, so
   * this needs none of dubbing's two-hour ceiling. */
  async generate(params: ProofreadParams, opts?: WaitOptions): Promise<ProofreadResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<ProofreadResult>(task.task_id, opts);
  }
}
