import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
import { SoniloError } from "../src/errors.js";
import type { VideoAnalysisResult } from "../src/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACK = { task_id: "va1", status: "processing" };

const SUCCESS: VideoAnalysisResult = {
  task_id: "va1",
  type: "video_analysis",
  status: "succeeded",
  variants_num: 2,
  segments: [
    { start: 0, end: 12, label: "intro", prompt: "sparse piano, rising" },
    { start: 12, end: 30, label: "none", prompt: "full strings, driving" },
  ],
  variations: [
    { prompt: "cinematic strings, 90bpm" },
    { prompt: "lo-fi hip hop, warm keys" },
  ],
  duration_seconds: 30,
  cost: 0.24,
};

function ackClient() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(ACK, 202),
  );
  return { fetch, client: new SoniloClient({ apiKey: "k", fetch }) };
}

describe("videoAnalysis", () => {
  it("posts video_url, prompt and variants_num to /v1/video-analysis", async () => {
    const { fetch, client } = ackClient();
    const task = await client.videoAnalysis.submit({
      videoUrl: "https://x/v.mp4",
      prompt: "focus on the chase",
      variantsNum: 2,
    });
    expect(task.task_id).toBe("va1");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/video-analysis");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("video_url")).toBe("https://x/v.mp4");
    expect(form.get("prompt")).toBe("focus on the chase");
    expect(form.get("variants_num")).toBe("2");
    expect(form.has("video")).toBe(false);
  });

  it("omits prompt and variants_num when unset so the server defaults apply", async () => {
    const { fetch, client } = ackClient();
    await client.videoAnalysis.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("prompt")).toBe(false);
    expect(form.has("variants_num")).toBe(false);
  });

  it("uploads a video as a file part", async () => {
    const { fetch, client } = ackClient();
    await client.videoAnalysis.submit({
      video: new Blob([new Uint8Array([1, 2, 3])]),
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("video")).toBe(true);
    expect(form.has("video_url")).toBe(false);
  });

  it("rejects neither or both inputs before sending", async () => {
    const { fetch, client } = ackClient();
    await expect(client.videoAnalysis.submit({})).rejects.toThrow(SoniloError);
    await expect(
      client.videoAnalysis.submit({
        video: new Blob([new Uint8Array([1])]),
        videoUrl: "https://x/v.mp4",
      }),
    ).rejects.toThrow(SoniloError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("analyze() polls to the finished brief", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("/v1/tasks/")
        ? jsonResponse(SUCCESS)
        : jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const brief = await client.videoAnalysis.analyze(
      { videoUrl: "https://x/v.mp4", variantsNum: 2 },
      { pollInterval: 0 },
    );
    expect(brief.variations?.map((v) => v.prompt)).toEqual([
      "cinematic strings, 90bpm",
      "lo-fi hip hop, warm keys",
    ]);
    expect(brief.segments?.[0]?.label).toBe("intro");
  });
});
