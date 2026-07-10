import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoKitError } from "./errors.js";
import { extractAudio, measureIntegratedLufs, probeVideo, runProcess } from "./ffmpeg.js";
import {
  DELIVERY_TARGET_LUFS,
  FALLBACK_MUSIC_LUFS,
  GAP_BELOW_VOICE_LU,
  MAX_DELIVERY_BOOST_DB,
  OUTPUT_CEILING_DBFS,
  dbToLinear,
  gapGain,
  originalFinalGain,
} from "./loudness.js";

export interface MixWithVideoOptions {
  /** Path to the video file. */
  video: string;
  /** Generated music: Track.audio bytes, or a path to an audio file. */
  audio: Uint8Array | string;
  /** Explicit output path. */
  output: string;
  /** 0–1 slider; 0.5 = matched bed level (voice − 4 LU); ±12 dB span. Default 0.5. */
  musicVolume?: number;
  /** 0–1 absolute; 1 = original as recorded; 0 = replace. Default 1. */
  originalVolume?: number;
  /** Default true. False (or failed measurement) → sliders are absolute gains. */
  loudnessMatch?: boolean;
  /** Default true: final static gain to −14 LUFS (max +12 dB boost), best-effort. */
  normalize?: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
}

function assertSlider(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new VideoKitError(`${name} must be between 0 and 1 (got ${value})`);
  }
}

export async function mixWithVideo(options: MixWithVideoOptions): Promise<string> {
  const {
    video,
    audio,
    output,
    musicVolume = 0.5,
    originalVolume = 1.0,
    loudnessMatch = true,
    normalize = true,
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
  } = options;

  if (!video) throw new VideoKitError("video is required");
  if (!output) throw new VideoKitError("output is required");
  assertSlider("musicVolume", musicVolume);
  assertSlider("originalVolume", originalVolume);

  const workDir = await mkdtemp(join(tmpdir(), "sonilo-video-kit-"));
  try {
    // Music input: bytes are written to a temp file (ffmpeg needs a seekable input).
    let musicPath: string;
    if (typeof audio === "string") {
      musicPath = audio;
    } else {
      musicPath = join(workDir, "music.mp3");
      await writeFile(musicPath, audio);
    }

    const probe = await probeVideo(video, ffprobePath);

    // Pre-extract original audio (never mix straight from the video input —
    // muxer deadlock risk on large files; see src/ffmpeg.ts extractAudio).
    let originalPath: string | null = null;
    if (probe.hasAudio && originalVolume > 0) {
      originalPath = join(workDir, "original.m4a");
      await extractAudio(video, originalPath, probe.audioCodec, ffmpegPath);
    }

    // Gains: matched path measures LUFS; any failure degrades to legacy
    // (slider = absolute gain), mirroring sonilo-web's never-throw analyzer.
    let musicGain = musicVolume;
    let originalGain = originalVolume;
    if (loudnessMatch) {
      const musicLufs = await measureIntegratedLufs(musicPath, ffmpegPath);
      const anchorLufs = originalPath
        ? await measureIntegratedLufs(originalPath, ffmpegPath)
        : FALLBACK_MUSIC_LUFS;
      if (musicLufs !== null && anchorLufs !== null) {
        musicGain = gapGain(anchorLufs - GAP_BELOW_VOICE_LU, musicLufs, musicVolume);
        originalGain = originalFinalGain(originalVolume);
      }
    }

    const ceiling = dbToLinear(OUTPUT_CEILING_DBFS).toFixed(6);
    const limiter = `alimiter=limit=${ceiling}:level=disabled`;
    const mixedPath = normalize ? join(workDir, "mixed.mp4") : output;

    let filter: string;
    let inputs: string[];
    if (originalPath) {
      inputs = ["-i", video, "-i", musicPath, "-i", originalPath];
      filter =
        `[1:a]volume=${musicGain.toFixed(6)}[m];` +
        `[2:a]volume=${originalGain.toFixed(6)}[o];` +
        `[m][o]amix=inputs=2:duration=first:normalize=0,${limiter}[aout]`;
    } else {
      inputs = ["-i", video, "-i", musicPath];
      filter = `[1:a]volume=${musicGain.toFixed(6)},${limiter}[aout]`;
    }

    await runProcess(ffmpegPath, [
      "-y", ...inputs,
      "-filter_complex", filter,
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy", "-c:a", "aac",
      "-shortest",
      mixedPath,
    ]);

    if (normalize) {
      await deliveryNormalize(mixedPath, output, ffmpegPath);
    }
    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** One static gain pass to land the finished file on DELIVERY_TARGET_LUFS.
 * Static volume, never dynamic loudnorm (it would breathe). Best-effort:
 * any failure keeps the un-normalized render. */
async function deliveryNormalize(inPath: string, outPath: string, ffmpegPath: string): Promise<void> {
  try {
    const lufs = await measureIntegratedLufs(inPath, ffmpegPath);
    if (lufs === null) {
      await copyFile(inPath, outPath);
      return;
    }
    const gainDb = Math.min(DELIVERY_TARGET_LUFS - lufs, MAX_DELIVERY_BOOST_DB);
    if (Math.abs(gainDb) < 0.1) {
      await copyFile(inPath, outPath);
      return;
    }
    const ceiling = dbToLinear(OUTPUT_CEILING_DBFS).toFixed(6);
    await runProcess(ffmpegPath, [
      "-y", "-i", inPath,
      "-c:v", "copy",
      "-af", `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${ceiling}:level=disabled`,
      "-c:a", "aac",
      outPath,
    ]);
  } catch {
    await copyFile(inPath, outPath);
  }
}
