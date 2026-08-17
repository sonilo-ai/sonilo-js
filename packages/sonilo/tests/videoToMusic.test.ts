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
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
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
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("mode")).toBe("async");
    expect(form.get("preserve_speech")).toBe("true");
    expect(form.get("output_format")).toBe("wav");
    expect(form.get("ducking")).toBe("false");
  });

  it("omits ducking when unset so the backend default applies", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ task_id: "m2", status: "processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToMusic.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("ducking")).toBe(false);
  });

  it("posts variants_num and defaults mode to async when variantsNum > 1", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({
      videoUrl: "https://example.com/v.mp4",
      variantsNum: 4,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("mode")).toBe("async");
    expect(form.get("variants_num")).toBe("4");
  });

  it("omits variants_num when unset", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("variants_num")).toBe(false);
  });

  it("rejects variantsNum > 1 with an explicit non-async mode without making a request", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await expect(
      client.videoToMusic.submit({
        videoUrl: "https://example.com/v.mp4",
        mode: "stream",
        variantsNum: 2,
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(calls.length).toBe(0);
  });

  it("does not force async for variantsNum: 1", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({
      videoUrl: "https://example.com/v.mp4",
      mode: "async",
      variantsNum: 1,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("variants_num")).toBe("1");
  });

  it("posts prompt_influence when set", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({
      videoUrl: "https://example.com/v.mp4",
      promptInfluence: 0.8,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("prompt_influence")).toBe("0.8");
  });

  it("sends prompt_influence: 0 rather than dropping it as falsy", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({
      videoUrl: "https://example.com/v.mp4",
      promptInfluence: 0,
    });
    const form = calls[0]!.init.body as FormData;
    // 0 means "the video leads entirely" — a meaningful request, not an unset
    // one. A truthiness check would silently fall back to the server's 0.5.
    expect(form.get("prompt_influence")).toBe("0");
  });

  it("omits prompt_influence when unset so the server default (0.5) applies", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("prompt_influence")).toBe(false);
  });

  it("posts stems and defaults mode to async when stems is set", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({
      videoUrl: "https://example.com/v.mp4",
      stems: true,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("mode")).toBe("async");
    expect(form.get("stems")).toBe("true");
  });

  it("omits stems when unset so the backend default applies", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await client.videoToMusic.submit({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("stems")).toBe(false);
  });

  it("rejects stems with an explicit non-async mode without making a request", async () => {
    const { client, calls } = mockClient(() => jsonResponse(ACK, 202));
    await expect(
      client.videoToMusic.submit({
        videoUrl: "https://example.com/v.mp4",
        mode: "stream",
        stems: true,
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(calls.length).toBe(0);
  });

});

describe("videoToMusic.stream ignores variantsNum", () => {
  it("never sends variants_num on the plain stream", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    await client.videoToMusic.generate({
      videoUrl: "https://example.com/v.mp4",
      variantsNum: 3,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("variants_num")).toBe(false);
  });

  it("never sends stems on the plain stream — the backend 400s it there", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    await client.videoToMusic.generate({
      videoUrl: "https://example.com/v.mp4",
      stems: true,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("stems")).toBe(false);
  });
});

describe("videoToMusic.stream prompt_influence", () => {
  // Unlike variantsNum above, promptInfluence is a generation-time knob the
  // backend accepts on both modes, so the plain stream sends it too.
  it("sends prompt_influence on the plain stream, including 0", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    await client.videoToMusic.generate({
      videoUrl: "https://example.com/v.mp4",
      promptInfluence: 0,
    });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("prompt_influence")).toBe("0");
  });

  it("omits prompt_influence from the stream when unset", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    await client.videoToMusic.generate({ videoUrl: "https://example.com/v.mp4" });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("prompt_influence")).toBe(false);
  });
});
