import { access, chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DuckingClient } from "../src/ducking-api.js";
import { duckMusicUnderSpeech, MAX_DUCKING_DURATION_SECONDS } from "../src/duck.js";
import { DuckingFailedError, VideoKitError } from "../src/errors.js";
import { extractAudio, probeVideo } from "../src/ffmpeg.js";
import { hasFfmpeg, makeFixtures } from "./fixtures.js";

/** Marker naming the one recovery path this suite deliberately corrupts, so
 * the copyFile shim below can single it out and leave every other copyFile
 * call (placeAtomically's temp-file copy, the normal rescue copy in the
 * other tests, and anything the test file itself does) running against the
 * real filesystem. */
const PARTIAL_RESCUE_MARKER = "partial_rescue_probe";

/** Marker naming the OTHER recovery path this suite corrupts on purpose: the
 * copy that stages the finished mix next to `output` before it is renamed into
 * place. Kept distinct from PARTIAL_RESCUE_MARKER so each test breaks exactly
 * one copy, and every other copyFile in the file runs for real. */
const ATOMIC_PLACEMENT_MARKER = "atomic_placement_probe";

/** Marker naming the THIRD corrupted path: a rescue copy that fails at OPEN,
 * having written nothing at all (the shape of an EACCES, or of the ENOENT a
 * missing output directory used to produce). Distinct from the two above so
 * every test in this file breaks exactly one copy. */
const RESCUE_OPEN_FAILURE_MARKER = "rescue_open_failure_probe";

/** `fs.copyFile` can't be made to fail partway through on demand -- there's
 * no portable way to force ENOSPC mid-stream in a test. To prove that a rescue
 * copy which dies MID-WRITE leaves no partial bytes behind, this shim
 * intercepts only the one copyFile call whose destination carries
 * PARTIAL_RESCUE_MARKER *and* `.ducked.` -- i.e. the rescue's copy, and not the
 * PLACEMENT copy that precedes it, whose destination shares the same output
 * basename. (Without that second condition the shim breaks the placement copy
 * too, so placement fails at the copy rather than at the rename, and the EISDIR
 * mechanism these tests are built on never fires at all.) It writes a short
 * "partial" file and rejects -- exactly the shape a real ENOSPC would leave.
 *
 * A rescue that instead fails at OPEN, writing nothing (RESCUE_OPEN_FAILURE_MARKER),
 * is simulated by rejecting without writing.
 *
 * Every other copyFile call is forwarded to the real implementation, so this
 * does not weaken any other test in the file. */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: vi.fn(async (src: Parameters<typeof actual.copyFile>[0], dest: Parameters<typeof actual.copyFile>[1], ...rest: unknown[]) => {
      if (
        typeof dest === "string" &&
        dest.includes(PARTIAL_RESCUE_MARKER) &&
        dest.includes(".ducked.")
      ) {
        await actual.writeFile(dest, "PARTIAL-DATA-FROM-A-FAILED-COPY");
        throw new Error("simulated ENOSPC partway through the rescue copy");
      }
      if (
        typeof dest === "string" &&
        dest.includes(RESCUE_OPEN_FAILURE_MARKER) &&
        dest.includes(".ducked.")
      ) {
        throw Object.assign(new Error("simulated EACCES opening the rescue copy"), {
          code: "EACCES",
        });
      }
      // The placement copy for an ATOMIC_PLACEMENT_MARKER output, corrupted the
      // same way: partial bytes, then a rejection. `.ducked.` is excluded so the
      // RESCUE copy that follows (which shares the output's basename, marker and
      // all) still runs for real -- the point of that test is what is left at
      // `output`, not whether the rescue works. The condition is deliberately
      // written against the DESTINATION and not against ".tmp": a placement that
      // copies straight onto `output` -- i.e. one that is not atomic -- must be
      // caught by this shim too, or the test could not tell the two apart.
      if (
        typeof dest === "string" &&
        dest.includes(ATOMIC_PLACEMENT_MARKER) &&
        !dest.includes(".ducked.")
      ) {
        await actual.writeFile(dest, "PARTIAL-DATA-FROM-A-FAILED-COPY");
        throw new Error("simulated ENOSPC partway through placing the finished mix");
      }
      return (actual.copyFile as (...a: unknown[]) => Promise<void>)(src, dest, ...rest);
    }),
  };
});

interface Upload {
  filename: string;
  bytes: Uint8Array;
}

/** Stub client: 202 on submit, then one `succeeded` poll. Records every call,
 * and the multipart part actually submitted as `voice_file` -- filename and
 * bytes both. This is the ONLY place the package's central promise can be
 * checked: the picture never leaves the machine, and the ducking API is handed
 * (and bills for) nothing but the extracted audio track. Asserting on what the
 * transport forwards proves nothing about what duck.ts hands it; asserting here
 * does. */
function stubClient(taskBody: Record<string, unknown> = {
  status: "succeeded",
  output_url: "https://r2.example/ducked.wav",
  output_type: "audio",
}) {
  const calls: string[] = [];
  const uploadedVoice: Upload[] = [];
  const client: DuckingClient = {
    async request(path, init) {
      calls.push(path);
      if (path === "/v1/audio-ducking" && init?.body instanceof FormData) {
        const voice = init.body.get("voice_file");
        if (voice instanceof Blob) {
          uploadedVoice.push({
            // A FormData part appended with a filename is a File, whose `name`
            // is the filename the multipart body actually carries.
            filename: voice instanceof File ? voice.name : "",
            bytes: new Uint8Array(await voice.arrayBuffer()),
          });
        }
      }
      const body = path === "/v1/audio-ducking"
        ? { task_id: "t_1", status: "processing" }
        : taskBody;
      return new Response(JSON.stringify(body), {
        status: path === "/v1/audio-ducking" ? 202 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { client, calls, uploadedVoice };
}

/** Like stubClient, but `onPoll` decides what each poll does -- throw the way a
 * real SoniloClient does on a non-2xx, hand back a 5xx, or succeed. The submit
 * always succeeds, so everything it drives happens AFTER the account is
 * charged. */
function pollingClient(onPoll: (attempt: number) => Promise<Response>) {
  const calls: string[] = [];
  let polls = 0;
  const client: DuckingClient = {
    async request(path) {
      calls.push(path);
      if (path === "/v1/audio-ducking") {
        return new Response(JSON.stringify({ task_id: "t_1", status: "processing" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      polls += 1;
      return onPoll(polls);
    },
  };
  return { client, calls };
}

function taskResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The sonilo SDK's APIError shape: an Error carrying a numeric `status`. */
function apiError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}: request failed`), {
    name: "APIError",
    status,
  });
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

/** Every mkdtemp(tmpdir(), "sonilo-video-kit-duck-") entry currently in tmpdir().
 *
 * tmpdir() is SHARED: a concurrent run of this suite, or a crashed earlier one,
 * leaves work dirs behind that have nothing to do with this test. Comparing the
 * whole listing before/after therefore fails for reasons that aren't the code's
 * fault, so callers below assert only on what THIS call added (see newWorkDirs). */
async function duckWorkDirs(): Promise<Set<string>> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  return new Set(entries.filter((e) => e.startsWith("sonilo-video-kit-duck-")));
}

/** Work dirs that appeared since `before` — the only thing a leak test can
 * soundly attribute to the code under test. Strays left by other runs are
 * present in both snapshots and so cancel out. */
async function newWorkDirs(before: Set<string>): Promise<string[]> {
  return [...(await duckWorkDirs())].filter((d) => !before.has(d));
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

  it("uploads the extracted AUDIO TRACK and never the picture", async () => {
    // The package's loudest promise -- "your picture never leaves your machine"
    // (README; the docstring on duckMusicUnderSpeech) -- and the only test that
    // checks it. Everything else in this suite is satisfied just as well by a
    // duck.ts that POSTs the whole .mp4: the API stub would still answer 202,
    // the mix would still download, the deliverable would still probe fine.
    // The proof has to be made against the bytes that were actually handed to
    // the client.
    const output = join(dir, "uploads_audio_only.mp4");
    const { client, uploadedVoice } = stubClient();

    await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    });

    expect(uploadedVoice).toHaveLength(1);
    const uploaded = uploadedVoice[0]!;
    expect(uploaded.filename).toBe("voice.m4a"); // not "with_audio.mp4"

    // The payload is NOT the video file. (The minimum bar: a whole-video upload
    // cannot clear it.)
    const videoBytes = new Uint8Array(await readFile(fx.videoWithAudio));
    expect(uploaded.bytes).not.toEqual(videoBytes);

    // The payload carries NO PICTURE AT ALL. Stronger than byte-inequality --
    // which any re-container or transcode of the video would also satisfy --
    // and it is the actual promise: whatever reaches the API, no frame of the
    // customer's video is in it.
    const uploadedPath = join(dir, "uploaded_voice.m4a");
    await writeFile(uploadedPath, uploaded.bytes);
    const probe = await probeVideo(uploadedPath, "ffprobe");
    expect(probe.videoCodec).toBeNull(); // no video stream, not even cover art
    expect(probe.videoDurationSeconds).toBeNull();
    expect(probe.hasAudio).toBe(true); // ...and the speech really is there
    expect(probe.audioCodec).toBe("aac");

    // And it is byte-for-byte the track this machine extracted locally: the
    // upload is exactly `extractAudio`'s output, with nothing else added.
    const extracted = join(dir, "expected_voice.m4a");
    const source = await probeVideo(fx.videoWithAudio, "ffprobe");
    await extractAudio(
      fx.videoWithAudio,
      extracted,
      source.audioCodec,
      "ffmpeg",
      source.videoDurationSeconds!,
    );
    expect(uploaded.bytes).toEqual(new Uint8Array(await readFile(extracted)));
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

  it("bills on the picture, not the container: uploads a voice track trimmed to the picture's length", async () => {
    // fx.videoAudioOutlivesPicture: 1 s of picture, 3 s of audio. ffprobe's
    // format.duration is the MAX over all streams (3.0), not the picture's
    // (1.0), so extracting/uploading on format.duration uploads -- and is
    // BILLED FOR -- 3 s of audio while the deliverable only ever carries 1 s
    // of picture: a 3x overcharge for seconds the viewer never receives. The
    // server bills an audio-only voice input exactly as given (is_video =
    // False), so it cannot apply its own min(picture, audio) rule on our
    // behalf; the trim has to happen here.
    const output = join(dir, "outlives.mp4");
    const { client, uploadedVoice } = stubClient();

    await duckMusicUnderSpeech({
      video: fx.videoAudioOutlivesPicture,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    });

    // What was actually uploaded, and therefore actually billed.
    expect(uploadedVoice).toHaveLength(1);
    const billedPath = join(dir, "billed_voice.m4a");
    await writeFile(billedPath, uploadedVoice[0]!.bytes);
    const billed = await probeVideo(billedPath, "ffprobe");
    expect(billed.durationSeconds).toBeLessThan(1.5); // the picture's 1 s, not the container's 3 s
    expect(billed.durationSeconds).toBeGreaterThan(0.5); // and the speech is genuinely there

    // ...and the deliverable is as long as the picture, not the stale audio.
    const delivered = await probeVideo(output, "ffprobe");
    expect(delivered.videoDurationSeconds!).toBeLessThan(1.5);
    expect(delivered.durationSeconds).toBeLessThan(1.5);
  });

  it("rejects an audio-only file before calling the API", async () => {
    // A .m4a voiceover: has an audio track, is well under the cap, and so
    // passes every pre-fix guard -- it is uploaded, POLLED, and CHARGED, and
    // only then dies in the mux, where `-map 0:V` matches no stream (exit 234).
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.audioOnly,
        audio: fx.musicMp3,
        output: join(dir, "never_audio_only.mp4"),
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(/no video stream/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
  });

  it("rejects a file whose only video stream is attached cover art before calling the API", async () => {
    // The nastier half of the same bug: this file HAS a video stream by
    // codec_type (mjpeg cover art), so a `videoCodec !== null` check would
    // wave it through -- while `-map 0:V` (capital V) excludes attached
    // pictures and matches nothing, exactly as for the audio-only file above.
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.audioWithCoverArt,
        audio: fx.musicMp3,
        output: join(dir, "never_cover_art.mp4"),
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(/no video stream/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
  });

  it("rejects an output path with no file extension before calling the API", async () => {
    // The temp mux target is `muxed${extname(output)}`, which degrades to a
    // bare `muxed` here -- ffmpeg can infer no muxer from it and fails with
    // "Error opening output file muxed". Pre-fix that happens AFTER the API
    // call has been billed, for a problem knowable before it.
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: fx.musicMp3,
        output: join(dir, "no_extension_at_all"),
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(/no file extension/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
  });

  it("rejects music longer than the API's cap before uploading it", async () => {
    // The server applies MAX_DURATION_SECONDS to the music too
    // (get_audio_duration(music_path) in audio_ducking.py), so an over-long
    // music file is rejected server-side anyway -- but only after we have
    // uploaded it. Guard it locally instead of spending the bandwidth.
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: fx.musicTooLong,
        output: join(dir, "never_long_music.mp4"),
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(new RegExp(`music runs .*${MAX_DUCKING_DURATION_SECONDS}s`));
    expect(calls).toEqual([]); // nothing was uploaded
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
    // Asserted on the MESSAGE, not on `toThrow(VideoKitError)`: FfmpegError,
    // FfmpegNotFoundError and DuckingFailedError all extend VideoKitError, so
    // the class assertion passed on literally any failure -- including the very
    // failures these guards exist to prevent.
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({ video: "", audio: fx.musicMp3, output: "o.mp4", client }),
    ).rejects.toThrow(/video is required/);
    await expect(
      duckMusicUnderSpeech({ video: fx.videoWithAudio, audio: fx.musicMp3, output: "", client }),
    ).rejects.toThrow(/output is required/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
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
    expect(await newWorkDirs(before)).toEqual([]);

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
    expect(await newWorkDirs(before)).toEqual([]);
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
    // Force placement AND the rescue to both fail. `output` pre-exists as a
    // directory, so the mux succeeds and only placeAtomically's rename fails
    // (EISDIR); the rescue copy is then failed at OPEN by the shim at the top
    // of this file, writing nothing -- the shape of an EACCES against a
    // read-only rescue path. The rescue failing must not surface a raw fs error
    // that mentions neither the original failure nor the fact the API call was
    // already billed.
    //
    // (This test used to force both failures by pointing `output` inside a
    // directory that does not exist. That scenario no longer reaches the API at
    // all: a missing output directory is now a fail-fast guard, because being
    // CHARGED and then losing the mix entirely -- the placement and the rescue
    // both ENOENT into the same missing directory -- is the bug, not a case
    // worth handling gracefully after the fact. It has its own test below. The
    // property asserted here is unchanged; only the mechanism that provokes it
    // is.)
    const outDir = join(dir, "rescue_open_failure_dir");
    await mkdir(outDir);
    const output = join(outDir, `${RESCUE_OPEN_FAILURE_MARKER}.mp4`);
    await mkdir(output); // forces the placement step to fail (EISDIR on rename)
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

    expect(await exists(recoveredPath)).toBe(false); // rescue genuinely failed -- nothing was written there
    // ...and neither failed copy littered a temp file behind. The only entry in
    // the directory is `output` itself, still the directory it started as.
    expect(await readdir(outDir)).toEqual([`${RESCUE_OPEN_FAILURE_MARKER}.mp4`]);
    expect((await stat(output)).isDirectory()).toBe(true);
  });

  it("names the task id and the charge when a poll fails terminally after submit", async () => {
    // The submit SUCCEEDED, so calculate_and_charge has already run and the
    // task is running server-side; it will finish and upload a mix the customer
    // has paid for. Pre-fix, a terminal poll failure threw the raw
    // "HTTP 404: request failed" -- naming neither the task nor the charge -- so
    // the only handle to the paid artifact was dropped, and the only way
    // forward was to call again and be charged twice.
    const { client, calls } = pollingClient(async () => {
      throw apiError(404);
    });

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output: join(dir, "poll_died.mp4"),
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    const message = (err as VideoKitError).message;
    expect(message).toContain("t_1"); // the handle to the paid-for mix
    expect(message).toMatch(/already been charged/i);
    expect(message).toContain("/v1/tasks/t_1"); // and how to re-fetch it
    expect(message).toContain("HTTP 404"); // the underlying cause survives
    expect(calls).toEqual(["/v1/audio-ducking", "/v1/tasks/t_1"]); // 4xx: not retried
  });

  it("retries a transient poll failure and still delivers the mix", async () => {
    const output = join(dir, "poll_retry.mp4");
    const { client, calls } = pollingClient(async (attempt) => {
      if (attempt === 1) throw apiError(502); // a load balancer, mid-deploy
      if (attempt === 2) return new Response("upstream", { status: 503 });
      return taskResponse({
        status: "succeeded",
        output_url: "https://r2.example/ducked.wav",
        output_type: "audio",
      });
    });

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

    expect(calls.filter((c) => c.startsWith("/v1/tasks/"))).toHaveLength(3);
    expect((await probeVideo(output, "ffprobe")).hasAudio).toBe(true);
  });

  it("retries a transient download failure and still delivers the mix", async () => {
    const output = join(dir, "download_retry.mp4");
    const { client } = stubClient();
    let attempts = 0;
    const flakyFetch = (async () => {
      attempts += 1;
      if (attempts === 1) return new Response("upstream", { status: 503 });
      return new Response(ducked);
    }) as unknown as typeof globalThis.fetch;

    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: fx.musicMp3,
        output,
        client,
        pollIntervalMs: 1,
        fetch: flakyFetch,
      }),
    ).resolves.toBe(output);

    expect(attempts).toBe(2);
    expect((await probeVideo(output, "ffprobe")).hasAudio).toBe(true);
  });

  it("names the task id, and never the presigned URL, when the download finally fails", async () => {
    // The task reached `succeeded`, so it is charged and the mix is in R2. If
    // the download can't be completed even after retries, the error must still
    // hand back the one thing that recovers it -- the task id -- and must NOT
    // leak the presigned output_url, which is a capability granting read access
    // to the artifact and which ends up in logs.
    const { client } = stubClient();
    const deadFetch = (async () =>
      new Response("upstream", { status: 502 })) as unknown as typeof globalThis.fetch;

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output: join(dir, "download_died.mp4"),
      client,
      pollIntervalMs: 1,
      fetch: deadFetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    const message = (err as VideoKitError).message;
    expect(message).toContain("t_1");
    expect(message).toMatch(/already been charged/i);
    expect(message).toContain("/v1/tasks/t_1");
    expect(message).toContain("HTTP 502");
    expect(message).not.toContain("r2.example"); // the capability URL never leaks
  }, 20_000); // the retries back off for real (0.5 s + 1 s + 2 s)

  it.skipIf(process.getuid?.() === 0)(
    "does not destroy a rescued mix from an earlier run that it did not create",
    async () => {
      // An earlier failed run already rescued its paid-for mix to
      // `<output>.ducked.wav`, and the user made it read-only to protect it.
      // This run fails at placement too, so it rescues as well -- and pre-fix,
      // its rescue copyFile failed at OPEN with EACCES (having touched nothing),
      // whereupon the catch block ran `rm(recoveredPath, { force: true })`,
      // which succeeds regardless: unlink needs write permission on the
      // DIRECTORY, not on the file. The earlier run's irreplaceable, already-paid
      // mix was deleted by a rescue that never wrote a byte.
      const output = join(dir, "prior_rescue.mp4");
      await mkdir(output); // forces the placement step to fail (EISDIR on rename)
      const priorPath = `${output}.ducked.wav`;
      const priorBytes = new Uint8Array([1, 1, 2, 3, 5, 8]); // the earlier paid mix
      await writeFile(priorPath, priorBytes);
      await chmod(priorPath, 0o444);

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

      // The load-bearing assertion: the earlier run's paid mix is untouched.
      expect(await exists(priorPath)).toBe(true);
      expect(new Uint8Array(await readFile(priorPath))).toEqual(priorBytes);

      // ...and THIS run's mix was rescued too, next to it rather than over it.
      const rescuedPath = `${output}.ducked.1.wav`;
      expect(await exists(rescuedPath)).toBe(true);
      expect(new Uint8Array(await readFile(rescuedPath))).toEqual(ducked);
      expect((err as VideoKitError).message).toContain(rescuedPath);
    },
  );

  it("never leaves a partial file at output when the placement copy dies partway through", async () => {
    // placeAtomically stages the finished mix in a sibling temp file and
    // renames it into place, so `output` is either absent or the complete
    // deliverable -- never a half-written one. A plain
    // `copyFile(muxedPath, output)` would pass every other test in this suite
    // (including the "output is a directory" ones: a plain copyFile onto a
    // directory fails with EISDIR just the same), while opening `output` itself
    // O_CREAT|O_TRUNC and streaming into it -- so an ENOSPC halfway through
    // leaves a truncated video exactly where the caller was told to find their
    // deliverable, and the call still reports failure. Nothing distinguishes
    // the two but a copy that dies MID-WRITE, which the shim at the top of this
    // file simulates for this output's name.
    //
    // Its own directory, so the leftover-temp-file check below can read the
    // whole listing without the rest of the suite's outputs in it.
    const outDir = join(dir, "atomic_dir");
    await mkdir(outDir);
    const output = join(outDir, `${ATOMIC_PLACEMENT_MARKER}.mp4`);
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
    // The mux ran and succeeded; only the placement failed.
    expect((err as VideoKitError).message).toContain("Placing the finished mix at");

    // (a) Nothing at all is at `output` -- no truncated deliverable. A
    // non-atomic placement would have left the shim's partial bytes right here.
    expect(await exists(output)).toBe(false);

    // (b) ...and the failed placement littered no temp file behind either. The
    // only thing in the directory is the rescued, paid-for mix.
    const entries = await readdir(outDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual([`${ATOMIC_PLACEMENT_MARKER}.mp4.ducked.wav`]);
    expect(new Uint8Array(await readFile(join(outDir, entries[0]!)))).toEqual(ducked);
  });

  it("leaves neither a partial recovery file nor a temp file when a rescue copy dies partway through", async () => {
    // Same shape as "already_a_directory" above -- output pre-exists as a
    // directory, so the mux succeeds and only the rename in placeAtomically
    // fails (EISDIR) -- but this output's name carries PARTIAL_RESCUE_MARKER,
    // so the copyFile shim at the top of this file intercepts the *rescue* copy
    // specifically: it writes a short garbage file to that copy's destination
    // and then rejects, standing in for a real copyFile that died partway
    // through (e.g. ENOSPC -- likely the very thing that failed the placement).
    //
    // What the partial bytes must never do is survive at recoveredPath: the
    // error message tells the user that path holds the mix they PAID for, and a
    // truncated file sitting there is worse than none. The rescue goes through
    // placeAtomically, so the bytes land on a `.tmp` sibling and it is
    // placeAtomically's own catch that unlinks them -- recoveredPath is never
    // opened at all. (This test previously claimed rescueAndThrow's catch block
    // did the removing; it has not, since the rescue was rewritten to
    // copy-to-temp-then-rename, and asserting only `!exists(recoveredPath)` then
    // passed vacuously. Both halves are asserted below instead: nothing at
    // recoveredPath, and no temp litter -- which a rescue that copied straight
    // onto recoveredPath, or one that failed to clean up its temp, would each
    // fail.)
    const outDir = join(dir, "partial_rescue_dir");
    await mkdir(outDir);
    const output = join(outDir, `${PARTIAL_RESCUE_MARKER}.mp4`);
    await mkdir(output);
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
    expect(message).toContain("Placing the finished mix at"); // mux succeeded; placement failed
    expect(message).toContain("ALSO failed"); // the simulated rescue failure ran
    expect(message).toMatch(/charge/i);
    expect(message).toContain(recoveredPath);

    // The load-bearing assertions: no partial file at the path the error points
    // the user at, and no half-written temp file left lying next to it either.
    expect(await exists(recoveredPath)).toBe(false);
    const entries = await readdir(outDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toEqual([`${PARTIAL_RESCUE_MARKER}.mp4`]); // just the output directory itself
  });

  it("bills on the PICTURE for Matroska and WebM, which carry no per-stream duration at all", async () => {
    // The MP4 billing test above passes for MKV/WebM only by accident of the
    // container. Matroska and WebM never emit a per-stream `duration` field, so
    // a probe that falls back to format.duration when the field is missing does
    // so for 100% of these files -- and format.duration is the max over ALL
    // streams, i.e. the AUDIO's 3 s over a 1 s picture. That figure is what gets
    // UPLOADED (and therefore BILLED, since the server bills the voice track it
    // is given), and what the mux pads to: a 3x overcharge, plus a 3 s
    // deliverable whose picture freezes after 1 s.
    for (const [name, video] of [
      ["mkv", fx.videoAudioOutlivesPictureMkv],
      ["webm", fx.videoAudioOutlivesPictureWebm],
    ] as const) {
      const output = join(dir, `outlives_${name}.mp4`);
      const { client, uploadedVoice } = stubClient();

      await duckMusicUnderSpeech({
        video,
        audio: fx.musicMp3,
        output,
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      });

      // What was actually uploaded, and therefore actually billed.
      expect(uploadedVoice).toHaveLength(1);
      const billedPath = join(dir, `billed_voice_${name}.m4a`);
      await writeFile(billedPath, uploadedVoice[0]!.bytes);
      const billed = await probeVideo(billedPath, "ffprobe");
      expect(billed.durationSeconds).toBeLessThan(1.5); // the picture's 1 s, not the container's 3 s
      expect(billed.durationSeconds).toBeGreaterThan(0.5); // and the speech is genuinely there

      // ...and the deliverable is as long as the picture, not the stale audio.
      const delivered = await probeVideo(output, "ffprobe");
      expect(delivered.videoDurationSeconds!).toBeLessThan(1.5);
      expect(delivered.durationSeconds).toBeLessThan(1.5);
    }
  });

  it("BILLS THE PICTURE, not the container, for a SPARSE MKV whose duration field is backfilled from the container", async () => {
    // The regression this suite exists for, end to end, against the file that
    // actually reproduces it: a 10 s picture at 1 fps under a 30 s audio track.
    //
    // The picture's packets are sparse, so libavformat cannot establish the video
    // stream's timing from them and backfills `st->duration` FROM THE CONTAINER.
    // ffprobe then reports the video stream as 30.128 s long -- the maximum over
    // all streams, i.e. the AUDIO's length -- while its DURATION tag correctly
    // says 00:00:10. Reading the field first uploads 30 s of voice for a 10 s
    // picture, and THE SERVER BILLS THE DURATION OF THE AUDIO IT IS GIVEN: a 3x
    // overcharge, and a deliverable whose picture freezes two thirds of the way
    // through.
    //
    // Asserted on the bytes actually handed to the transport, because that -- not
    // any figure this package computes internally -- is what is charged for.
    const output = join(dir, "sparse_mkv.mp4");
    const { client, uploadedVoice } = stubClient();

    await duckMusicUnderSpeech({
      video: fx.videoSparsePictureMkv,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    });

    expect(uploadedVoice).toHaveLength(1);
    const billedPath = join(dir, "billed_sparse_mkv.m4a");
    await writeFile(billedPath, uploadedVoice[0]!.bytes);
    const billed = await probeVideo(billedPath, "ffprobe");
    // The picture's 10 s (plus at most the last frame's 1 s of display time at
    // 1 fps), NEVER the container's 30 s.
    expect(billed.durationSeconds).toBeGreaterThan(9);
    expect(billed.durationSeconds).toBeLessThan(11.5);

    // ...and the deliverable is as long as the picture, so billed == delivered.
    const delivered = await probeVideo(output, "ffprobe");
    expect(delivered.videoDurationSeconds!).toBeLessThan(11.5);
    expect(delivered.durationSeconds).toBeLessThan(11.5);
  });

  it("BILLS THE PICTURE, not a PHANTOM start, for a FRAGMENTED MP4 -- the one bug that CUT THE USER'S SPEECH OFF (both recipes)", async () => {
    // BUG 1, END TO END, on the bytes actually handed to the transport.
    //
    // Every other billing bug in this suite OVERCHARGES. This one UNDERCHARGES,
    // which is strictly worse: the uploaded voice track is SHORTER than the
    // picture, so the customer pays for a mix whose speech is CUT OFF two seconds
    // early and whose music stops before the picture does.
    //
    // A fragmented MP4 (OBS "fragmented MP4" recording, ffmpeg's own streaming
    // recipe, CMAF/DASH segments, MediaRecorder screen capture) has no moov, so
    // libavformat takes the video stream's `start_time` from the first packet in
    // DECODE order -- a B-pyramid artifact, 2.000000, when the picture's packets
    // really start at pts 0.000061 -- and derives
    // `duration = packet_span - start_time` = 8.128 for a picture that runs 10 s.
    //
    // 8.128 is nowhere near the container's 30.128, so the
    // looks-like-the-container's guard does not fire, and nb_frames does not save
    // it either (absent under +empty_moov, PRESENT under plain +frag_keyframe --
    // both are asserted here). THE SERVER BILLS THE DURATION OF THE AUDIO IT IS
    // GIVEN: 8.13 s uploaded for a 10 s picture is a 0.81x bill and a truncated
    // deliverable.
    for (const [name, video] of [
      ["empty_moov", fx.videoFragmentedEmptyMoov],
      ["frag_keyframe", fx.videoFragmentedKeyframe],
    ] as const) {
      const output = join(dir, `fragmented_${name}.mp4`);
      const { client, uploadedVoice } = stubClient();

      await duckMusicUnderSpeech({
        video,
        audio: fx.musicMp3,
        output,
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      });

      // What was actually uploaded, and therefore actually BILLED.
      expect(uploadedVoice, name).toHaveLength(1);
      const billedPath = join(dir, `billed_fragmented_${name}.m4a`);
      await writeFile(billedPath, uploadedVoice[0]!.bytes);
      const billed = await probeVideo(billedPath, "ffprobe");
      // The picture's 10 s. NEVER the 8.13 s the phantom-derived field claims --
      // that is the figure that cuts the speech off.
      expect(billed.durationSeconds, name).toBeGreaterThan(9.5);
      expect(billed.durationSeconds, name).toBeLessThan(11.5); // nor the container's 30 s

      // ...and the voice the customer paid for genuinely covers the whole picture:
      // billed >= delivered, so nothing is truncated.
      const delivered = await probeVideo(output, "ffprobe");
      expect(delivered.videoDurationSeconds!, name).toBeGreaterThan(9.5);
      expect(billed.durationSeconds, name).toBeGreaterThanOrEqual(
        delivered.videoDurationSeconds! - 0.5,
      );
    }
  });

  it("accepts a video whose PICTURE is under the cap even though its container runs over it", async () => {
    // 350 s of picture under 365 s of audio (Matroska). The backend gates on the
    // video stream's duration -- audio_ducking.py, whose comments cite an
    // accepted 358 s picture / 361 s audio case -- so this file is legal and
    // must reach the API. A guard reading the container's duration instead
    // refuses it with "runs 365.0s", telling the user their 350 s video is 365 s
    // long, for a video the server would have taken.
    const output = join(dir, "long_picture.mp4");
    const { client, calls } = stubClient();

    await expect(
      duckMusicUnderSpeech({
        video: fx.videoLongPictureLongerAudioMkv,
        audio: fx.musicMp3,
        output,
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).resolves.toBe(output);

    expect(calls).toEqual(["/v1/audio-ducking", "/v1/tasks/t_1"]); // it was NOT refused locally
    const delivered = await probeVideo(output, "ffprobe");
    expect(delivered.videoDurationSeconds!).toBeGreaterThan(345); // the whole picture survives
    expect(delivered.videoDurationSeconds!).toBeLessThan(355);
  }, 30_000);

  it("rejects an output whose directory does not exist before calling the API", async () => {
    // `output: "out/final.mp4"` with no `out/` is an everyday call. Without this
    // guard it passes every other check: the job is submitted, the account is
    // CHARGED, the mux succeeds -- and then placeAtomically ENOENTs, and the
    // rescue, which writes next to `output` and so into the same missing
    // directory, ENOENTs too. The customer pays and NOTHING lands on disk, not
    // even the rescue.
    const missingDir = join(dir, "does_not_exist_at_all");
    const output = join(missingDir, "ducked.mp4");
    const { client, calls } = stubClient();

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output,
      client,
      pollIntervalMs: 1,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    expect((err as VideoKitError).message).toContain(missingDir); // it names the directory
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
    expect(await exists(output)).toBe(false);
    expect(await exists(`${output}.ducked.wav`)).toBe(false);
  });

  it("rejects an output whose extension is an empty '.' before calling the API", async () => {
    // `extname("deliverable.")` is ".", which is TRUTHY -- so a `!extname(output)`
    // guard waves this through. The mux target then becomes `muxed.`, from which
    // ffmpeg can infer no muxer at all, and it dies exactly like the
    // no-extension case: after the charge.
    const { client, calls } = stubClient();
    await expect(
      duckMusicUnderSpeech({
        video: fx.videoWithAudio,
        audio: fx.musicMp3,
        output: join(dir, "trailing_dot."),
        client,
        pollIntervalMs: 1,
        fetch: stubFetch(ducked),
      }),
    ).rejects.toThrow(/no file extension/);
    expect(calls).toEqual([]); // nothing was uploaded, so nothing was charged
  });

  it("keeps an abort programmatically detectable as `cause` on the error it is wrapped in", async () => {
    // The abort happens AFTER submit, so the wrap is right: the customer HAS
    // been charged, the task IS running server-side, and the task id has to
    // survive. But the wrapper must not be all that survives -- a caller doing
    // `catch (e) { if (e.name === "AbortError") return; }` around their own
    // deliberate cancellation would otherwise see a hard failure. The original
    // error stays reachable as `cause`.
    const controller = new AbortController();
    const { client } = pollingClient(async () => {
      controller.abort(); // cancelled while the task is still processing
      return taskResponse({ status: "processing" });
    });

    const err = await duckMusicUnderSpeech({
      video: fx.videoWithAudio,
      audio: fx.musicMp3,
      output: join(dir, "aborted.mp4"),
      client,
      pollIntervalMs: 1,
      signal: controller.signal,
      fetch: stubFetch(ducked),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    const message = (err as VideoKitError).message;
    expect(message).toContain("t_1"); // the handle to the paid-for mix still survives
    expect(message).toMatch(/already been charged/i);

    const cause = (err as VideoKitError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).name).toBe("AbortError"); // ...and so does the abort
  });
});
