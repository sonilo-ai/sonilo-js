import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { collectTrack, parseNdjson } from "../streaming.js";
import type { StreamEvent, TextToMusicParams, Track } from "../types.js";

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
    // still-streaming, long-duration track.
    const res = await this.client.request(
      "/v1/text-to-music",
      { method: "POST", body: form },
      { timeout: null },
    );
    if (!res.body) throw new SoniloError("Response has no body");
    yield* parseNdjson(res.body);
  }

  /** Generate and buffer the whole track; throws GenerationError on stream errors. */
  generate(params: TextToMusicParams): Promise<Track> {
    return collectTrack(this.stream(params));
  }
}
