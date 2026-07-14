import { randomUUID } from "node:crypto";
import { access, constants, copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { SoniloClient } from "sonilo";
import {
  awaitDuckingResult,
  downloadDuckedMix,
  submitDuckingJob,
  type DuckingClient,
} from "./ducking-api.js";
import { DuckingFailedError, VideoKitError } from "./errors.js";
import { extractAudio, muxVideoWithAudio, probeMuxFeasibility, probeVideo } from "./ffmpeg.js";

/** The ducking API rejects voice, video, and music tracks longer than this. */
export const MAX_DUCKING_DURATION_SECONDS = 360;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface DuckMusicUnderSpeechOptions {
  /** Path to the video. Must have a picture and an audio track, and its picture
   * must run no longer than 360 s. */
  video: string;
  /** Music: Track.audio bytes, or a path to an audio file. No longer than 360 s. */
  audio: Uint8Array | string;
  /** Explicit output path. Must carry a file extension, so ffmpeg can infer a container. */
  output: string;
  /** Defaults to `new SoniloClient()` (reads SONILO_API_KEY). */
  client?: DuckingClient;
  /** Task poll interval. Default 2000 ms. */
  pollIntervalMs?: number;
  /** How long to wait for the task overall. Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Used only to download the finished mix. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  ffmpegPath?: string;
  ffprobePath?: string;
}

/** Duck generated music under the speech already in `video`.
 *
 * The ducking itself runs on the Sonilo API — a PAID endpoint, metered on the
 * uploaded voice track's duration. Only the extracted audio track is uploaded,
 * trimmed to the picture's length so the billed duration equals the delivered
 * one; the picture stays local and is copied, never re-encoded.
 *
 * Preconditions the API cannot satisfy (no audio track, no picture, a video or
 * music track longer than MAX_DUCKING_DURATION_SECONDS) — and preconditions the
 * local mux and the local filesystem cannot satisfy (an `output` with no
 * extension, or in a directory that does not exist or is not writable; a picture
 * that cannot be stream-copied into the container `output`'s extension names) —
 * throw before anything is uploaded, and so before anything is charged. There is
 * deliberately no fallback to
 * mixWithVideo: a caller who asked for ducking must never silently receive an
 * un-ducked file. */
export async function duckMusicUnderSpeech(
  options: DuckMusicUnderSpeechOptions,
): Promise<string> {
  const {
    video,
    audio,
    output,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
  } = options;
  // Bind ONLY the default: undici's globalThis.fetch throws "Illegal
  // invocation" when detached from globalThis, but a caller-supplied fetch is
  // theirs -- rebinding its `this` to globalThis breaks a bound method (a proxy
  // or agent wrapper's `fetch`), which is exactly what such wrappers are.
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  if (!video) throw new VideoKitError("video is required");
  if (!output) throw new VideoKitError("output is required");
  // A `output` with no extension leaves ffmpeg with no way to infer a muxer
  // for the temp mux target below (`muxed${outputExtension}` degrades to a
  // bare `muxed`), and it fails with "Error opening output file". That is
  // knowable now — and only now is it free: by mux time the API call has
  // already been billed.
  //
  // Tested for length, not truthiness: `extname("deliverable.")` is ".", which
  // is truthy but names no container — `muxed.` is just as unmuxable as `muxed`,
  // and fails just as late, i.e. after the charge.
  const outputExtension = extname(output);
  if (outputExtension.length < 2) {
    throw new VideoKitError(
      `output "${output}" has no file extension, so ffmpeg cannot tell which container ` +
        `to write. Give it one (e.g. "${output.replace(/\.$/, "")}.mp4").`,
    );
  }
  // `output`'s directory has to exist and be writable, and this is the moment
  // it is free to say so. `output: "out/final.mp4"` with no `out/` is an
  // everyday call: without this guard it passes every other check, the job is
  // submitted, the account is CHARGED, the mux succeeds -- and then the
  // placement ENOENTs, and the rescue, which writes next to `output` and so
  // into the very same missing directory, ENOENTs too. The customer pays and
  // NOTHING lands on disk, not even the rescue.
  const outputDir = dirname(output);
  try {
    await access(outputDir, constants.W_OK);
  } catch {
    throw new VideoKitError(
      `output "${output}" is in a directory that does not exist or cannot be written to ` +
        `(${outputDir}). Create it first (e.g. \`mkdir -p ${outputDir}\`): the ducking API ` +
        `is billed at submit, so discovering this after the call would cost you the charge ` +
        `AND leave nowhere to put the mix you paid for.`,
    );
  }
  if (!audio || (typeof audio !== "string" && audio.byteLength === 0)) {
    throw new VideoKitError("audio is required");
  }

  // Guards run before the client is constructed: an unusable video reports the
  // real problem even when SONILO_API_KEY is unset, and nothing is uploaded or
  // charged for an input the API would reject anyway.
  const probe = await probeVideo(video, ffprobePath);
  if (!probe.hasAudio) {
    throw new VideoKitError(
      `${video} has no audio track, so there is no speech to duck under. ` +
        `Use mixWithVideo to lay music over a silent video.`,
    );
  }
  // No picture to duck under. The ducking API itself accepts an audio-only
  // voice input, so this is a natural thing to hand us (a .m4a voiceover, a
  // podcast .wav) — and without this guard it passes every other check, gets
  // uploaded, gets CHARGED, and only then dies in the mux, where `-map 0:V`
  // matches no stream. `videoDurationSeconds`/`videoCodec` are null for a file
  // whose only "video" stream is attached cover art, which `-map 0:V` also
  // excludes; that file must be rejected here too, for exactly the same reason.
  const videoDuration = probe.videoDurationSeconds;
  if (videoDuration === null) {
    throw new VideoKitError(
      `${video} has no video stream (embedded cover art does not count), so there is ` +
        `no picture to mux the ducked audio back onto. Duck an audio-only file with the ` +
        `ducking API directly, or pass a real video.`,
    );
  }
  // Guard, bill, and mux on the PICTURE's duration, never the container's:
  // format.duration is ffprobe's maximum over all streams, so for a video
  // whose audio track outlives its picture (routine encoder padding) it is the
  // AUDIO's length. The server bills the uploaded voice track, and the
  // deliverable is only as long as the picture, so any figure longer than the
  // picture would overbill for seconds nobody receives -- and any figure
  // longer than the cap would reject a video the API explicitly accepts
  // (measured server-side: 358s picture / 361s audio is accepted and billed 358s).
  if (videoDuration > MAX_DUCKING_DURATION_SECONDS) {
    throw new VideoKitError(
      `${video} runs ${videoDuration.toFixed(1)}s; the ducking API accepts ` +
        `at most ${MAX_DUCKING_DURATION_SECONDS}s. Use mixWithVideo for longer videos.`,
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), "sonilo-video-kit-duck-"));
  try {
    // CAN THE PICTURE ACTUALLY BE STREAM-COPIED INTO THE CALLER'S CONTAINER?
    // The last thing the mux needs that nothing above proves. probeVideo
    // succeeding does NOT prove it -- it answers questions about DURATION, and
    // two everyday files pass every guard above and still cannot be muxed:
    //
    //  - a LOW-FRAME-RATE MPEG-TS, whose picture ffprobe reports as width=0
    //    height=0 while the duration model (which measures packets) happily
    //    reports its length. The mux dies with "dimensions not set";
    //  - an h264 source with a `.webm` output -- a WRONG FILE EXTENSION, the most
    //    ordinary mistake there is. WebM holds only VP8/VP9/AV1.
    //
    // Both used to be found at the mux, which runs after the API call has been
    // BILLED: the customer paid for a mix that could never be delivered, for a
    // reason knowable for 30 ms before the upload. So ask ffmpeg -- never a
    // hand-written codec/container matrix, which would go stale and start
    // refusing videos that could have been ducked -- to dry-run the real mux's
    // own `-map 0:V -c:v copy` into a container of the caller's own extension.
    //
    // Placed here, and specifically BEFORE `new SoniloClient()`, not merely
    // before the submit. extractAudio runs after the client is constructed and is
    // still pre-charge, so a guard could technically sit there too -- but it is a
    // STEP OF THE WORK, not a precondition, and the invariant this file keeps is
    // that every precondition on the caller's INPUTS is settled before the client
    // exists. A guard after the client reports "SONILO_API_KEY is missing" for an
    // unmuxable video, which is the wrong problem and hides the real one.
    const feasibility = await probeMuxFeasibility(
      video,
      join(workDir, `feasibility${outputExtension}`),
      ffmpegPath,
    );
    if (!feasibility.ok) {
      throw await unmuxableError(
        video,
        outputExtension,
        probe.videoCodec,
        feasibility.reason,
        workDir,
        ffmpegPath,
      );
    }

    // The music obeys the same cap as the video (the server applies
    // MAX_DURATION_SECONDS to it too, in get_audio_duration(music_path)), so
    // probe it here rather than uploading up to 300 MB the server will only
    // reject. Bytes have to reach the disk before ffprobe can read them --
    // hence the workDir -- but the client is STILL constructed only after
    // every fail-fast guard has run, so a bad input reports its own problem
    // even when SONILO_API_KEY is unset.
    const musicPath =
      typeof audio === "string" ? audio : join(workDir, "music.mp3");
    if (typeof audio !== "string") await writeFile(musicPath, audio);

    const musicProbe = await probeVideo(musicPath, ffprobePath);
    if (musicProbe.durationSeconds > MAX_DUCKING_DURATION_SECONDS) {
      throw new VideoKitError(
        `The music runs ${musicProbe.durationSeconds.toFixed(1)}s; the ducking API accepts ` +
          `at most ${MAX_DUCKING_DURATION_SECONDS}s. Use a shorter music track.`,
      );
    }

    const client = options.client ?? new SoniloClient();

    // Upload the audio track, never the picture: a few MB instead of up to the
    // API's 300 MB upload cap, and the original picture is never re-encoded by
    // anyone else. Trimmed to the picture's length: the server takes an
    // audio-only voice input as `is_video = False` and bills exactly what it
    // is given, so uploading audio that outlives the picture would be billed
    // for -- 2.5x over, on a measured 4s-picture/10s-audio mp4 -- while the
    // deliverable stays as long as the picture. Trimming here makes the billed
    // duration equal the delivered duration, which is the server's own
    // `min(audio, picture)` rule.
    const voicePath = join(workDir, "voice.m4a");
    await extractAudio(video, voicePath, probe.audioCodec, ffmpegPath, videoDuration);

    const voiceBytes = new Uint8Array(await readFile(voicePath));
    const musicBytes =
      typeof audio === "string" ? new Uint8Array(await readFile(audio)) : audio;
    const musicFilename = typeof audio === "string" ? basename(audio) : "music.mp3";

    // THE ACCOUNT IS CHARGED HERE. The server charges in the POST handler
    // (calculate_and_charge, before the background job is even spawned), and it
    // only refunds when its OWN processing fails. So from this line on, every
    // failure -- a poll that 4xxs, a download that stays broken, an abort, a
    // timeout -- is a failure that costs the customer money while the task keeps
    // running server-side, finishes, and uploads a mix they have paid for.
    // Nothing below may throw away the handle to it: see rethrowWithTaskId.
    const taskId = await submitDuckingJob(
      client,
      { bytes: voiceBytes, filename: "voice.m4a" },
      { bytes: musicBytes, filename: musicFilename },
      signal,
    );

    const duckedPath = join(workDir, "ducked.wav");
    try {
      const result = await awaitDuckingResult(client, taskId, {
        pollIntervalMs,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
      // Only an extracted audio track is ever uploaded, so the server should
      // never answer with anything but "audio". Assert the contract instead of
      // silently ignoring outputType.
      if (result.outputType !== "audio") {
        throw new VideoKitError(
          `The ducking API returned output_type "${result.outputType}" for task ${taskId}, ` +
            `but only "audio" is expected: this client always uploads just the extracted ` +
            `audio track, never the picture.`,
        );
      }

      // The API returns the finished mix already delivered at -14 LUFS / -1 dBTP,
      // so there is no local loudness pass to run.
      await downloadDuckedMix(result.outputUrl, duckedPath, fetchFn, {
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw rethrowWithTaskId(err, taskId);
    }

    // Mux into workDir first, never straight to `output`: muxVideoWithAudio
    // writes with `-y`, so a failure partway through (disk full; or a
    // container that can't hold the copied video codec, e.g. h264 into
    // .webm) would otherwise leave a truncated/empty file where the caller
    // expects a deliverable. The mux target keeps `output`'s extension so
    // ffmpeg infers the same container it would have used for `output`.
    //
    // Everything from here through the deliverable landing at `output` is
    // one protected region: the ducking API call has already been billed on
    // the video's duration, so ANY failure in this block -- the mux itself,
    // or placing the finished file at `output` -- must rescue the
    // downloaded mix next to `output` before the `finally` below deletes
    // workDir, and say so in the error. `stage` records which step was in
    // flight so the error names the step that actually failed.
    const muxedPath = join(workDir, `muxed${outputExtension}`);
    let stage = `Muxing the ducked audio onto ${video}`;
    try {
      await muxVideoWithAudio(video, duckedPath, muxedPath, videoDuration, ffmpegPath);
      stage = `Placing the finished mix at ${output}`;
      await placeAtomically(muxedPath, output);
    } catch (err) {
      await rescueAndThrow(stage, err, duckedPath, output, taskId);
    }

    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Containers offered to a caller whose chosen one cannot hold their picture.
 * Not a compatibility matrix — nothing here is ASSERTED to work. Each candidate
 * is dry-run against THIS file (see `unmuxableError`) and only survives if
 * ffmpeg actually wrote it, so the suggestion is a measurement, not a claim that
 * can rot. Ordered most-permissive first. */
const FALLBACK_EXTENSIONS = [".mkv", ".mp4", ".mov"];

/** The video is fine, the API would have taken it — but the picture cannot be
 * stream-copied into the container the caller's `output` extension names, so the
 * mux at the end could only fail. Say so BEFORE the charge, and say what to do.
 *
 * "What to do" is worth another few ffmpeg runs BECAUSE WE ARE ALREADY THROWING:
 * this is the failure path, it costs the happy path nothing, and the difference
 * between "your .webm won't work" and "your .webm won't work, .mkv and .mp4 both
 * will — I just checked, on this file" is the difference between a user who
 * retries successfully and one who guesses again. Each candidate is DRY-RUN, so
 * nothing is promised that ffmpeg has not just demonstrated.
 *
 * When NO container can take the picture, the extension was never the problem:
 * the video stream itself is not stream-copyable (the width=0 MPEG-TS), and no
 * choice of `output` can rescue it. That is a different instruction — re-encode —
 * and it gets a different message. */
async function unmuxableError(
  video: string,
  outputExtension: string,
  videoCodec: string | null,
  reason: string,
  workDir: string,
  ffmpegPath: string,
): Promise<VideoKitError> {
  const codec = videoCodec ?? "its video stream";
  const alternatives: string[] = [];
  for (const ext of FALLBACK_EXTENSIONS) {
    if (ext === outputExtension.toLowerCase()) continue;
    const probed = await probeMuxFeasibility(video, join(workDir, `alt${ext}`), ffmpegPath);
    if (probed.ok) alternatives.push(ext);
  }

  if (alternatives.length > 0) {
    return new VideoKitError(
      `${video}'s picture (${codec}) cannot be stream-copied into a "${outputExtension}" ` +
        `container, so muxing the ducked audio back onto it would fail. duckMusicUnderSpeech ` +
        `never re-encodes your picture, so the container has to be able to hold it as it is. ` +
        `Give output an extension that can: ${alternatives.map((e) => `"${e}"`).join(", ")} ` +
        `${alternatives.length > 1 ? "all work" : "works"} for this file (checked just now, ` +
        `against this file). Refused before the ducking API was called, so you have NOT been ` +
        `charged. ffmpeg said: ${reason}`,
    );
  }
  return new VideoKitError(
    `The picture in ${video} (${codec}) cannot be stream-copied into ANY container — not ` +
      `"${outputExtension}", and not ${FALLBACK_EXTENSIONS.map((e) => `"${e}"`).join("/")} ` +
      `either — so muxing the ducked audio back onto it would fail whatever output you chose. ` +
      `ffmpeg cannot even write a header for this video stream (a low-frame-rate MPEG-TS, for ` +
      `instance, carries a picture whose dimensions the demuxer never learns). Re-encode it ` +
      `first and duck the result: \`ffmpeg -i ${video} -c:v libx264 -c:a copy fixed.mp4\`. ` +
      `Refused before the ducking API was called, so you have NOT been charged. ffmpeg said: ` +
      `${reason}`,
  );
}

/** Plain words for "the API has run, you have been billed, and the mix is still
 * yours" — the sentence every post-submit failure has to end with. */
function paidNote(taskId: string): string {
  return (
    `You have ALREADY BEEN CHARGED for ducking task ${taskId}: the API bills at submit, and ` +
    `the task keeps running to completion server-side no matter what happens to this call. ` +
    `Do not call duckMusicUnderSpeech again for this video -- that submits a NEW task and ` +
    `charges you a second time. Poll GET /v1/tasks/${taskId} instead (with the same client: ` +
    `client.request("/v1/tasks/${taskId}")) until it reports "succeeded", and download the ` +
    `output_url it hands back: that is a re-fetch of the mix you have paid for, not a new charge.`
  );
}

/** Anything that goes wrong after a successful submit has to carry the task id
 * out with it. Without this, a 502 on a poll or a reset connection on the
 * download threw a message that named neither the task nor the charge: the mix
 * was paid for, was finished, was sitting in R2 -- and the caller's only handle
 * to it had been dropped on the floor. Re-running was the only way forward, and
 * it charged again.
 *
 * Expressed as a plain VideoKitError rather than a new exported error class:
 * the recovery is the same in every case (re-poll the task id, which is in the
 * message), a new class would have to be semver-locked into the public surface
 * for no branching the caller can act on, and callers already catch
 * VideoKitError. The one error passed through untouched is DuckingFailedError:
 * there the SERVER's own processing failed, so there is no finished mix to
 * re-fetch and the refund path applies instead -- re-polling would only return
 * the same failure, and its `refunded` flag already reports the charge.
 *
 * The presigned output_url is deliberately never put in the message: it is a
 * capability granting read access to the artifact, and errors get logged. The
 * task id is the safe handle -- it yields a fresh URL on the next poll.
 *
 * The original error is CHAINED as `cause`, not discarded. Wrapping loses the
 * error's identity, and one identity here is the caller's own: an abort the
 * caller requested arrives as a DOMException named "AbortError", and a caller
 * doing `catch (e) { if (e.name === "AbortError") return; }` would otherwise
 * see their deliberate cancellation as a hard failure. `err.cause` keeps that
 * question answerable while the message still carries the task id and the
 * charge -- which an abort needs just as much as any other post-submit failure,
 * since aborting the client does not stop (or refund) the task. */
function rethrowWithTaskId(err: unknown, taskId: string): unknown {
  if (err instanceof DuckingFailedError) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new VideoKitError(
    `The ducking API ran, but the finished mix could not be collected: ${reason}. ${paidNote(taskId)}`,
    { cause: err },
  );
}

/** Where to rescue the paid mix to, without ever clobbering a rescued mix from
 * an EARLIER failed run. `<output>.ducked.wav` may already hold an
 * irreplaceable, paid-for mix that this call did not write; overwriting it (or,
 * as the old rescue did, deleting it) destroys audio the customer cannot get
 * back without paying again. If the obvious name is taken, step aside to
 * `<output>.ducked.1.wav`, `.2.wav`, ... so both survive. */
async function freeRescuePath(output: string): Promise<string> {
  const candidates = [`${output}.ducked.wav`];
  for (let n = 1; n <= 50; n++) candidates.push(`${output}.ducked.${n}.wav`);
  candidates.push(`${output}.ducked.${randomUUID()}.wav`);
  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch {
      return candidate; // does not exist: free to write
    }
  }
  /* c8 ignore next */
  return candidates[candidates.length - 1]!;
}

/** Copy `sourcePath` to `destPath` without ever leaving a truncated file at
 * `destPath`. `fs.copyFile` alone opens `destPath` with O_CREAT|O_TRUNC and
 * streams into it, so a failure partway through (e.g. disk full on
 * `destPath`'s filesystem) would leave a corrupt file exactly where the
 * caller expects a finished deliverable. Instead: copy to a sibling temp
 * file in the same directory as `destPath` (same filesystem, so the
 * follow-up rename can't fail with EXDEV) and rename it into place, which is
 * atomic within a filesystem -- `destPath` either doesn't exist yet or is
 * the complete file, never a partial one. The temp file is removed if
 * either step fails, so a failed placement doesn't litter the directory. */
async function placeAtomically(sourcePath: string, destPath: string): Promise<void> {
  const tempPath = join(dirname(destPath), `.${basename(destPath)}.${randomUUID()}.tmp`);
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, destPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** The ducking API call that produced `duckedPath` has already been billed
 * on the video's duration, so any failure between "the mix is downloaded"
 * and "the mix is safely at `output`" (a mux that can't hold the video's
 * codec, a full disk, a missing/read-only `output` directory, `output`
 * itself being a directory, ...) must not also destroy that paid-for mix.
 * Copy it next to `output` before rethrowing, and say so in the thrown
 * error. Used from a single catch block covering both the mux and the
 * placement step, so the rescue logic itself is never duplicated -- only
 * the human-readable `stage` description differs per call site.
 *
 * The rescue goes through the SAME copy-to-sibling-temp-then-rename dance as
 * placeAtomically, and onto a path nothing else occupies (freeRescuePath), for
 * two reasons that both come down to never destroying a paid mix:
 *
 *  - a copyFile straight onto the rescue path opens it O_TRUNC, so a failure
 *    partway through (ENOSPC -- likely the same thing that failed the mux)
 *    leaves a truncated file exactly where the error tells the user to look;
 *  - the cleanup after a failed rescue may only ever delete a file THIS call
 *    created. The old code removed `<output>.ducked.wav` unconditionally, so a
 *    rescue that failed at open (EACCES against a read-only rescued mix left by
 *    an earlier run) still unlinked it -- unlink needs write permission on the
 *    directory, not the file -- and an irreplaceable, already-paid-for mix from
 *    the previous run was gone. Now only the temp file is ever removed.
 *
 * The rescue copy can itself fail (most commonly for the same reason the
 * original operation failed, e.g. `output`'s directory doesn't exist). That
 * must not surface as a bare fs error that mentions neither the real
 * failure nor the fact that this call was already charged, so it's caught
 * and folded into the same informative `VideoKitError` -- which, since the
 * mix could not be saved locally, points at the one handle that still works:
 * re-polling the task id. */
async function rescueAndThrow(
  stage: string,
  cause: unknown,
  duckedPath: string,
  output: string,
  taskId: string,
): Promise<never> {
  const reason = cause instanceof Error ? cause.message : String(cause);
  let recoveredPath = `${output}.ducked.wav`;
  let rescueNote: string;
  try {
    recoveredPath = await freeRescuePath(output);
    await placeAtomically(duckedPath, recoveredPath);
    rescueNote =
      `The ducked audio was saved to ${recoveredPath} so you can recover it locally ` +
      `(e.g. retry the mux, or move the file into place yourself) instead of calling ` +
      `duckMusicUnderSpeech again, which would incur another charge. You have already ` +
      `been charged for ducking task ${taskId}.`;
  } catch (rescueErr) {
    const rescueReason = rescueErr instanceof Error ? rescueErr.message : String(rescueErr);
    rescueNote =
      `Attempting to also save the ducked audio to ${recoveredPath} ALSO failed ` +
      `(${rescueReason}), so the mix could not be recovered locally. ${paidNote(taskId)}`;
  }
  // The original failure is chained as `cause` for the same reason it is in
  // rethrowWithTaskId: the wrapper carries the context (the stage, the rescue,
  // the charge), but it must not be the only thing left of the error that
  // actually happened -- an FfmpegError's exitCode/stderrTail, an fs error's
  // `code`, are still worth branching on.
  throw new VideoKitError(
    `${stage} failed, after the ducking API had already run and been billed for this ` +
      `video's duration. ${rescueNote} Original error: ${reason}`,
    { cause },
  );
}
