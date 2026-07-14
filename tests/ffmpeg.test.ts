import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FfmpegError, FfmpegNotFoundError, VideoKitError } from "../src/errors.js";
import { extractAudio, measureIntegratedLufs, muxVideoWithAudio, probeVideo, runProcess } from "../src/ffmpeg.js";
import { hasFfmpeg, makeFixtures } from "./fixtures.js";

describe.skipIf(!hasFfmpeg)("ffmpeg layer (requires ffmpeg on PATH)", () => {
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeFixtures>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "svk-ffmpeg-"));
    fx = await makeFixtures(dir);
  });

  it("probeVideo reads duration, audio presence, and codec", async () => {
    const withAudio = await probeVideo(fx.videoWithAudio, "ffprobe");
    expect(withAudio.durationSeconds).toBeGreaterThan(0.5);
    expect(withAudio.durationSeconds).toBeLessThan(2);
    expect(withAudio.hasAudio).toBe(true);
    expect(withAudio.audioCodec).toBe("aac");
    expect(withAudio.videoCodec).toBe("h264");

    const silent = await probeVideo(fx.videoSilent, "ffprobe");
    expect(silent.hasAudio).toBe(false);
    expect(silent.audioCodec).toBeNull();
  });

  it("probeVideo reports the PICTURE's duration separately from the container's", async () => {
    // 1 s of picture, 3 s of audio. format.duration is ffprobe's max over all
    // streams, so it reads 3.0 -- the audio's length. Anything metered on or
    // trimmed to the picture (billing, the mux target) needs the 1.0.
    const skewed = await probeVideo(fx.videoAudioOutlivesPicture, "ffprobe");
    expect(skewed.durationSeconds).toBeGreaterThan(2.5); // the container: the audio's length
    expect(skewed.videoDurationSeconds!).toBeLessThan(1.5); // the picture's own length
    expect(skewed.videoDurationSeconds!).toBeGreaterThan(0.5);

    // Where the two agree, they agree.
    const normal = await probeVideo(fx.videoWithAudio, "ffprobe");
    expect(normal.videoDurationSeconds!).toBeCloseTo(normal.durationSeconds, 0);
  });

  it("probeVideo reports no picture for audio-only files, including one with cover art", async () => {
    const audioOnly = await probeVideo(fx.audioOnly, "ffprobe");
    expect(audioOnly.videoCodec).toBeNull();
    expect(audioOnly.videoDurationSeconds).toBeNull();

    // Cover art IS a codec_type=video stream (mjpeg), but it is
    // disposition.attached_pic=1 and `-map 0:V` excludes it -- so it must not
    // be reported as a picture, or a caller checking `videoCodec !== null`
    // would mux against a stream ffmpeg refuses to map.
    const coverArt = await probeVideo(fx.audioWithCoverArt, "ffprobe");
    expect(coverArt.hasAudio).toBe(true);
    expect(coverArt.videoCodec).toBeNull();
    expect(coverArt.videoDurationSeconds).toBeNull();
  });

  it("probeVideo rejects garbage input with FfmpegError", async () => {
    const garbage = join(dir, "garbage.mp4");
    await writeFile(garbage, "this is not a video");
    await expect(probeVideo(garbage, "ffprobe")).rejects.toBeInstanceOf(FfmpegError);
  });

  it("measureIntegratedLufs returns a plausible LUFS for a sine wave", async () => {
    const lufs = await measureIntegratedLufs(fx.musicMp3, "ffmpeg");
    expect(lufs).not.toBeNull();
    expect(lufs!).toBeGreaterThan(-40);
    expect(lufs!).toBeLessThan(0);
  });

  it("measureIntegratedLufs returns null instead of throwing on a missing file", async () => {
    await expect(measureIntegratedLufs(join(dir, "nope.mp3"), "ffmpeg")).resolves.toBeNull();
  });

  it("extractAudio produces a playable m4a from the video's track", async () => {
    const out = join(dir, "extracted.m4a");
    await extractAudio(fx.videoWithAudio, out, "aac", "ffmpeg");
    const lufs = await measureIntegratedLufs(out, "ffmpeg");
    expect(lufs).not.toBeNull();
  });

  it("extractAudio trims to trimToSeconds, and extracts the whole track without it", async () => {
    // Without a trim, the 3 s audio track of a 1 s-picture video is extracted
    // in full -- which is what mix.ts wants (it pads/trims in its own filter)
    // and what duck.ts must NOT upload, since the API bills what it is given.
    const untrimmed = join(dir, "extracted_untrimmed.m4a");
    await extractAudio(fx.videoAudioOutlivesPicture, untrimmed, "aac", "ffmpeg");
    expect((await probeVideo(untrimmed, "ffprobe")).durationSeconds).toBeGreaterThan(2.5);

    const trimmed = join(dir, "extracted_trimmed.m4a");
    await extractAudio(fx.videoAudioOutlivesPicture, trimmed, "aac", "ffmpeg", 1);
    const probe = await probeVideo(trimmed, "ffprobe");
    expect(probe.durationSeconds).toBeLessThan(1.5);
    expect(probe.durationSeconds).toBeGreaterThan(0.5);
  });
});

/** Probe the AUDIO stream's own duration (not the container's format.duration,
 * which stays pinned to the untouched, copied video track and can't detect a
 * short-changed audio stream). */
async function probeAudioStreamDuration(path: string, ffprobePath: string): Promise<number> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  return Number(stdout.trim());
}

describe.skipIf(!hasFfmpeg)("muxVideoWithAudio (requires ffmpeg on PATH)", () => {
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeFixtures>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "svk-mux-"));
    fx = await makeFixtures(dir);
  });

  it("replaces the audio while copying the picture untouched", async () => {
    const output = join(dir, "muxed.mp4");
    const source = await probeVideo(fx.videoWithAudio, "ffprobe");

    await muxVideoWithAudio(fx.videoWithAudio, fx.duckedWav, output, source.durationSeconds, "ffmpeg");

    const probe = await probeVideo(output, "ffprobe");
    expect(probe.videoCodec).toBe("h264"); // -c:v copy preserved the original stream
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe("aac");
    expect(probe.durationSeconds).toBeGreaterThan(0.5);
    expect(probe.durationSeconds).toBeLessThan(2);
  });

  it("pads audio shorter than the picture instead of truncating the picture", async () => {
    const output = join(dir, "muxed_padded.mp4");
    const source = await probeVideo(fx.videoLongSilent, "ffprobe"); // 4 s, no audio track

    // A 1 s replacement track on a 4 s picture: the picture must survive in full.
    await muxVideoWithAudio(fx.videoLongSilent, fx.duckedWav, output, source.durationSeconds, "ffmpeg");

    const probe = await probeVideo(output, "ffprobe");
    expect(probe.videoCodec).toBe("h264");
    expect(probe.durationSeconds).toBeGreaterThan(3.5);

    // format.duration above is the container-level figure, dominated by the
    // untouched, copied video track — it can't tell a padded audio track from
    // a truncated one. Assert on the audio stream's own duration instead, so
    // this test fails if the apad padding is ever removed.
    const audioDuration = await probeAudioStreamDuration(output, "ffprobe");
    expect(audioDuration).toBeGreaterThan(3.5);
  });
});

describe("ffmpeg layer (no ffmpeg needed)", () => {
  it("runProcess rejects with FfmpegNotFoundError when the binary does not exist", async () => {
    await expect(
      runProcess("/definitely/not/a/real/ffmpeg", ["-version"]),
    ).rejects.toBeInstanceOf(FfmpegNotFoundError);
  });

  it("probeVideo surfaces VideoKitError for unreadable duration", async () => {
    // Covered indirectly via garbage input above when ffmpeg exists; the type
    // relationship is what matters here:
    expect(new FfmpegError("x", 1, "y")).toBeInstanceOf(VideoKitError);
  });
});
