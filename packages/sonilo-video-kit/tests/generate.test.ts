import { describe, expect, it } from "vitest";
import type { Track } from "sonilo";
import { generateMusicForVideo, type VideoMusicClient } from "../src/generate.js";

const FAKE_TRACK: Track = { audio: new Uint8Array([1, 2, 3]), title: "Skyline" };

function stubClient() {
  const calls: unknown[] = [];
  const client: VideoMusicClient = {
    videoToMusic: {
      generate: async (params) => {
        calls.push(params);
        return FAKE_TRACK;
      },
    },
  };
  return { client, calls };
}

describe("generateMusicForVideo", () => {
  it("delegates to the client's videoToMusic.generate and returns the Track", async () => {
    const { client, calls } = stubClient();
    const track = await generateMusicForVideo("./clip.mp4", {
      prompt: "upbeat",
      segments: [{ start: 0, prompt: "intro", label: "intro" }],
      client,
    });
    expect(track).toBe(FAKE_TRACK);
    expect(calls).toEqual([
      {
        video: "./clip.mp4",
        prompt: "upbeat",
        segments: [{ start: 0, prompt: "intro", label: "intro" }],
      },
    ]);
  });

  it("omits prompt/segments keys it was not given", async () => {
    const { client, calls } = stubClient();
    await generateMusicForVideo("./clip.mp4", { client });
    expect(calls[0]).toEqual({ video: "./clip.mp4" });
  });
});
