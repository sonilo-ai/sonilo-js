import { spawn } from "node:child_process";
import { FfmpegError, FfmpegNotFoundError, VideoKitError } from "./errors.js";

const STDERR_TAIL_CHARS = 4096;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Spawn a binary with argv (never a shell). Rejects with FfmpegNotFoundError
 * (ENOENT) or FfmpegError (non-zero exit / timeout). */
export function runProcess(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfmpegError(`${binary} timed out after ${timeoutMs} ms`, null, stderr.slice(-STDERR_TAIL_CHARS)));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STDERR_TAIL_CHARS * 2) stderr = stderr.slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new FfmpegNotFoundError(binary) : new VideoKitError(String(err.message)));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${binary} failed`, code, stderr.slice(-STDERR_TAIL_CHARS)));
    });
  });
}

export interface ProbeResult {
  /** The CONTAINER duration (ffprobe's `format.duration`): the maximum over all
   * streams, so for a video whose audio track outlives its picture this is the
   * AUDIO's length, not the picture's. Correct as a target for a mix that may
   * only pad the audio and must never truncate the picture (see mix.ts); wrong
   * for anything metered on, or trimmed to, the picture (see
   * `videoDurationSeconds`). */
  durationSeconds: number;
  hasAudio: boolean;
  audioCodec: string | null;
  /** Codec of the genuine picture stream, or null when there isn't one —
   * an audio-only file, or one whose only "video" stream is attached cover
   * art. Null means `muxVideoWithAudio`'s `-map 0:V` would match nothing. */
  videoCodec: string | null;
  /** Duration of the genuine picture stream, or null when there isn't one.
   * This — not `durationSeconds` — is the length of picture the viewer
   * actually receives, and the length the ducking API bills a video on
   * (`min(audio, picture)`). */
  videoDurationSeconds: number | null;
}

export async function probeVideo(video: string, ffprobePath: string): Promise<ProbeResult> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    video,
  ]);
  interface FfprobeJson {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      duration?: string;
      disposition?: { attached_pic?: number };
    }>;
  }
  const parsed = JSON.parse(stdout) as FfprobeJson;
  const durationSeconds = Number(parsed.format?.duration);
  // Non-positive/unreadable duration: fail loudly. Rendering anyway would let
  // ffmpeg exit 0 on a silent empty file (sonilo-web lesson).
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoKitError(`Could not determine a valid duration for ${video}; refusing to render`);
  }
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
  // A genuine picture, NOT embedded cover art (`disposition.attached_pic = 1`,
  // the standard ID3/MP4 album-art tag on MP3/M4A/FLAC). An audio file with
  // cover art reports a `codec_type=video` stream and would otherwise look
  // like a video here — while `muxVideoWithAudio`'s `-map 0:V` (capital V)
  // excludes exactly those streams and would then match nothing at all. This
  // definition and that selector must agree.
  const videoStream = parsed.streams?.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  );
  // The picture's OWN duration. Some containers carry no per-stream duration
  // (e.g. some MKV muxers omit it): fall back explicitly to the container
  // duration, which is the best available estimate there.
  let videoDurationSeconds: number | null = null;
  if (videoStream !== undefined) {
    const streamDuration = Number(videoStream.duration);
    videoDurationSeconds =
      Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : durationSeconds;
  }
  return {
    durationSeconds,
    hasAudio: audioStream !== undefined,
    audioCodec: audioStream?.codec_name ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    videoDurationSeconds,
  };
}

/** Integrated LUFS via ebur128. NEVER throws — null means "unmeasurable",
 * mirroring sonilo-web AudioMixAnalyzer's never-throw policy. */
export async function measureIntegratedLufs(
  audioPath: string,
  ffmpegPath: string,
): Promise<number | null> {
  try {
    const { stderr } = await runProcess(ffmpegPath, [
      "-hide_banner", "-nostats",
      "-i", audioPath,
      "-af", "ebur128",
      "-f", "null", "-",
    ]);
    const matches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
    const last = matches[matches.length - 1];
    if (!last) return null;
    const value = Number(last[1]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Pre-extract the video's audio track to a standalone .m4a. The mix step must
 * never pull audio from the video input while also outputting its video —
 * ffmpeg's muxer can deadlock on large files (sonilo-web repro: 141 MB 4K).
 *
 * `trimToSeconds` (optional) caps the extraction at that many seconds, as an
 * OUTPUT option (`-t` after the input), so no container — however long its
 * audio stream claims to be — yields more audio than asked for. duckMusicUnderSpeech
 * passes the PICTURE's duration: the extracted track is what gets uploaded to
 * (and billed by) the ducking API, and billing for audio the viewer never
 * receives is an overcharge. Omitted by callers that want the whole track
 * (mix.ts, whose mix pads rather than truncates). */
export async function extractAudio(
  video: string,
  outPath: string,
  audioCodec: string | null,
  ffmpegPath: string,
  trimToSeconds?: number,
): Promise<void> {
  const codecArgs = audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];
  const trimArgs =
    trimToSeconds !== undefined && Number.isFinite(trimToSeconds) && trimToSeconds > 0
      ? ["-t", trimToSeconds.toFixed(3)]
      : [];
  await runProcess(ffmpegPath, ["-y", "-i", video, "-vn", ...codecArgs, ...trimArgs, outPath]);
}

/** Replace a video's audio with `audioPath`, copying the picture untouched.
 *
 * `-map 0:V` (capital V) selects video streams EXCLUDING attached pictures.
 * Lowercase `0:v` also maps embedded cover art (common in MKV/M4V/iTunes
 * exports); that stream is one packet long, so a length-limited mux stops
 * before any real video or audio packet is written — and ffmpeg still exits 0,
 * yielding a "successful" file of a few hundred bytes with no audio at all.
 *
 * The audio is trimmed and silence-padded to `durationSeconds` rather than
 * using `-shortest`, so a mix that runs short can never truncate the picture. */
export async function muxVideoWithAudio(
  video: string,
  audioPath: string,
  outPath: string,
  durationSeconds: number,
  ffmpegPath: string,
): Promise<void> {
  const dur = durationSeconds.toFixed(3);
  await runProcess(ffmpegPath, [
    "-y",
    "-i", video,
    "-i", audioPath,
    "-filter_complex",
    `[1:a]atrim=end=${dur},asetpts=N/SR/TB,apad=whole_dur=${dur}[aout]`,
    "-map", "0:V",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    outPath,
  ]);
}
