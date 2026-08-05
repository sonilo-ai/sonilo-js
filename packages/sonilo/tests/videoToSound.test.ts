import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
import { SoniloError } from "../src/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACK = { task_id: "sd1", status: "processing" };

describe("videoToSound", () => {
  it("posts every form field to /v1/video-to-sound", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({
      videoUrl: "https://x/v.mp4",
      musicPrompt: "uplifting orchestral",
      sfxPrompt: "match the action",
      segments: [{ start: 0, end: 2, prompt: "whoosh" }],
      preserveSpeech: true,
      ducking: false,
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/video-to-sound");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("video_url")).toBe("https://x/v.mp4");
    expect(form.get("music_prompt")).toBe("uplifting orchestral");
    expect(form.get("sfx_prompt")).toBe("match the action");
    expect(JSON.parse(form.get("segments") as string)).toEqual([
      { start: 0, end: 2, prompt: "whoosh" },
    ]);
    expect(form.get("preserve_speech")).toBe("true");
    expect(form.get("ducking")).toBe("false");
    expect(form.has("video")).toBe(false);
    expect(form.has("isolate_vocals")).toBe(false);
  });

  it("omits ducking when unset so the server default (off) applies", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("ducking")).toBe(false);
    expect(form.has("preserve_speech")).toBe(false);
    expect(form.has("music_prompt")).toBe(false);
  });

  it("uploads a File as the video part", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ video: new File(["bytes"], "clip.mp4") });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("video") as File).name).toBe("clip.mp4");
    expect(form.has("video_url")).toBe(false);
  });

  it("rejects when both or neither of video and videoUrl are given", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await expect(
      client.videoToSound.submit({ video: new Blob(["x"]), videoUrl: "https://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.videoToSound.submit({})).rejects.toBeInstanceOf(SoniloError);
  });

  it("generate() polls to a SoundResult carrying output_url and stems", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "sd1",
          type: "video_to_sound",
          status: "succeeded",
          output_url: "https://r2/sound.wav",
          output_type: "audio",
          output_bytes: 12,
          music: { url: "https://r2/music.m4a", content_type: "audio/mp4", file_size: 5 },
          sfx: { url: "https://r2/sfx.wav", content_type: "audio/wav", file_size: 4 },
          duration_seconds: 8.5,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.videoToSound.generate(
      { videoUrl: "https://x/v.mp4" },
      { pollInterval: 0 },
    );
    expect(res.output_url).toBe("https://r2/sound.wav");
    expect(res.output_type).toBe("audio");
    expect(res.music?.url).toBe("https://r2/music.m4a");
    expect(res.sfx?.url).toBe("https://r2/sfx.wav");
    expect(res.music_processed).toBeUndefined();
    expect(res.duration_seconds).toBe(8.5);
  });

  it("posts variants_num when set", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ videoUrl: "https://x/v.mp4", variantsNum: 6 });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("variants_num")).toBe("6");
  });

  it("omits variants_num when unset", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("variants_num")).toBe(false);
  });

  it("generate() surfaces outputs[] alongside the top-level aliases", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "sd1",
          type: "video_to_sound",
          status: "succeeded",
          output_url: "https://r2/sound0.wav",
          output_type: "audio",
          output_bytes: 12,
          music: { url: "https://r2/music0.m4a" },
          sfx: { url: "https://r2/sfx0.wav" },
          outputs: [
            {
              variant_index: 0,
              output_url: "https://r2/sound0.wav",
              output_type: "audio",
              output_bytes: 12,
              music: { url: "https://r2/music0.m4a" },
              sfx: { url: "https://r2/sfx0.wav" },
            },
            {
              variant_index: 1,
              output_url: "https://r2/sound1.wav",
              output_type: "audio",
              output_bytes: 13,
              music: { url: "https://r2/music1.m4a" },
              sfx: { url: "https://r2/sfx1.wav" },
            },
          ],
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.videoToSound.generate(
      { videoUrl: "https://x/v.mp4", variantsNum: 2 },
      { pollInterval: 0 },
    );
    expect(res.outputs).toHaveLength(2);
    expect(res.outputs?.[1]?.output_url).toBe("https://r2/sound1.wav");
    expect(res.output_url).toBe(res.outputs?.[0]?.output_url);
  });
});

describe("videoToVideoSound", () => {
  it("posts to /v1/video-to-video-sound with the same fields", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoSound.submit({
      videoUrl: "https://x/v.mp4",
      musicPrompt: "tense strings",
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/video-to-video-sound");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("music_prompt")).toBe("tense strings");
  });

  it("generate() polls to a SoundResult with output_type video", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "sd1",
          type: "video_to_video_sound",
          status: "succeeded",
          output_url: "https://r2/sound.mp4",
          output_type: "video",
          music_processed: { url: "https://r2/mp.wav", content_type: "audio/wav" },
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.videoToVideoSound.generate(
      { videoUrl: "https://x/v.mp4" },
      { pollInterval: 0 },
    );
    expect(res.output_type).toBe("video");
    expect(res.music_processed?.url).toBe("https://r2/mp.wav");
  });

  it("posts variants_num when set", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoSound.submit({ videoUrl: "https://x/v.mp4", variantsNum: 2 });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("variants_num")).toBe("2");
  });
});

describe("videoToSound outputFormat", () => {
  it("sends output_format on the audio endpoint", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ task_id: "t", status: "processing" }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ videoUrl: "https://x/v.mp4", outputFormat: "mp3" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("output_format")).toBe("mp3");
  });

  it("omits output_format when unset so the server wav default stands", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ task_id: "t", status: "processing" }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("output_format")).toBe(false);
  });

  // videoToVideoSound takes VideoToVideoSoundParams, which has no
  // outputFormat -- that endpoint always returns an mp4. The type is the
  // guard; this asserts nothing leaks onto the wire either.
  it("never sends output_format from the video endpoint", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ task_id: "t", status: "processing" }),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoSound.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("output_format")).toBe(false);
  });

  it("sends keep_original_sound when set", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoSound.submit({
      videoUrl: "https://x/v.mp4",
      keepOriginalSound: true,
      ducking: false,
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("keep_original_sound")).toBe("true");
    // Together these two are the "full original sound + static mix" row.
    expect(form.get("ducking")).toBe("false");
  });

  it("omits keep_original_sound when unset so the server default (off) applies", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToVideoSound.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("keep_original_sound")).toBe(false);
  });

  // The mirror of the output_format guard above, running the other way:
  // keepOriginalSound is video-only, so VideoToSoundParams types it `never`.
  // The type is the guard; this asserts nothing reaches the wire either, since
  // the server silently drops an unknown form field rather than rejecting it.
  it("never sends keep_original_sound from the audio endpoint", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.videoToSound.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("keep_original_sound")).toBe(false);
  });
});
