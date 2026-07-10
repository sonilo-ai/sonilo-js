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
  durationSeconds: number;
  hasAudio: boolean;
  audioCodec: string | null;
  videoCodec: string | null;
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
    streams?: Array<{ codec_type?: string; codec_name?: string }>;
  }
  const parsed = JSON.parse(stdout) as FfprobeJson;
  const durationSeconds = Number(parsed.format?.duration);
  // Non-positive/unreadable duration: fail loudly. Rendering anyway would let
  // ffmpeg exit 0 on a silent empty file (sonilo-web lesson).
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoKitError(`Could not determine a valid duration for ${video}; refusing to render`);
  }
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  return {
    durationSeconds,
    hasAudio: audioStream !== undefined,
    audioCodec: audioStream?.codec_name ?? null,
    videoCodec: videoStream?.codec_name ?? null,
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
 * ffmpeg's muxer can deadlock on large files (sonilo-web repro: 141 MB 4K). */
export async function extractAudio(
  video: string,
  outPath: string,
  audioCodec: string | null,
  ffmpegPath: string,
): Promise<void> {
  const codecArgs = audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"];
  await runProcess(ffmpegPath, ["-y", "-i", video, "-vn", ...codecArgs, outPath]);
}
