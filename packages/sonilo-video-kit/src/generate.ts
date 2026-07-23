import { SoniloClient } from "sonilo";
import type { Segment, Track, VideoInput } from "sonilo";
import { VERSION } from "./version.js";

/** The minimal client surface this kit needs. A real SoniloClient satisfies it;
 * tests can pass a stub without touching the network. */
export interface VideoMusicClient {
  videoToMusic: {
    generate(params: { video?: VideoInput; prompt?: string; segments?: Segment[] }): Promise<Track>;
  };
}

export interface GenerateMusicForVideoOptions {
  prompt?: string;
  segments?: Segment[];
  /** Defaults to `new SoniloClient()` (reads SONILO_API_KEY). */
  client?: VideoMusicClient;
}

export async function generateMusicForVideo(
  video: VideoInput,
  options: GenerateMusicForVideoOptions = {},
): Promise<Track> {
  const client = options.client ??
    // Only the kit's own default client is tagged; a caller-supplied client
    // keeps whatever identity its owner gave it.
    new SoniloClient({ clientName: "videokit-js", clientVersion: VERSION });
  const params: { video: VideoInput; prompt?: string; segments?: Segment[] } = { video };
  if (options.prompt !== undefined) params.prompt = options.prompt;
  if (options.segments !== undefined) params.segments = options.segments;
  return client.videoToMusic.generate(params);
}
