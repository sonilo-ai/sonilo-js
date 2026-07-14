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
   * (`min(audio, picture)`). Established from the PICTURE alone (see
   * `pictureDurationSeconds`); a file whose picture's duration cannot be
   * established at all makes probeVideo throw rather than report a number that
   * came from another stream. */
  videoDurationSeconds: number | null;
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  duration?: string;
  /** Per-track frame accounting. Its VALUE is not a usable cross-check (see
   * `framesAccountedPerTrack`), but its PRESENCE says the demuxer tracks this
   * stream's samples individually — which is what makes its `duration` its own
   * rather than a copy of the container's. */
  nb_frames?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
  disposition?: { attached_pic?: number };
}

interface FfprobeJson {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

function positiveSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** `HH:MM:SS.nnnnnnnnn` (Matroska's per-stream DURATION tag) or plain seconds. */
function parseDurationValue(value: string): number | null {
  const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  if (match === null) return positiveSeconds(value);
  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Matroska/WebM carry each track's own length as a TAG (`DURATION`, or a
 * language-suffixed `DURATION-eng`), AUTHORED PER TRACK by the muxer. Unlike
 * the `duration` FIELD (see `pictureDurationSeconds`), a tag is never
 * synthesized from the container, so it stays correct even when libavformat
 * cannot derive the track's timing from its packets. */
function durationTagSeconds(tags: Record<string, string> | undefined): number | null {
  if (tags === undefined) return null;
  for (const [key, value] of Object.entries(tags)) {
    const name = key.toUpperCase();
    if (name !== "DURATION" && !name.startsWith("DURATION-")) continue;
    const seconds = typeof value === "string" ? parseDurationValue(value) : null;
    if (seconds !== null) return seconds;
  }
  return null;
}

function parseRational(value: string | undefined): number | null {
  if (value === undefined) return null;
  const [numerator, denominator] = value.split("/");
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null;
  return n / d;
}

/** How far a duration may legitimately sit from another measure of the same
 * picture: the LAST FRAME IS DISPLAYED FOR 1/fps, so a figure that counts it
 * and one that stops at its presentation time differ by exactly that much (a
 * whole second at 1 fps). Plus a hair for rounding. Clamped so an absurd frame
 * rate cannot widen it without bound; 0.5 s when the frame rate is unknown,
 * which is itself a symptom (MPEG-TS reports `avg_frame_rate=0/0`). */
function frameTolerance(stream: FfprobeStream): number {
  const fps = parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate);
  if (fps === null) return 0.5;
  return Math.min(Math.max(1 / fps + 0.05, 0.05), 2);
}

/** Does the demuxer account for this track's frames INDIVIDUALLY?
 *
 * Deliberately a presence check, never a value check. `nb_frames / avg_frame_rate`
 * looks like a free second opinion on the picture's length, and the temptation
 * is to compare the two and measure on disagreement — but it is not one, in
 * either direction:
 *
 *  - For MP4/MOV it is CIRCULAR. ffprobe derives `avg_frame_rate` as
 *    nb_frames / duration, so the quotient reproduces the `duration` field by
 *    construction and can never contradict it — including when the field is
 *    wrong (a gappy VFR mp4 with 15 frames and a 0.6 s field reports
 *    avg_frame_rate=25, and 15/25 = 0.6 "agrees").
 *  - Where it is NOT circular it is WRONG. An edit-list mp4 (`ffmpeg -ss -c copy`,
 *    and every iPhone clip) keeps all 250 coded frames of a 10 s source while
 *    presenting 8 s: nb_frames/avg_frame_rate = 10 s, the field says 8 s, and the
 *    FIELD is right — `-c:v copy` applies the edit list, so 8 s is what the mux
 *    delivers. Measuring on that "disagreement" would bill 10 s for an 8 s
 *    deliverable: a 1.25x overbill on the single most common video on earth.
 *
 * What the FIELD's presence does tell us is that this container tracks the
 * stream's samples on their own — which is exactly the property that makes its
 * `duration` the stream's own rather than a copy of the container's. */
function framesAccountedPerTrack(stream: FfprobeStream): boolean {
  return positiveSeconds(stream.nb_frames) !== null;
}

/** MEASURE the picture: the span its own packets occupy on the timeline,
 * `max(timestamp + packet duration) - min(timestamp)`.
 *
 * Timestamps, not a packet COUNT divided by a frame rate: MPEG-TS reports
 * `avg_frame_rate=0/0`, so the old count/fps measurement returned null for
 * exactly the container that needs measuring most. Falls back from `pts_time`
 * to `dts_time` because AVI carries no presentation timestamps at all
 * (`pts_time=N/A` on every packet), and takes min/max rather than
 * first/last because B-frames put pts out of order and MPEG-TS starts its
 * clock at an arbitrary offset (1.4 s, routinely).
 *
 * Demuxes, never decodes: 0.05 s (mp4) / 0.08 s (mkv) / 0.15 s (ts) on a
 * 287 MB 4K file. Only containers that offer no trustworthy per-track metadata
 * (MPEG-TS, FLV) ever reach it; MP4/MOV/MKV/WebM/AVI are answered from the
 * probe already in hand. Returns null when the picture has no timestamped
 * packets at all, which is a file with no picture to bill for. */
async function measurePictureSpan(
  video: string,
  streamIndex: number | undefined,
  ffprobePath: string,
): Promise<number | null> {
  // Select the picture by ABSOLUTE index, not `v:0`: in a file that also
  // carries attached cover art, `v:0` may well be the cover art.
  const selector = typeof streamIndex === "number" ? String(streamIndex) : "v:0";
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-select_streams", selector,
    "-show_entries", "packet=pts_time,dts_time,duration_time",
    "-of", "csv=p=0",
    video,
  ]);
  let start: number | null = null;
  let end: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [ptsText, dtsText, durText] = line.split(",");
    const pts = Number(ptsText);
    const dts = Number(dtsText);
    // "N/A" -> NaN. AVI has no pts; prefer pts, fall back to dts.
    const at = Number.isFinite(pts) ? pts : Number.isFinite(dts) ? dts : null;
    if (at === null) continue;
    const dur = Number(durText);
    const until = at + (Number.isFinite(dur) && dur > 0 ? dur : 0);
    if (start === null || at < start) start = at;
    if (end === null || until > end) end = until;
  }
  if (start === null || end === null) return null;
  const span = end - start;
  return span > 0 ? span : null;
}

/** The PICTURE's own duration — the length of picture the viewer receives, and
 * the length the ducking API bills on. NEVER the container's `format.duration`,
 * which is ffprobe's maximum over ALL streams: for a video whose audio outlives
 * its picture (routine encoder padding) that is the AUDIO's length, and billing
 * it overcharges for seconds nobody receives.
 *
 * The sources, in the order they can be trusted:
 *
 *  1. The per-track DURATION TAG (Matroska/WebM). Authored per track by the
 *     muxer; never synthesized from the container.
 *
 *  2. The per-stream `duration` FIELD (MP4/MOV/AVI). Genuinely the track's own
 *     -- and edit-list-adjusted, so it is what `-c:v copy` will actually deliver
 *     -- EXCEPT when it is a container backfill. When libavformat cannot
 *     establish a track's timing from its packets (a picture whose packets are
 *     sparse in the byte stream: low frame rate, few frames) it fills
 *     `st->duration` in FROM THE CONTAINER'S Duration element, and ffprobe then
 *     prints a video-stream `duration` that is really the max over all streams,
 *     i.e. the audio's length. An ordinary ffmpeg-written 10 s/1 fps MKV under a
 *     30 s audio track carries BOTH: `duration='30.023000'` (the audio's) and
 *     `tags.DURATION='00:00:10.000000000'` (the picture's). Preferring the tag
 *     is what keeps that file from being billed at 3.3x.
 *
 *     A backfilled field is spotted by what it is indistinguishable from: it
 *     equals `format.duration`, and its stream carries no per-track frame
 *     accounting (see `framesAccountedPerTrack`) to say the demuxer ever
 *     tracked it separately. MPEG-TS and FLV land here -- they have no tag to
 *     rescue them, which is why tier 3 exists.
 *
 *  3. MEASURE the picture from its own packets. Authoritative and
 *     container-agnostic.
 *
 * There is deliberately no tier 4. A picture whose length cannot be established
 * makes probeVideo THROW, before anything is uploaded or charged, rather than
 * report a number that came from another stream. */
async function pictureDurationSeconds(
  video: string,
  stream: FfprobeStream,
  containerSeconds: number,
  ffprobePath: string,
): Promise<number | null> {
  const tolerance = frameTolerance(stream);
  // The picture can never outlive the container: format.duration is the maximum
  // over ALL streams, this one included. A metadata figure that claims otherwise
  // is not this stream's, whatever it says -- fall through and measure.
  const plausible = (seconds: number | null): seconds is number =>
    seconds !== null && seconds <= containerSeconds + tolerance;

  const tagged = durationTagSeconds(stream.tags);
  if (plausible(tagged)) return tagged;

  const field = positiveSeconds(stream.duration);
  const looksLikeTheContainers =
    field !== null &&
    Math.abs(field - containerSeconds) <= tolerance &&
    !framesAccountedPerTrack(stream);
  if (plausible(field) && !looksLikeTheContainers) return field;

  return measurePictureSpan(video, stream.index, ffprobePath);
}

export async function probeVideo(video: string, ffprobePath: string): Promise<ProbeResult> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    video,
  ]);
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
  // The picture's OWN duration, established from the picture alone — never from
  // the container's max-over-all-streams `format.duration`, which is what
  // duck.ts bills on. If it cannot be established, say so instead of quietly
  // substituting a figure that may belong to the audio track.
  let videoDurationSeconds: number | null = null;
  if (videoStream !== undefined) {
    videoDurationSeconds = await pictureDurationSeconds(
      video,
      videoStream,
      durationSeconds,
      ffprobePath,
    );
    if (videoDurationSeconds === null) {
      throw new VideoKitError(
        `Could not determine how long the picture in ${video} runs (its video stream carries ` +
          `no usable duration, no DURATION tag, and no timestamped packets). Refusing to guess: ` +
          `the ducking API bills on this figure, and the container's own duration is the longest ` +
          `of ALL its streams, so guessing from it can overcharge you. Re-encode the file ` +
          `(e.g. \`ffmpeg -i in -c copy out.mp4\`) and try again.`,
      );
    }
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
