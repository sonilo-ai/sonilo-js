import type { SoniloClient } from "../client.js";
import { SoniloError } from "../errors.js";
import { collectTrack, parseNdjson } from "../streaming.js";
import { toUploadBlob } from "../upload.js";
import type { StreamEvent, Track, VideoToMusicParams } from "../types.js";

export class VideoToMusic {
  constructor(private readonly client: SoniloClient) {}

  async *stream(params: VideoToMusicParams): AsyncGenerator<StreamEvent, void, undefined> {
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
    // Opt out of the client's absolute request timeout: this holds the
    // response body open and reads NDJSON chunks for as long as generation
    // takes, so an AbortSignal keyed to elapsed time would kill a healthy,
    // still-streaming request (e.g. a slow video upload or long track). Pass
    // `params.signal` yourself to bound or cancel the stream instead — it is
    // forwarded to `fetch` as-is.
    const res = await this.client.request(
      "/v1/video-to-music",
      { method: "POST", body: form, signal: params.signal },
      { timeout: null },
    );
    if (!res.body) throw new SoniloError("Response has no body");
    yield* parseNdjson(res.body);
  }

  generate(params: VideoToMusicParams): Promise<Track> {
    return collectTrack(this.stream(params));
  }
}
