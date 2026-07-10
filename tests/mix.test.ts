import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FfmpegNotFoundError, VideoKitError } from "../src/errors.js";
import { probeVideo } from "../src/ffmpeg.js";
import { mixWithVideo } from "../src/mix.js";
import { hasFfmpeg, makeFixtures } from "./fixtures.js";

describe.skipIf(!hasFfmpeg)("mixWithVideo (requires ffmpeg on PATH)", () => {
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeFixtures>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "svk-mix-"));
    fx = await makeFixtures(dir);
  });

  async function assertRendered(output: string): Promise<void> {
    const probe = await probeVideo(output, "ffprobe");
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe("aac");
    expect(probe.durationSeconds).toBeGreaterThan(0.5);
    expect(probe.durationSeconds).toBeLessThan(2); // capped by -shortest to the 1 s video
  }

  it("mixes music with the original audio (matched path, defaults)", async () => {
    const output = join(dir, "mixed_default.mp4");
    await expect(
      mixWithVideo({ video: fx.videoWithAudio, audio: fx.musicMp3, output }),
    ).resolves.toBe(output);
    await assertRendered(output);
  });

  it("handles a video with no audio track", async () => {
    const output = join(dir, "mixed_silent.mp4");
    await mixWithVideo({ video: fx.videoSilent, audio: fx.musicMp3, output });
    await assertRendered(output);
  });

  it("originalVolume 0 replaces the original audio", async () => {
    const output = join(dir, "mixed_replace.mp4");
    await mixWithVideo({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      originalVolume: 0,
    });
    await assertRendered(output);
  });

  it("accepts music as a Uint8Array", async () => {
    const output = join(dir, "mixed_bytes.mp4");
    const bytes = new Uint8Array(await readFile(fx.musicMp3));
    await mixWithVideo({ video: fx.videoWithAudio, audio: bytes, output });
    await assertRendered(output);
  });

  it("legacy path: loudnessMatch false, normalize false", async () => {
    const output = join(dir, "mixed_legacy.mp4");
    await mixWithVideo({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      loudnessMatch: false,
      normalize: false,
      musicVolume: 0.8,
      originalVolume: 0.5,
    });
    await assertRendered(output);
  });

  it("rejects garbage video input", async () => {
    await expect(
      mixWithVideo({
        video: join(dir, "missing.mp4"),
        audio: fx.musicMp3,
        output: join(dir, "never.mp4"),
      }),
    ).rejects.toBeInstanceOf(VideoKitError);
  });
});

describe("mixWithVideo validation (no ffmpeg needed)", () => {
  it("rejects out-of-range volumes", async () => {
    await expect(
      mixWithVideo({ video: "v.mp4", audio: "a.mp3", output: "o.mp4", musicVolume: 1.5 }),
    ).rejects.toBeInstanceOf(VideoKitError);
    await expect(
      mixWithVideo({ video: "v.mp4", audio: "a.mp3", output: "o.mp4", originalVolume: -0.1 }),
    ).rejects.toBeInstanceOf(VideoKitError);
  });

  it("rejects empty video/output paths", async () => {
    await expect(
      mixWithVideo({ video: "", audio: "a.mp3", output: "o.mp4" }),
    ).rejects.toBeInstanceOf(VideoKitError);
    await expect(
      mixWithVideo({ video: "v.mp4", audio: "a.mp3", output: "" }),
    ).rejects.toBeInstanceOf(VideoKitError);
  });

  it("rejects with FfmpegNotFoundError for a bogus ffprobePath", async () => {
    await expect(
      mixWithVideo({
        video: "v.mp4",
        audio: "a.mp3",
        output: "o.mp4",
        ffprobePath: "/definitely/not/ffprobe",
      }),
    ).rejects.toBeInstanceOf(FfmpegNotFoundError);
  });
});
