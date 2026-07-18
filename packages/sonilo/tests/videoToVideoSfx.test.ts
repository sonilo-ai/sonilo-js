import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("videoToVideoSfx", () => {
  it("serializes segments and submits", async () => {
    const fetch = vi.fn(async () => jsonResponse({ task_id: "s1", status: "processing" }));
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoSfx.submit({
      videoUrl: "https://x/v.mp4",
      segments: [{ start: 0, end: 2, prompt: "whoosh" }],
    });
    const form = fetch.mock.calls[0][1]!.body as FormData;
    expect(fetch.mock.calls[0][0]).toBe("https://api.sonilo.com/v1/video-to-video-sfx");
    expect(JSON.parse(form.get("segments") as string)).toEqual([
      { start: 0, end: 2, prompt: "whoosh" },
    ]);
  });

  it("generate() polls to a VideoResult", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: "s2", status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "s2",
          type: "video_to_video_sfx",
          status: "succeeded",
          video: { url: "https://r2/sfx.mp4", content_type: "video/mp4" },
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.videoToVideoSfx.generate(
      { videoUrl: "https://x/v.mp4" },
      { pollInterval: 0 },
    );
    expect(res.video?.url).toBe("https://r2/sfx.mp4");
  });
});
