import { describe, expect, it } from "vitest";
import { SoniloError } from "../src/errors.js";
import { b64, mockClient, ndjsonResponse } from "./helpers.js";

const EVENTS = [{ type: "audio_chunk", data: b64("vidmusic") }, { type: "complete" }];

describe("videoToMusic.generate", () => {
  it("uploads a Blob as multipart with filename", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    const track = await client.videoToMusic.generate({
      video: new File(["fakevideo"], "clip.mp4"),
      prompt: "upbeat",
    });
    expect(new TextDecoder().decode(track.audio)).toBe("vidmusic");

    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/video-to-music");
    const form = calls[0]!.init.body as FormData;
    const part = form.get("video") as File;
    expect(part.name).toBe("clip.mp4");
    expect(form.get("prompt")).toBe("upbeat");
    expect(form.has("video_url")).toBe(false);
  });

  it("sends video_url instead of a file part", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    await client.videoToMusic.generate({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("video_url")).toBe("https://example.com/v.mp4");
    expect(form.has("video")).toBe(false);
  });

  it("rejects when both video and videoUrl are given", async () => {
    const { client } = mockClient(() => ndjsonResponse(EVENTS));
    await expect(
      client.videoToMusic.generate({
        video: new Blob(["x"]),
        videoUrl: "https://example.com/v.mp4",
      }),
    ).rejects.toBeInstanceOf(SoniloError);
  });

  it("rejects when neither video nor videoUrl is given", async () => {
    const { client } = mockClient(() => ndjsonResponse(EVENTS));
    await expect(client.videoToMusic.generate({})).rejects.toBeInstanceOf(SoniloError);
  });
});

describe("videoToMusic.stream", () => {
  it("streams events for a url input", async () => {
    const { client } = mockClient(() => ndjsonResponse(EVENTS, 4));
    const types: string[] = [];
    for await (const ev of client.videoToMusic.stream({ videoUrl: "https://example.com/v.mp4" })) {
      types.push(ev.type);
    }
    expect(types).toEqual(["audio_chunk", "complete"]);
  });

  it("does not attach an absolute abort signal, even with a client timeout configured", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    for await (const _ev of client.videoToMusic.stream({ videoUrl: "https://example.com/v.mp4" })) {
      // drain
    }
    expect(calls[0]!.init.signal).toBeUndefined();
  });

  it("forwards a caller-supplied signal straight through to fetch, unrewrapped", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    const controller = new AbortController();
    for await (const _ev of client.videoToMusic.stream({
      videoUrl: "https://example.com/v.mp4",
      signal: controller.signal,
    })) {
      // drain
    }
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});
