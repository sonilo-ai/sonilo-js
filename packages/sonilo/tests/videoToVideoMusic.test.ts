import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("videoToVideoMusic", () => {
  it("submits video_url + preserveSpeech and posts the alias too", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ task_id: "t1", status: "processing" }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const task = await client.videoToVideoMusic.submit({
      videoUrl: "https://x/v.mp4",
      prompt: "cinematic",
      preserveSpeech: true,
    });
    expect(task).toEqual({ task_id: "t1", status: "processing" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.sonilo.com/v1/video-to-video-music");
    const form = init!.body as FormData;
    expect(form.get("video_url")).toBe("https://x/v.mp4");
    expect(form.get("prompt")).toBe("cinematic");
    expect(form.get("preserve_speech")).toBe("true");
  });

  it("generate() polls to a VideoResult", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: "t2", status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "t2",
          type: "video_to_video_music",
          status: "succeeded",
          video: { url: "https://r2/out.mp4", content_type: "video/mp4", file_size: 42 },
          duration_seconds: 5,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.videoToVideoMusic.generate(
      { videoUrl: "https://x/v.mp4" },
      { pollInterval: 0 },
    );
    expect(res.video?.url).toBe("https://r2/out.mp4");
    expect(res.duration_seconds).toBe(5);
  });

  it("posts variants_num when set", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ task_id: "t3", status: "processing" }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoMusic.submit({
      videoUrl: "https://x/v.mp4",
      variantsNum: 5,
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("variants_num")).toBe("5");
  });

  it("omits variants_num when unset", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ task_id: "t4", status: "processing" }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoMusic.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("variants_num")).toBe(false);
  });

  it("generate() surfaces videos[] alongside the video alias", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: "t5", status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "t5",
          type: "video_to_video_music",
          status: "succeeded",
          videos: [
            { url: "https://r2/v0.mp4", content_type: "video/mp4", file_size: 10 },
            { url: "https://r2/v1.mp4", content_type: "video/mp4", file_size: 11 },
          ],
          video: { url: "https://r2/v0.mp4", content_type: "video/mp4", file_size: 10 },
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.videoToVideoMusic.generate(
      { videoUrl: "https://x/v.mp4", variantsNum: 2 },
      { pollInterval: 0 },
    );
    expect(res.videos).toHaveLength(2);
    expect(res.videos?.[1]?.url).toBe("https://r2/v1.mp4");
    expect(res.video?.url).toBe(res.videos?.[0]?.url);
  });

  it("rejects zero or both video inputs", async () => {
    const client = new SoniloClient({ apiKey: "k", fetch: vi.fn() });
    await expect(client.videoToVideoMusic.submit({})).rejects.toThrow(/exactly one/);
    await expect(
      client.videoToVideoMusic.submit({ video: new Uint8Array(), videoUrl: "https://x" }),
    ).rejects.toThrow(/exactly one/);
  });
});
