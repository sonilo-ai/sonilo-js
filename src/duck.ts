import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { SoniloClient } from "sonilo";
import {
  awaitDuckingResult,
  downloadDuckedMix,
  submitDuckingJob,
  type DuckingClient,
} from "./ducking-api.js";
import { VideoKitError } from "./errors.js";
import { extractAudio, muxVideoWithAudio, probeVideo } from "./ffmpeg.js";

/** The ducking API rejects voice, video, and music tracks longer than this. */
export const MAX_DUCKING_DURATION_SECONDS = 360;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface DuckMusicUnderSpeechOptions {
  /** Path to the video. Must have an audio track and run no longer than 360 s. */
  video: string;
  /** Music: Track.audio bytes, or a path to an audio file. */
  audio: Uint8Array | string;
  /** Explicit output path. */
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
 * video's duration. Only the extracted audio track is uploaded; the picture
 * stays local and is copied, never re-encoded.
 *
 * Preconditions the API cannot satisfy (no audio track, longer than
 * MAX_DUCKING_DURATION_SECONDS) throw before anything is uploaded, and so
 * before anything is charged. There is deliberately no fallback to
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
  const fetchFn = (options.fetch ?? globalThis.fetch).bind(globalThis);

  if (!video) throw new VideoKitError("video is required");
  if (!output) throw new VideoKitError("output is required");
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
  if (probe.durationSeconds > MAX_DUCKING_DURATION_SECONDS) {
    throw new VideoKitError(
      `${video} runs ${probe.durationSeconds.toFixed(1)}s; the ducking API accepts ` +
        `at most ${MAX_DUCKING_DURATION_SECONDS}s. Use mixWithVideo for longer videos.`,
    );
  }

  const client = options.client ?? new SoniloClient();

  const workDir = await mkdtemp(join(tmpdir(), "sonilo-video-kit-duck-"));
  try {
    // Upload the audio track, never the picture: a few MB instead of up to the
    // API's 300 MB upload cap, and the original picture is never re-encoded by
    // anyone else.
    const voicePath = join(workDir, "voice.m4a");
    await extractAudio(video, voicePath, probe.audioCodec, ffmpegPath);

    const voiceBytes = new Uint8Array(await readFile(voicePath));
    const musicBytes =
      typeof audio === "string" ? new Uint8Array(await readFile(audio)) : audio;
    const musicFilename = typeof audio === "string" ? basename(audio) : "music.mp3";

    const taskId = await submitDuckingJob(
      client,
      { bytes: voiceBytes, filename: "voice.m4a" },
      { bytes: musicBytes, filename: musicFilename },
      signal,
    );
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
    const duckedPath = join(workDir, "ducked.wav");
    await downloadDuckedMix(result.outputUrl, duckedPath, fetchFn, signal);

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
    const muxedPath = join(workDir, `muxed${extname(output)}`);
    let stage = `Muxing the ducked audio onto ${video}`;
    try {
      await muxVideoWithAudio(video, duckedPath, muxedPath, probe.durationSeconds, ffmpegPath);
      stage = `Placing the finished mix at ${output}`;
      await placeAtomically(muxedPath, output);
    } catch (err) {
      await rescueAndThrow(stage, err, duckedPath, output);
    }

    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
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
 * The rescue copy can itself fail (most commonly for the same reason the
 * original operation failed, e.g. `output`'s directory doesn't exist). That
 * must not surface as a bare fs error that mentions neither the real
 * failure nor the fact that this call was already charged, so it's caught
 * and folded into the same informative `VideoKitError`. */
async function rescueAndThrow(
  stage: string,
  cause: unknown,
  duckedPath: string,
  output: string,
): Promise<never> {
  const recoveredPath = `${output}.ducked.wav`;
  const reason = cause instanceof Error ? cause.message : String(cause);
  let rescueNote: string;
  try {
    await copyFile(duckedPath, recoveredPath);
    rescueNote =
      `The ducked audio was saved to ${recoveredPath} so you can recover it locally ` +
      `(e.g. retry the mux, or move the file into place yourself) instead of calling ` +
      `duckMusicUnderSpeech again, which would incur another charge.`;
  } catch (rescueErr) {
    // copyFile itself isn't atomic: a failure partway through (most likely
    // ENOSPC -- also the likely cause of the original failure) would
    // otherwise leave a truncated, or previously-good-now-clobbered, file at
    // recoveredPath, exactly the kind of half-written "deliverable" this
    // whole rescue exists to prevent. Remove it rather than leave the user
    // trusting a corrupt recovery file.
    await rm(recoveredPath, { force: true }).catch(() => {});
    const rescueReason = rescueErr instanceof Error ? rescueErr.message : String(rescueErr);
    rescueNote =
      `Attempting to also save the ducked audio to ${recoveredPath} ALSO failed ` +
      `(${rescueReason}), so the mix could not be recovered locally -- calling ` +
      `duckMusicUnderSpeech again will incur another charge.`;
  }
  throw new VideoKitError(
    `${stage} failed, after the ducking API had already run and been billed for this ` +
      `video's duration. ${rescueNote} Original error: ${reason}`,
  );
}
