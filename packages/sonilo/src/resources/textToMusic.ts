import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { collectTrack, parseNdjson } from "../streaming.js";
import type { SfxTask, StreamEvent, TextToMusicParams, Track } from "../types.js";

export class TextToMusic {
  constructor(private readonly client: SoniloClient) {}

  /** Stream raw generation events (audio chunks pre-decoded to bytes). */
  async *stream(params: TextToMusicParams): AsyncGenerator<StreamEvent, void, undefined> {
    const form = new FormData();
    form.set("prompt", params.prompt);
    form.set("duration", String(params.duration));
    if (params.segments !== undefined) {
      form.set("segments", JSON.stringify(params.segments));
    }
    // Opt out of the client's absolute request timeout: this holds the
    // response body open and reads NDJSON chunks for as long as generation
    // takes, so an AbortSignal keyed to elapsed time would kill a healthy,
    // still-streaming, long-duration track. Pass `params.signal` yourself to
    // bound or cancel the stream instead — it is forwarded to `fetch` as-is.
    const res = await this.client.request(
      "/v1/text-to-music",
      { method: "POST", body: form, signal: params.signal },
      { timeout: null },
    );
    if (!res.body) throw new SoniloError("Response has no body");
    yield* parseNdjson(res.body);
  }

  /** Generate and buffer the whole track; throws GenerationError on stream errors. */
  generate(params: TextToMusicParams): Promise<Track> {
    return collectTrack(this.stream(params));
  }

  /**
   * Submit an async text-to-music task; poll with
   * `client.tasks.wait<MusicTaskResult>(task.task_id)`. Required for
   * `outputFormat: "wav"`. `stream()`/`generate()` remain the streaming path.
   */
  async submit(params: TextToMusicParams): Promise<SfxTask> {
    const mode = params.mode ?? "async";
    if (mode !== "async") {
      throw new SoniloError('submit() requires mode: "async"');
    }
    const form = new FormData();
    form.set("prompt", params.prompt);
    form.set("duration", String(params.duration));
    if (params.segments !== undefined) {
      form.set("segments", JSON.stringify(params.segments));
    }
    form.set("mode", mode);
    if (params.outputFormat !== undefined) {
      form.set("output_format", params.outputFormat);
    }
    const res = await this.client.request("/v1/text-to-music", {
      method: "POST",
      body: form,
    });
    return (await res.json()) as SfxTask;
  }
}
