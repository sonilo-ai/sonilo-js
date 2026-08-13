import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { runAudioDucking } from "../src/cli.js";
import { json, mockClient } from "./helpers.js";

// Same seam as cli.test.ts: only writeFile is mocked, so tests assert what
// would have been written without touching disk.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

function mockExit(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
}

describe("runAudioDucking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits to /v1/audio-ducking, polls, and downloads output_url", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/audio-ducking")
        ? json({ task_id: "ad1", status: "processing" })
        : json({
            task_id: "ad1",
            status: "succeeded",
            output_url: "https://cdn.example.com/ducked.wav",
            output_type: "audio",
          }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(writeFile).mockClear();

    await runAudioDucking(client, [
      "--voice-url",
      "https://in.example.com/interview.wav",
      "--music-url",
      "https://in.example.com/bed.wav",
    ]);

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/audio-ducking");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("voice_url")).toBe("https://in.example.com/interview.wav");
    expect(form.get("music_url")).toBe("https://in.example.com/bed.wav");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://cdn.example.com/ducked.wav",
      expect.anything(),
    );
    // Default output name takes its extension from the result URL.
    expect(vi.mocked(writeFile).mock.calls.map((c) => c[0])).toEqual(["output.wav"]);
  });

  it("defaults to output.mp4 when the voice input was a video", async () => {
    const { client } = mockClient((url) =>
      url.endsWith("/v1/audio-ducking")
        ? json({ task_id: "ad2", status: "processing" })
        : json({
            task_id: "ad2",
            status: "succeeded",
            output_url: "https://cdn.example.com/ducked.mp4",
            output_type: "video",
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(writeFile).mockClear();

    await runAudioDucking(client, [
      "--voice-url",
      "https://in.example.com/clip.mp4",
      "--music-url",
      "https://in.example.com/bed.wav",
    ]);

    expect(vi.mocked(writeFile).mock.calls.map((c) => c[0])).toEqual(["output.mp4"]);
  });

  it("uses an explicit --output verbatim", async () => {
    const { client } = mockClient((url) =>
      url.endsWith("/v1/audio-ducking")
        ? json({ task_id: "ad3", status: "processing" })
        : json({
            task_id: "ad3",
            status: "succeeded",
            output_url: "https://cdn.example.com/ducked.wav",
            output_type: "audio",
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(writeFile).mockClear();

    await runAudioDucking(client, [
      "--voice-url",
      "https://in.example.com/v.wav",
      "--music-url",
      "https://in.example.com/m.wav",
      "--output",
      "mix.wav",
    ]);

    expect(vi.mocked(writeFile).mock.calls.map((c) => c[0])).toEqual(["mix.wav"]);
  });

  it("exits when neither --voice nor --voice-url is given", async () => {
    const { client } = mockClient(() => json({}));
    mockExit();
    await expect(
      runAudioDucking(client, ["--music-url", "https://x/m.wav"]),
    ).rejects.toThrow("process.exit");
  });

  it("exits when neither --music nor --music-url is given", async () => {
    const { client } = mockClient(() => json({}));
    mockExit();
    await expect(
      runAudioDucking(client, ["--voice-url", "https://x/v.wav"]),
    ).rejects.toThrow("process.exit");
  });

  it("rejects a local --music file with a video extension before any request", async () => {
    const { client, calls } = mockClient(() => json({}));
    mockExit();
    await expect(
      runAudioDucking(client, [
        "--voice-url",
        "https://x/v.wav",
        "--music",
        "background.mp4",
      ]),
    ).rejects.toThrow("process.exit");
    expect(calls).toHaveLength(0);
  });

  it("rejects a local --music file with an unrecognized extension", async () => {
    const { client, calls } = mockClient(() => json({}));
    mockExit();
    await expect(
      runAudioDucking(client, [
        "--voice-url",
        "https://x/v.wav",
        "--music",
        "background.xyz",
      ]),
    ).rejects.toThrow("process.exit");
    expect(calls).toHaveLength(0);
  });
});
