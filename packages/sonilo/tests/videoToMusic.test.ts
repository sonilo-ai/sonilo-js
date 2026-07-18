import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
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

const ACK = { task_id: "t1", status: "processing" };
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("videoToMusic.submit", () => {
  it("posts mode and isolate_vocals form fields for an async request", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    const task = await client.videoToMusic.submit({
      video: new File(["fakevideo"], "clip.mp4"),
      prompt: "upbeat",
      mode: "async",
      isolateVocals: true,
    });
    expect(task.task_id).toBe("t1");
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/video-to-music");
    const form = calls[0]!.init.body as FormData;
    expect((form.get("video") as File).name).toBe("clip.mp4");
    expect(form.get("prompt")).toBe("upbeat");
    expect(form.get("mode")).toBe("async");
    expect(form.get("isolate_vocals")).toBe("true");
  });

  it("defaults mode to async when isolateVocals is true and mode is omitted", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({
      videoUrl: "https://example.com/v.mp4",
      isolateVocals: true,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("mode")).toBe("async");
    expect(form.get("isolate_vocals")).toBe("true");
  });

  it("defaults mode to async and omits isolate_vocals when neither is set", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("mode")).toBe("async");
    expect(form.has("isolate_vocals")).toBe(false);
  });

  it("rejects isolateVocals with an explicit non-async mode without making a request", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await expect(
      client.videoToMusic.submit({
        videoUrl: "https://example.com/v.mp4",
        mode: "stream",
        isolateVocals: true,
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(calls.length).toBe(0);
  });

  it("rejects when both or neither video source is given", async () => {
    const { client } = mockClient(() => jsonResponse(ACK, 202));
    await expect(
      client.videoToMusic.submit({
        video: new Blob(["x"]),
        videoUrl: "https://example.com/v.mp4",
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.videoToMusic.submit({})).rejects.toBeInstanceOf(SoniloError);
  });

  it("forwards preserve_speech, output_format and ducking; defaults mode async", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ task_id: "m1", status: "processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToMusic.submit({
      videoUrl: "https://x/v.mp4",
      preserveSpeech: true,
      outputFormat: "wav",
      ducking: false,
    });
    const form = fetch.mock.calls[0][1].body;
    expect(form.get("mode")).toBe("async");
    expect(form.get("preserve_speech")).toBe("true");
    expect(form.get("output_format")).toBe("wav");
    expect(form.get("ducking")).toBe("false");
  });

  it("omits ducking when unset so the backend default applies", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ task_id: "m2", status: "processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToMusic.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0][1].body;
    expect(form.has("ducking")).toBe(false);
  });
});
