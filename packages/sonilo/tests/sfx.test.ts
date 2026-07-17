import { describe, expect, it } from "vitest";
import { SoniloError } from "../src/errors.js";
import { mockClient } from "./helpers.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ACK = { task_id: "t1", status: "processing" };
const SUCCEEDED = {
  task_id: "t1",
  type: "text_to_sfx",
  status: "succeeded",
  audio: { url: "https://r2.example.com/audio.m4a" },
};

describe("textToSfx", () => {
  it("submit posts form fields", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    const task = await client.textToSfx.submit({
      prompt: "glass breaking",
      duration: 5,
      audioFormat: "wav",
    });
    expect(task.task_id).toBe("t1");
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/text-to-sfx");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("prompt")).toBe("glass breaking");
    expect(form.get("duration")).toBe("5");
    expect(form.get("audio_format")).toBe("wav");
  });

  it("generate submits then waits", async () => {
    let polls = 0;
    const { client } = mockClient((url) => {
      if (url.endsWith("/v1/text-to-sfx")) return jsonResponse(ACK, 202);
      return jsonResponse(++polls < 2 ? ACK : SUCCEEDED);
    });
    const result = await client.textToSfx.generate(
      { prompt: "glass", duration: 5 },
      { pollInterval: 0 },
    );
    expect(result.status).toBe("succeeded");
  });
});

describe("videoToSfx", () => {
  it("submit uploads a file with segments and format", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToSfx.submit({
      video: new File(["fakevideo"], "clip.mp4"),
      segments: [{ start: 0, end: 1.5, prompt: "pop" }],
      audioFormat: "mp3",
    });
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/video-to-sfx");
    const form = calls[0]!.init.body as FormData;
    expect((form.get("video") as File).name).toBe("clip.mp4");
    expect(form.get("audio_format")).toBe("mp3");
    expect(JSON.parse(form.get("segments") as string)).toEqual([
      { start: 0, end: 1.5, prompt: "pop" },
    ]);
    expect(form.has("video_url")).toBe(false);
  });

  it("submit sends video_url instead of a file part", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToSfx.submit({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("video_url")).toBe("https://example.com/v.mp4");
    expect(form.has("video")).toBe(false);
  });

  it("rejects when both or neither video source is given", async () => {
    const { client } = mockClient(() => jsonResponse(ACK, 202));
    await expect(
      client.videoToSfx.submit({
        video: new Blob(["x"]),
        videoUrl: "https://example.com/v.mp4",
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.videoToSfx.submit({})).rejects.toBeInstanceOf(SoniloError);
  });
});
