import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type {
  DubbingParams,
  DubbingResult,
  DubbingTask,
  SubtitleInput,
  WaitOptions,
} from "../types.js";

const SUBTITLE_EXTENSIONS = [".srt", ".vtt"];

/** Normalize one uploaded subtitle script into a FormData-ready Blob.
 *
 * `toUploadBlob` does the reading, but it is only safe here because
 * `SubtitleInput` is narrowed to a path string or a `File` — the two inputs
 * that carry a real filename. Its fallback name (`video.mp4`) would be
 * rejected by the server, so the suffix is checked first: the server requires
 * `.srt`/`.vtt` and refuses anything else with a 422, and failing locally
 * names the offending file before a pointless upload.
 *
 * The 1 MiB part cap and the "languages must match exactly" rule are
 * deliberately NOT checked here — the server owns both, and a copy in the
 * client would drift from it. */
async function toSubtitleBlob(
  language: string,
  value: SubtitleInput,
): Promise<{ blob: Blob; filename: string }> {
  const name = typeof value === "string" ? value : (value?.name ?? "");
  const lowered = name.toLowerCase();
  if (!SUBTITLE_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
    throw new SoniloError(
      `subtitles[${language}]: "${name}" must be an .srt or .vtt file, or an https:// URL`,
    );
  }
  return toUploadBlob(value);
}

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
 * list, and a hardcoded copy would make this SDK reject codes added later.
 *
 * `subtitles` uses Stripe-style bracket keys, one field per target language.
 * A bare or repeated `subtitles` key is refused server-side rather than
 * silently ignored, so each entry gets its own `subtitles[<language>]` field.
 *
 * `export_srt` is sent only when the caller passed it, like every other
 * optional field here, so the server keeps owning its default. */
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
  if (params.ducking !== undefined) {
    form.set("ducking", String(params.ducking));
  }
  // Omitted when unset rather than defaulted here, so the server owns the
  // default (on) and this SDK does not have to be republished if it moves.
  if (params.lipsync !== undefined) {
    form.set("lipsync", String(params.lipsync));
  }
  if (params.subtitles !== undefined) {
    for (const [language, value] of Object.entries(params.subtitles)) {
      const field = `subtitles[${language}]`;
      if (typeof value === "string" && value.toLowerCase().startsWith("https://")) {
        form.set(field, value);
        continue;
      }
      const { blob, filename } = await toSubtitleBlob(language, value);
      form.set(field, blob, filename);
    }
  }
  if (params.exportSrt !== undefined) {
    // Counted, not tested for undefined: an empty map is what building
    // `subtitles` from an empty list produces, and it would otherwise slip
    // past this guard and send `export_srt` alone — the exact 422 the guard
    // exists to pre-empt.
    if (params.exportSrt && Object.keys(params.subtitles ?? {}).length === 0) {
      throw new SoniloError("exportSrt requires subtitles — there is nothing to align against");
    }
    form.set("export_srt", String(params.exportSrt));
  }
  return form;
}

/** Dub a video into one or more target languages. Async only; the result
 * carries a language → dubbed-video-URL map under `outputs`. */
export class Dubbing {
  constructor(private readonly client: SoniloClient) {}

  /** The acknowledgement carries `subtitle_preflight` when scripts were sent,
   * which is why this returns `DubbingTask` rather than the shared `SfxTask`:
   * a `review_required` preflight means the pipeline altered lines in the
   * script that was submitted, and typing it away hides that from every
   * caller who only ever sees the 202. */
  async submit(params: DubbingParams): Promise<DubbingTask> {
    const res = await this.client.request("/v1/dubbing", {
      method: "POST",
      body: await buildDubbingForm(params),
    });
    return (await res.json()) as DubbingTask;
  }

  async generate(params: DubbingParams, opts?: WaitOptions): Promise<DubbingResult> {
    const task = await this.submit(params);
    return this.client.tasks.wait<DubbingResult>(task.task_id, opts);
  }
}
