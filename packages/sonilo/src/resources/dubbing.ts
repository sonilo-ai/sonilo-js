import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { toUploadBlob } from "../upload.js";
import type {
  DubbingParams,
  DubbingResult,
  SfxTask,
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
 * `ducking`, `lipsync` and `export_srt` are each sent only when the caller
 * passed them. That matters most for `lipsync`, whose server default is ON:
 * an absent field must keep meaning "re-render the mouth", which is what
 * every dubbing task did before the parameter existed. */
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
    if (params.exportSrt && params.subtitles === undefined) {
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
