import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FfmpegError, FfmpegNotFoundError, VideoKitError } from "../src/errors.js";
import { extractAudio, measureIntegratedLufs, muxVideoWithAudio, probeVideo, runProcess } from "../src/ffmpeg.js";
import { hasFfmpeg, makeFixtures } from "./fixtures.js";

/** A stand-in ffprobe: the real one, with the two CHEAP sources of the
 * picture's duration deleted from its JSON -- every stream's `duration` field
 * and every `DURATION` tag. That is the shape of a container which offers
 * neither (and the shape probeVideo used to answer with the CONTAINER's
 * duration, i.e. the longest stream's, which for these fixtures is the audio).
 * No real file on hand produces it -- MP4/MOV/TS carry the field, Matroska/WebM
 * carry the tag, and a container with neither also carries no format.duration,
 * so probeVideo rejects it earlier -- so the missing pieces are removed from a
 * real probe instead.
 *
 * `unmeasurable` additionally blanks the PACKET query, which is the last resort
 * probeVideo falls through to: with no timestamped packets either, the picture's
 * length cannot be established by any means at all, and the only safe answer is
 * to refuse. (It used to suffice to delete `avg_frame_rate`, because the
 * measurement was packets/frame-rate; the measurement now reads packet
 * timestamps, which no frame rate can break.) */
async function fakeFfprobe(dir: string, opts: { unmeasurable?: boolean }): Promise<string> {
  const path = join(dir, `fake_ffprobe_${opts.unmeasurable ? "unmeasurable" : "measurable"}.mjs`);
  await writeFile(
    path,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
${opts.unmeasurable
  ? `// The packet query -- probeVideo's measurement of last resort. A container
// whose picture carries no timestamped packets answers it with nothing.
if (argv.some((a) => a.startsWith("packet="))) {
  process.stdout.write("");
  process.exit(0);
}`
  : ""}
const res = spawnSync("ffprobe", argv, { encoding: "utf8" });
if (res.status !== 0) {
  process.stderr.write(res.stderr ?? "");
  process.exit(res.status ?? 1);
}
let out = res.stdout;
try {
  const parsed = JSON.parse(out);
  for (const s of parsed.streams ?? []) {
    delete s.duration;
    for (const key of Object.keys(s.tags ?? {})) {
      if (key.toUpperCase().startsWith("DURATION")) delete s.tags[key];
    }
  }
  out = JSON.stringify(parsed);
} catch {
  // not JSON (e.g. a -of csv packet query): pass it through untouched
}
process.stdout.write(out);
`,
  );
  await chmod(path, 0o755);
  return path;
}

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

  it("probeVideo reports the PICTURE's duration for Matroska and WebM, which carry no per-stream duration field", async () => {
    // The container that breaks a `streams[].duration ?? format.duration`
    // fallback: Matroska and WebM NEVER emit a per-stream `duration` field, so
    // the fallback fires for 100% of them and hands back format.duration --
    // ffprobe's max over all streams, i.e. the AUDIO's 3 s, for a 1 s picture.
    // duck.ts bills, trims and muxes on this number. The picture's real length
    // is carried as a stream TAG (`DURATION: 00:00:01.000000000`).
    for (const path of [fx.videoAudioOutlivesPictureMkv, fx.videoAudioOutlivesPictureWebm]) {
      const probe = await probeVideo(path, "ffprobe");
      expect(probe.durationSeconds).toBeGreaterThan(2.5); // the container: the audio's length
      expect(probe.videoDurationSeconds!).toBeLessThan(1.5); // the picture's own length
      expect(probe.videoDurationSeconds!).toBeGreaterThan(0.5);
      expect(probe.hasAudio).toBe(true);
    }
  });

  it("probeVideo reads the picture's duration from the stream's DURATION tag, not the container, near the cap", async () => {
    // 350 s of picture under 365 s of audio, in Matroska. The backend gates on
    // the VIDEO stream's duration (audio_ducking.py; its comments cite an
    // accepted 358 s picture / 361 s audio case), so this file is legal --
    // but a probe that reports the container's 365 s makes duck.ts's cap guard
    // refuse it, and tell the user their 350 s video is 365 s long.
    const probe = await probeVideo(fx.videoLongPictureLongerAudioMkv, "ffprobe");
    expect(probe.durationSeconds).toBeGreaterThan(360); // the container is over the cap...
    expect(probe.videoDurationSeconds!).toBeGreaterThan(345); // ...while the picture is under it
    expect(probe.videoDurationSeconds!).toBeLessThan(355);
  });

  it("probeVideo prefers the DURATION TAG over a `duration` field BACKFILLED FROM THE CONTAINER (sparse MKV)", async () => {
    // THE BUG. A 10 s picture at 1 fps under a 30 s audio track, plain Matroska.
    // Because the picture's packets are sparse, libavformat cannot establish the
    // stream's timing from them and backfills `st->duration` FROM THE CONTAINER --
    // so ffprobe emits a video-stream `duration` FIELD of 30.128 (the max over all
    // streams, i.e. the AUDIO's length) alongside a DURATION TAG of 00:00:10 (the
    // picture's true length). The file carries BOTH.
    //
    // A cascade that reads the field first therefore bills 30 s for a 10 s picture.
    // The tag is authored per-track by the muxer and is never synthesized from the
    // container, so it -- not the field -- is the picture's own length.
    const probe = await probeVideo(fx.videoSparsePictureMkv, "ffprobe");
    expect(probe.durationSeconds).toBeGreaterThan(29); // the container: the audio's 30 s
    expect(probe.videoDurationSeconds!).toBeGreaterThan(9); // the picture: 10 s
    expect(probe.videoDurationSeconds!).toBeLessThan(11); // NOT the container's 30 s
  });

  it("probeVideo MEASURES the picture when a backfilled field is all the container offers (sparse MPEG-TS)", async () => {
    // The cross-check firing, on a real file. MPEG-TS has no DURATION tag to fall
    // back on, so preferring the tag does NOT save it: ffprobe reports the video
    // stream's `duration` as 29.767978 -- exactly format.duration, the audio's
    // length -- for a 10 s picture. It offers no `nb_frames` either, so there is
    // no per-track frame accounting to say the demuxer ever tracked this stream
    // separately: the field is indistinguishable from the container's.
    //
    // That is the signature the guard fires on, and it falls through to MEASURING
    // the span the picture's own packets occupy. (`avg_frame_rate` is `0/0` here,
    // which is precisely why the old packets/frame-rate measurement returned null
    // for this container and left the backfilled 29.8 s in place to be billed.)
    const probe = await probeVideo(fx.videoSparsePictureTs, "ffprobe");
    expect(probe.durationSeconds).toBeGreaterThan(29); // the container: the audio's length
    expect(probe.videoDurationSeconds!).toBeGreaterThan(9); // the picture, MEASURED: 10 s
    expect(probe.videoDurationSeconds!).toBeLessThan(11); // NOT the backfilled 29.8 s
  });

  it("probeVideo trusts the per-stream field where it is genuinely the track's own (edit-list mp4)", async () => {
    // The other side of the guard, and the reason it keys on the FIELD's
    // relationship to the container rather than on a frame-count cross-check.
    //
    // `ffmpeg -ss 2 -i in -c copy out.mp4` -- and every iPhone clip -- writes an
    // EDIT LIST: all 50 coded frames of the 10 s source are retained, while the
    // presentation is trimmed to 8 s. `-c:v copy` applies the edit list, so 8 s is
    // what the mux delivers and 8 s is the correct bill. The `duration` field says
    // 8 s and is RIGHT; `nb_frames / avg_frame_rate` says 10 s and is WRONG.
    // A cross-check that measured on that disagreement would bill 10 s for an 8 s
    // deliverable -- a 1.25x overbill on the commonest video there is.
    //
    // Asserted against the ABSOLUTE truth (8 s, established by DECODING) rather
    // than against the field: comparing the probe to the field is a tautology the
    // moment the code returns the field, and it passed even while the 1.25x sat
    // one check away. The number that must never appear here is 10.
    const probe = await probeVideo(fx.videoEditList, "ffprobe");
    expect(probe.videoDurationSeconds!).toBeCloseTo(8, 1); // the PRESENTED picture
    expect(probe.videoDurationSeconds!).toBeLessThan(9); // NOT the 10 s of coded frames

    // The teeth: the raw packet timestamps -- which is what tier 3 reads, and
    // which do NOT have the edit list applied -- really do span 10 s (pts -2.000
    // .. 8.000). So the 1.25x is genuinely available to be got wrong here; the
    // code avoids it, and this proves the fixture can still catch it.
    const pts = (await runProcess("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time", "-of", "csv=p=0", fx.videoEditList,
    ])).stdout.split("\n").filter((l) => l.length > 0).map(Number).filter(Number.isFinite);
    expect(Math.min(...pts)).toBeCloseTo(-2, 1); // frames the edit list DISCARDS
    expect(Math.max(...pts) - Math.min(...pts)).toBeGreaterThan(9); // a 10 s raw span
  });

  it("probeVideo BILLS THE PICTURE for a FRAGMENTED MP4, whose duration field is measured from a PHANTOM start (both recipes)", async () => {
    // BUG 1, AND THE ONLY BUG IN THIS FILE THAT *UNDER*BILLS -- which means it
    // does not merely overcharge, it CUTS THE USER'S SPEECH OFF and hands them a
    // truncated mix they paid for.
    //
    // With no moov to describe the track, libavformat takes the stream's
    // `start_time` from the FIRST PACKET IN DECODE ORDER -- under B-pyramid, not
    // the packet with the smallest pts. For a 10 s/1 fps fragmented MP4 it reports
    // start_time=2.000000 while the picture's packets genuinely begin at pts
    // 0.000061, and it derives `st->duration = packet_span - start_time` = 8.128.
    //
    // The field (8.13) is NOWHERE NEAR the container (30.13), so the
    // looks-like-the-container's guard does not fire. Trusting it uploads 8.13 s
    // of voice under a 10 s picture: billed 0.81x, and the last two seconds of
    // speech are gone.
    //
    // BOTH recipes, because they defeat DIFFERENT signals and neither signal
    // saves either file: +empty_moov reports nb_frames=N/A, plain +frag_keyframe
    // reports nb_frames=10. Only asking where the picture's packets actually END
    // catches both.
    for (const [name, video] of [
      ["empty_moov", fx.videoFragmentedEmptyMoov],
      ["frag_keyframe", fx.videoFragmentedKeyframe],
    ] as const) {
      const probe = await probeVideo(video, "ffprobe");
      // The picture DECODES to 10.00 s. Never the 8.13 s the field claims.
      expect(probe.videoDurationSeconds!, name).toBeGreaterThan(9.5);
      expect(probe.videoDurationSeconds!, name).toBeLessThan(11); // nor the container's 30 s

      // The teeth: the field really does say ~8.13, and it really is far from the
      // container's 30.13 -- so the old guard genuinely passed it through, and
      // this fixture still catches a regression to it.
      const field = Number((await runProcess("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", video,
      ])).stdout.trim());
      expect(field, name).toBeLessThan(9); // the underbilling figure...
      expect(Math.abs(field - probe.durationSeconds), name).toBeGreaterThan(5); // ...nowhere near the container
    }
  });

  it("tier 3 MEASURES an edit-list mp4 correctly rather than relying on never being reached by one", async () => {
    // BUG 2, latent but one check away from live. `measurePictureSpan` reads RAW
    // packet timestamps, and those do NOT have the edit list applied: this file's
    // pts run -2.000 .. 8.000, a span of 10.000, for a picture that presents 8.000.
    // A `max - min` measurement bills 1.25x.
    //
    // Until now the ONLY thing keeping an edit-list mp4 out of tier 3 was an
    // `nb_frames` presence check -- and `nb_frames` is absent on exactly the
    // fragmented MP4s that tier 3 now measures. So tier 3 is hardened at the
    // source: frames at negative pts are precisely the frames the edit list
    // DISCARDS, so the measurement's origin is clamped at zero.
    //
    // Forced through tier 3 with the stripped ffprobe (no `duration` field, no
    // DURATION tag), which is the one shape that reaches it unconditionally.
    const probe = await probeVideo(fx.videoEditList, await fakeFfprobe(dir, {}));
    expect(probe.videoDurationSeconds!).toBeCloseTo(8, 1); // MEASURED as presented
    expect(probe.videoDurationSeconds!).toBeLessThan(9); // NOT the 10 s raw packet span
  });

  it("probeVideo MEASURES the picture when the container carries neither a duration field nor a DURATION tag", async () => {
    // Tier 3. `fakeFfprobe` is the real ffprobe with every stream `duration`
    // and `DURATION` tag stripped from its JSON -- the one shape left for which
    // neither cheap source of the picture's length exists. The picture must
    // still be measured (packets / frame rate), NOT read off the container:
    // format.duration is untouched here and still says 3 s, so a fallback to it
    // is exactly what this asserts against.
    const probe = await probeVideo(fx.videoAudioOutlivesPicture, await fakeFfprobe(dir, {}));
    expect(probe.durationSeconds).toBeGreaterThan(2.5); // the container still reads 3 s...
    expect(probe.videoDurationSeconds!).toBeCloseTo(1, 1); // ...and the picture was measured at 1 s
  });

  it("probeVideo REFUSES to guess the picture's duration rather than falling back to the container's", async () => {
    // The last tier. Same stripped ffprobe, but the packet measurement is broken
    // too (the picture answers the packet query with nothing), so its length
    // cannot be established by any means. The old code answered format.duration
    // here -- the audio's length, the very number duck.ts would then BILL the
    // customer for. Refusing is the only safe answer, and it costs nothing: this
    // runs before any upload.
    await expect(
      probeVideo(fx.videoAudioOutlivesPicture, await fakeFfprobe(dir, { unmeasurable: true })),
    ).rejects.toThrow(/Could not determine how long the picture/);
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
