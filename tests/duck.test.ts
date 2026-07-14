import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DuckingClient } from "../src/ducking-api.js";
import { duckMusicUnderSpeech, MAX_DUCKING_DURATION_SECONDS } from "../src/duck.js";
import { DuckingFailedError, VideoKitError } from "../src/errors.js";
import { probeVideo } from "../src/ffmpeg.js";
import { hasFfmpeg, makeFixtures } from "./fixtures.js";

/** Stub client: 202 on submit, then one `succeeded` poll. Records every call. */
function stubClient(taskBody: Record<string, unknown> = {
  status: "succeeded",
  output_url: "https://r2.example/ducked.wav",
  output_type: "audio",
}) {
  const calls: string[] = [];
  const client: DuckingClient = {
    async request(path) {
      calls.push(path);
      const body = path === "/v1/audio-ducking"
        ? { task_id: "t_1", status: "processing" }
        : taskBody;
      return new Response(JSON.stringify(body), {
        status: path === "/v1/audio-ducking" ? 202 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { client, calls };
}

/** Stub download: hands back the fixture wav, standing in for the R2 object. */
function stubFetch(bytes: Uint8Array) {
  return (async () => new Response(bytes)) as unknown as typeof globalThis.fetch;
}

describe.skipIf(!hasFfmpeg)("duckMusicUnderSpeech (requires ffmpeg on PATH)", () => {
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeFixtures>>;
  let ducked: Uint8Array;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "svk-duck-"));
    fx = await makeFixtures(dir);
    ducked = new Uint8Array(await readFile(fx.duckedWav));
  });

  it("submits, polls, downloads, and re-muxes onto the original picture", async () => {
    const output = join(dir, "ducked.mp4");
    const { client, calls } = stubClient();

    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: fx.musicMp3,
        output,
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).resolves.toBe(output);

    expect(calls).toEqual(["/v1/audio-ducking", "/v1/tasks/t_1"]);
    const probe = await probeVideo(output, "ffprobe");
    expect(probe.videoCodec).toBe("h264"); // the picture was copied, never re-encoded
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe("aac");
  });

  it("accepts music as raw Track.audio bytes", async () => {
    const output = join(dir, "ducked_bytes.mp4");
    const { client } = stubClient();

    await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: new Uint8Array(await readFile(fx.musicMp3)),
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    });

    expect((await probeVideo(output, "ffprobe")).hasAudio).toBe(true);
  });

  it("rejects a video with no audio track before calling the API", async () => {
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoSilent,
        audio: fx.musicMp3,
        output: join(dir, "never.mp4"),
        client,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(/no audio track/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
  });

  it("rejects a video longer than the API's cap before calling the API", async () => {
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoTooLong,
        audio: fx.musicMp3,
        output: join(dir, "never.mp4"),
        client,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(new RegExp(`${MAX_DUCKING_DURATION_SECONDS}`));
    expect(calls).toEqual([]);
  });

  it("surfaces a failed task as DuckingFailedError with the refund flag", async () => {
    const { client } = stubClient({
      status: "failed",
      error: { code: "DUCKING_FAILED", message: "audio processing failed" },
      refunded: true,
    });

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output: join(dir, "failed.mp4"),
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DuckingFailedError);
    expect((err as DuckingFailedError).refunded).toBe(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the video error, not a missing-API-key error, when no client is given and SONILO_API_KEY is unset", async () => {
    vi.stubEnv("SONILO_API_KEY", "");
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoSilent,
        audio: fx.musicMp3,
        output: join(dir, "never_no_client.mp4"),
      }),
    ).rejects.toThrow(/no audio track/);
  });

  it("validates its arguments", async () => {
    const { client } = stubClient();
    await expect(
      duckMusicUnderSpeech({ video: "", audio: fx.musicMp3, output: "o.mp4", client }),
    ).rejects.toThrow(VideoKitError);
    await expect(
      duckMusicUnderSpeech({ video: fx.videoWithAudio, audio: fx.musicMp3, output: "", client }),
    ).rejects.toThrow(VideoKitError);
  });
});
