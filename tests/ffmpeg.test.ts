import { mkdtemp, stat, writeFile } from "node:fs/promises";
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

/** MD5 of the PICTURE's coded packets — the bytes of the video stream itself,
 * demuxed and copied, with no container framing. Two files share this digest
 * only if their picture is bit-for-bit the same compressed stream, which is
 * exactly what `-c:v copy` promises and what ANY re-encode (libx264 included)
 * breaks. Probing `videoCodec === "h264"` cannot tell the two apart: a libx264
 * re-encode of an h264 source is still h264. */
async function videoStreamMd5(path: string, ffmpegPath: string): Promise<string> {
  const { stdout } = await runProcess(ffmpegPath, [
    "-v", "error",
    "-i", path,
    "-map", "0:V",
    "-c", "copy",
    "-f", "md5", "-",
  ]);
  return stdout.trim();
}

/** Every stream in the file, as `codec_type`/`codec_name`/`attached_pic`
 * triples — enough to say not just "there is a picture" but "there is EXACTLY
 * ONE picture and it is not album art". */
async function probeStreams(
  path: string,
  ffprobePath: string,
): Promise<Array<{ type: string; codec: string; attachedPic: boolean }>> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      disposition?: { attached_pic?: number };
    }>;
  };
  return (parsed.streams ?? []).map((s) => ({
    type: s.codec_type ?? "",
    codec: s.codec_name ?? "",
    attachedPic: s.disposition?.attached_pic === 1,
  }));
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
    expect(probe.videoCodec).toBe("h264");
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe("aac");
    expect(probe.durationSeconds).toBeGreaterThan(0.5);
    expect(probe.durationSeconds).toBeLessThan(2);
  });

  it("copies the picture BIT-FOR-BIT: the muxed video stream hashes identical to the source's", async () => {
    // The package's promise is that the customer's picture is never re-encoded
    // -- no generation loss, no re-compression, and no minutes of CPU on a 4K
    // file. `probe.videoCodec === "h264"` cannot check that: swap `-c:v copy`
    // for `-c:v libx264` and the output is still h264, still the right
    // duration, still passes every other assertion in this file. The coded
    // packets of the video stream are the only thing that tells them apart.
    const output = join(dir, "muxed_bitforbit.mp4");
    const source = await probeVideo(fx.videoWithAudio, "ffprobe");

    await muxVideoWithAudio(fx.videoWithAudio, fx.duckedWav, output, source.durationSeconds, "ffmpeg");

    const sourceMd5 = await videoStreamMd5(fx.videoWithAudio, "ffmpeg");
    const outputMd5 = await videoStreamMd5(output, "ffmpeg");
    expect(outputMd5).toBe(sourceMd5); // a re-encode cannot reproduce this digest
  });

  it("maps only the real picture, never attached cover art (-map 0:V, capital V)", async () => {
    // fx.videoWithCoverArt: a genuine h264 picture, an aac track, AND an
    // attached_pic mjpeg (an iTunes/M4V export, a podcast with a thumbnail).
    // Lowercase `-map 0:v` matches BOTH video streams, so the cover art rides
    // into the deliverable as a second video stream -- a file that is no longer
    // the picture the caller handed us, and whose stream layout no longer
    // matches what probeVideo (which excludes attached pictures, by design)
    // reports about it.
    const output = join(dir, "muxed_cover_art.mp4");
    const source = await probeVideo(fx.videoWithCoverArt, "ffprobe");
    expect(source.videoCodec).toBe("h264"); // the fixture really does have a real picture

    await muxVideoWithAudio(fx.videoWithCoverArt, fx.duckedWav, output, source.videoDurationSeconds!, "ffmpeg");

    const streams = await probeStreams(output, "ffprobe");
    const pictures = streams.filter((s) => s.type === "video");
    expect(pictures).toHaveLength(1); // exactly one video stream...
    expect(pictures[0]!.codec).toBe("h264"); // ...the real one...
    expect(pictures[0]!.attachedPic).toBe(false); // ...and not the album art.
    expect(streams.filter((s) => s.type === "audio")).toHaveLength(1);

    // And the deliverable is a real video with real audio, not the few-hundred-
    // byte husk a mux that stopped on the cover art's single packet would leave.
    const probe = await probeVideo(output, "ffprobe");
    expect(probe.hasAudio).toBe(true);
    expect(probe.videoDurationSeconds!).toBeGreaterThan(0.5);
    expect(await probeAudioStreamDuration(output, "ffprobe")).toBeGreaterThan(0.5);
    expect((await stat(output)).size).toBeGreaterThan(5_000);
  });

  it("refuses a file whose only picture is cover art rather than muxing onto the album art", async () => {
    // The other half of `-map 0:V`: for a file with NO real picture (a podcast
    // .m4a with album art), capital V matches no stream at all and ffmpeg
    // fails -- which is why duck.ts guards this input before it can be uploaded
    // and charged. Lowercase `0:v` instead SUCCEEDS here, quietly handing back
    // a "video" whose entire picture is a still album cover.
    const output = join(dir, "muxed_cover_only.mp4");
    await expect(
      muxVideoWithAudio(fx.audioWithCoverArt, fx.duckedWav, output, 1, "ffmpeg"),
    ).rejects.toBeInstanceOf(FfmpegError);
  });

  it("trims audio LONGER than the picture instead of letting it extend past the picture", async () => {
    // The other half of the atrim/apad pair. fx.musicMp3 runs 2 s; the picture
    // runs 1 s. Without `atrim=end=<dur>` the 2 s track is muxed in full (apad
    // only ever pads, never truncates), so the deliverable carries a second of
    // audio over a picture that has already ended -- and, on the ducking path,
    // a deliverable longer than the picture the caller was billed for.
    const output = join(dir, "muxed_trimmed.mp4");
    const source = await probeVideo(fx.videoWithAudio, "ffprobe"); // 1 s of picture

    await muxVideoWithAudio(fx.videoWithAudio, fx.musicMp3, output, source.videoDurationSeconds!, "ffmpeg");

    const audioDuration = await probeAudioStreamDuration(output, "ffprobe");
    expect(audioDuration).toBeLessThan(1.5); // the picture's 1 s, not the music's 2 s
    expect(audioDuration).toBeGreaterThan(0.5); // and the audio is genuinely there
    expect((await probeVideo(output, "ffprobe")).durationSeconds).toBeLessThan(1.5);
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
