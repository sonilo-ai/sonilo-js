import { access, mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Every mkdtemp(tmpdir(), "sonilo-video-kit-duck-") entry currently in tmpdir(). */
async function duckWorkDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith("sonilo-video-kit-duck-"));
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

  it("rejects when audio is missing", async () => {
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: new Uint8Array(0),
        output: join(dir, "never_no_audio.mp4"),
        client,
      }),
    ).rejects.toThrow(/audio is required/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
  });

  it("rejects when the API returns an output_type other than audio", async () => {
    const { client } = stubClient({
      status: "succeeded",
      output_url: "https://r2.example/ducked.wav",
      output_type: "video",
    });

    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: fx.musicMp3,
        output: join(dir, "never_wrong_output_type.mp4"),
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(/output_type "video"/);
  });

  it("cleans up the temp work directory on both success and failure", async () => {
    const before = await duckWorkDirs();

    const { client: okClient } = stubClient();
    await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output: join(dir, "cleanup_success.mp4"),
      client: okClient,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    });
    expect(await duckWorkDirs()).toEqual(before);

    const { client: failClient } = stubClient({
      status: "failed",
      error: { code: "DUCKING_FAILED", message: "audio processing failed" },
      refunded: true,
    });
    await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output: join(dir, "cleanup_failure.mp4"),
      client: failClient,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch(() => {});
    expect(await duckWorkDirs()).toEqual(before);
  });

  it("preserves the paid-for ducked mix and leaves no file at output when the local mux fails", async () => {
    // h264 (the fixture's video codec) cannot be copied into a WebM
    // container: ffmpeg's webm muxer only accepts VP8/VP9/AV1. `-c:v copy`
    // therefore fails at the mux step specifically -- probing and audio
    // extraction don't touch `output`'s extension, so nothing upstream of
    // the mux call can fail this way. Confirmed manually: `ffmpeg -i
    // <h264 mp4> -i <wav> -c:v copy -c:a aac out.webm` exits non-zero with
    // "Only VP8 or VP9 or AV1 video ... are supported for WebM."
    const output = join(dir, "impossible_container.webm");
    const { client } = stubClient();

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    const recoveredPath = `${output}.ducked.wav`;
    expect((err as VideoKitError).message).toContain(recoveredPath);
    // Confirms the failure was attributed to the mux step, not placement --
    // load-bearing for the "placement failure" tests below, which assert the
    // opposite stage name to prove the mux actually ran and succeeded.
    expect((err as VideoKitError).message).toContain("Muxing the ducked audio onto");

    expect(await exists(output)).toBe(false); // no corrupt/truncated file at output
    expect(await exists(recoveredPath)).toBe(true); // the paid-for mix survives
    expect(new Uint8Array(await readFile(recoveredPath))).toEqual(ducked);
  });

  it("preserves the paid-for ducked mix and leaves no file at output when placing the finished mix fails (mux succeeds)", async () => {
    // Force a failure at the placement step specifically, after a
    // successful mux: make `output` an already-existing *directory*. The
    // mux writes into workDir (unaffected by output's directory), so it
    // completes fine; placeAtomically's copyFile into a sibling temp file
    // (in the same, real, directory as output) also succeeds; only the
    // final `rename(tempPath, output)` fails, with EISDIR, since you cannot
    // rename a file onto an existing directory. Because output's directory
    // genuinely exists, the rescue copy to `${output}.ducked.wav` (a
    // sibling of `output`, in that same real directory) can still succeed
    // -- so this test proves the rescue path itself works, not just that
    // finding 3 (rescue-also-fails) kicks in.
    const output = join(dir, "already_a_directory.mp4");
    await mkdir(output);
    const { client } = stubClient();

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    const recoveredPath = `${output}.ducked.wav`;
    expect((err as VideoKitError).message).toContain(recoveredPath);
    // Proves the mux itself succeeded and only placement failed: if the mux
    // had failed instead, the message would say "Muxing the ducked audio
    // onto", not this.
    expect((err as VideoKitError).message).toContain("Placing the finished mix at");

    expect((await stat(output)).isDirectory()).toBe(true); // untouched -- no file was ever placed there
    expect(await exists(recoveredPath)).toBe(true); // the paid-for mix survives
    expect(new Uint8Array(await readFile(recoveredPath))).toEqual(ducked);
  });

  it("throws an informative VideoKitError naming the charge, not a bare fs error, when the rescue copy also fails", async () => {
    // Force placement AND the rescue to both fail: point `output` inside a
    // directory that does not exist at all. The mux still succeeds (it only
    // depends on workDir and output's extension). placeAtomically then
    // fails opening the sibling temp file (ENOENT, missing directory), and
    // the rescue copy -- which writes `${output}.ducked.wav` into that same
    // missing directory -- fails for the same reason. This is finding 3:
    // the rescue failing must not surface a raw ENOENT that mentions
    // neither the original failure nor the fact the API call was billed.
    const output = join(dir, "does_not_exist_at_all", "ducked.mp4");
    const recoveredPath = `${output}.ducked.wav`;
    const { client } = stubClient();

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    const message = (err as VideoKitError).message;
    // Proves the mux succeeded and placement (not muxing) is what failed.
    expect(message).toContain("Placing the finished mix at");
    // Proves the rescue-also-failed branch ran, and that it still names the
    // charge instead of silently dropping context.
    expect(message).toContain("ALSO failed");
    expect(message).toMatch(/charge/i);
    expect(message).toContain(recoveredPath);

    expect(await exists(output)).toBe(false);
    expect(await exists(recoveredPath)).toBe(false); // rescue genuinely failed -- nothing was written there
  });
});
