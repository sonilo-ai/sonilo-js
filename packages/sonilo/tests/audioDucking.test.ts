import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
import { SoniloError } from "../src/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACK = { task_id: "ad1", status: "processing" };

describe("audioDucking", () => {
  it("posts voice_url and music_url to /v1/audio-ducking", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.audioDucking.submit({
      voiceUrl: "https://x/interview.mp4",
      musicUrl: "https://x/bed.wav",
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/audio-ducking");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("voice_url")).toBe("https://x/interview.mp4");
    expect(form.get("music_url")).toBe("https://x/bed.wav");
    expect(form.has("voice_file")).toBe(false);
    expect(form.has("music_file")).toBe(false);
  });

  it("uploads Files as the voice_file and music_file parts", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.audioDucking.submit({
      voice: new File(["v"], "interview.mp4"),
      music: new File(["m"], "bed.wav"),
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("voice_file") as File).name).toBe("interview.mp4");
    expect((form.get("music_file") as File).name).toBe("bed.wav");
    expect(form.has("voice_url")).toBe(false);
    expect(form.has("music_url")).toBe(false);
  });

  it("mixes a local file with a URL across the two inputs", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await client.audioDucking.submit({
      voice: new File(["v"], "voice.wav"),
      musicUrl: "https://x/bed.wav",
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("voice_file") as File).name).toBe("voice.wav");
    expect(form.get("music_url")).toBe("https://x/bed.wav");
  });

  it("rejects when both or neither of voice and voiceUrl are given", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await expect(
      client.audioDucking.submit({
        voice: new Blob(["v"]),
        voiceUrl: "https://x/v.wav",
        musicUrl: "https://x/m.wav",
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(
      client.audioDucking.submit({ musicUrl: "https://x/m.wav" }),
    ).rejects.toBeInstanceOf(SoniloError);
  });

  it("rejects when both or neither of music and musicUrl are given", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(ACK, 202),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    await expect(
      client.audioDucking.submit({
        voiceUrl: "https://x/v.wav",
        music: new Blob(["m"]),
        musicUrl: "https://x/m.wav",
      }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(
      client.audioDucking.submit({ voiceUrl: "https://x/v.wav" }),
    ).rejects.toBeInstanceOf(SoniloError);
    // The voice check must not swallow the music one: a valid voice with no
    // music still fails, before any fetch happens.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("generate() polls to a DuckingResult carrying the flat output envelope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "ad1",
          type: "audio_ducking",
          status: "succeeded",
          output_url: "https://r2/ducked.wav",
          output_type: "audio",
          output_bytes: 12,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.audioDucking.generate(
      { voiceUrl: "https://x/v.wav", musicUrl: "https://x/m.wav" },
      { pollInterval: 0 },
    );
    expect(res.output_url).toBe("https://r2/ducked.wav");
    expect(res.output_type).toBe("audio");
    expect(res.output_bytes).toBe(12);
  });

  it("generate() surfaces a video result when the voice input was a video", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "ad1",
          type: "audio_ducking",
          status: "succeeded",
          output_url: "https://r2/ducked.mp4",
          output_type: "video",
          output_bytes: 34,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.audioDucking.generate(
      { voiceUrl: "https://x/v.mp4", musicUrl: "https://x/m.wav" },
      { pollInterval: 0 },
    );
    expect(res.output_type).toBe("video");
    expect(res.output_url).toBe("https://r2/ducked.mp4");
  });
});
