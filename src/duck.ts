import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

    // The API returns the finished mix already delivered at -14 LUFS / -1 dBTP,
    // so there is no local loudness pass to run.
    const duckedPath = join(workDir, "ducked.wav");
    await downloadDuckedMix(result.outputUrl, duckedPath, fetchFn, signal);
    await muxVideoWithAudio(video, duckedPath, output, probe.durationSeconds, ffmpegPath);

    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
