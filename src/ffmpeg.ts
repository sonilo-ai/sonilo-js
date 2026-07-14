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
  /** Where libavformat thinks this stream's presentation BEGINS. Load-bearing,
   * and it means two incompatible things depending on the container — which is
   * exactly why `duration` alone cannot be trusted (see `pictureStartsAtOrigin`). */
  start_time?: string;
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
  /** `start_time` is the CONTAINER's clock offset: 0 for every file-based
   * container, but ~1.4 s for MPEG-TS, whose PCR starts at an arbitrary value.
   * It is what tells a real clock offset apart from a phantom one — see
   * `measurePictureSpan`. */
  format?: { duration?: string; start_time?: string };
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

/** Any finite number of seconds, INCLUDING zero and negatives — unlike
 * `positiveSeconds`. `start_time` is legitimately 0.000000 on almost every file,
 * and that is its most important value, so it cannot be parsed with a helper
 * that treats 0 as "absent". */
function finiteSeconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}

/** Below this, a `start_time` is "zero" — a picture that begins at the
 * presentation timeline's origin. Deliberately TIGHT (1 ms). The phantom start
 * a fragmented MP4 reports is `2/fps`, which is only 0.08 s at 25 fps; a
 * generous epsilon would wave exactly the file this guard exists for straight
 * back onto the path that underbills it. */
const START_AT_ORIGIN_EPSILON = 1e-3;

/** Does the picture BEGIN where the presentation timeline does?
 *
 * This is the question that decides whether the per-stream `duration` FIELD can
 * be read as the picture's length, and it is the check whose absence underbilled
 * every fragmented MP4 by up to 0.80x — cutting the user's speech off.
 *
 * libavformat computes `st->duration` as `packet_span - st->start_time`. When
 * `start_time` is 0 — every ordinary MP4/MOV/AVI, and every EDIT-LIST MP4, whose
 * elst rebases presentation to 0 — that subtraction is a no-op and the field IS
 * the picture's length. When `start_time` is NOT 0 the field is a length measured
 * from somewhere else, and `start_time` means one of two incompatible things:
 *
 *  - a PHANTOM, on a fragmented MP4. With no moov to describe the track,
 *    libavformat takes `start_time` from the FIRST PACKET IN DECODE ORDER — which,
 *    with B-pyramid, is not the packet with the smallest pts. A 10 s/1 fps
 *    `+frag_keyframe+empty_moov` file reports `start_time=2.000000` while its
 *    picture's packets genuinely begin at pts 0.000061, so the field reads
 *    `8.023` for 10 s of picture. Uploading 8 s of voice under a 10 s picture
 *    bills 0.80x and CUTS THE LAST TWO SECONDS OF SPEECH OFF. The error is
 *    `2/fps`, so it bites hardest at low frame rates — an OBS "fragmented MP4"
 *    screen share, ffmpeg's own streaming recipe, CMAF/DASH segments,
 *    MediaRecorder output. Both fragmented recipes report it, with and without
 *    `nb_frames`, so neither the frame-accounting signal nor the
 *    looks-like-the-container's comparison catches it: the field (8.02) is
 *    nowhere near the container (30.02).
 *
 *  - a REAL clock offset, on MPEG-TS, whose PCR starts at an arbitrary value
 *    (1.4 s, routinely) that every stream's timestamps sit on top of.
 *
 * The two cannot be told apart from the field alone, and they need OPPOSITE
 * corrections (add the phantom back; subtract the real offset). So do not guess:
 * when the picture does not start at the origin, MEASURE it, where both are
 * resolved against the packets themselves. That costs a demux — but ONLY for
 * fragmented MP4 and MPEG-TS. Every mainstream container (MP4, MOV, MKV, WebM,
 * AVI, and the edit-list MP4 that is the commonest video on earth) reports
 * `start_time=0.000000` and stays on the cheap metadata path.
 *
 * A missing `start_time` is treated as zero: that is the pre-existing reading,
 * and no container in the matrix omits it. */
function pictureStartsAtOrigin(stream: FfprobeStream): boolean {
  const start = finiteSeconds(stream.start_time);
  return start === null || start <= START_AT_ORIGIN_EPSILON;
}

/** MEASURE the picture from its own packets: where its last frame ENDS on the
 * presentation timeline, measured from that timeline's ORIGIN.
 *
 *     duration = max(timestamp + packet duration) - origin
 *
 * Expressed as an END minus an ORIGIN, deliberately, rather than as the span
 * `max - min` it used to be. `max - min` is wrong in BOTH directions, and each
 * error is a real file:
 *
 *  - It OVERBILLS an EDIT-LIST MP4 by 1.25x. Raw packet timestamps do NOT have
 *    the edit list applied, and an elst surfaces as NEGATIVE pts: `ffmpeg -ss 2
 *    -c copy` (and every iPhone trim) keeps all 250 coded frames of a 10 s
 *    source with pts running -2.000 .. 8.000. The span is 10.000; the picture
 *    the viewer receives is 8.000. Frames at negative pts are precisely the
 *    frames the edit list DISCARDS, so the origin is CLAMPED AT ZERO and they
 *    stop inflating the measurement. (This was latent: the only thing keeping an
 *    edit-list file out of this function was an `nb_frames` presence check, and
 *    `nb_frames` is absent on exactly the fragmented MP4s that now measure here.)
 *
 *  - It UNDERBILLS a fragmented MP4, whose picture may genuinely begin part-way
 *    into the timeline (pts 0.4 at 5 fps). Subtracting that 0.4 bills 10.0 s for
 *    a picture that runs to 10.4 s and CUTS THE SPEECH OFF. The picture occupies
 *    [0, 10.4] of the deliverable; its duration is where it ENDS.
 *
 * The origin is zero for every file-based container. The one exception is
 * MPEG-TS, which starts its PCR at an arbitrary offset (1.4 s, routinely) that
 * every stream's timestamps sit on top of and that ffmpeg subtracts on output —
 * so there, and ONLY there, the picture's own first packet establishes the
 * origin. The CONTAINER's `start_time` is what distinguishes the two: it is
 * 0.000000 for a fragmented MP4 (whose per-STREAM start_time is a phantom) and
 * ~1.4 for MPEG-TS (whose offset is real). Clamped at zero either way, so a
 * container that reports a clock offset AND carries an edit list cannot revive
 * the 1.25x.
 *
 * Timestamps, not a packet COUNT divided by a frame rate: MPEG-TS reports
 * `avg_frame_rate=0/0`, so the old count/fps measurement returned null for
 * exactly the container that needs measuring most. Falls back from `pts_time`
 * to `dts_time` because AVI carries no presentation timestamps at all
 * (`pts_time=N/A` on every packet), and takes the max rather than the last
 * because B-frames put pts out of order.
 *
 * NOT "authoritative and container-agnostic", as this comment used to claim —
 * that claim is what let the edit-list flaw sit here unguarded. It is a
 * measurement of RAW packet timestamps, which are the CODED timeline, not the
 * PRESENTED one; the zero-clamp is what reconciles the two, and it is only
 * sound because the sole thing standing between them (an edit list) can only
 * ever DISCARD leading frames, never add any.
 *
 * Demuxes, never decodes: 0.05 s (mp4) / 0.08 s (mkv) / 0.15 s (ts) on a
 * 287 MB 4K file. Only containers whose picture does not start at the timeline
 * origin reach it — fragmented MP4 and MPEG-TS; MP4/MOV/MKV/WebM/AVI, edit-list
 * MP4 included, are answered from the probe already in hand. Returns null when
 * the picture has no timestamped packets at all, which is a file with no picture
 * to bill for. */
async function measurePictureSpan(
  video: string,
  streamIndex: number | undefined,
  containerStartSeconds: number,
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
  let first: number | null = null;
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
    if (first === null || at < first) first = at;
    if (end === null || until > end) end = until;
  }
  if (first === null || end === null) return null;
  // Only a container that declares its own clock offset (MPEG-TS) gets to move
  // the origin off zero, and even then never below it: a negative pts is a frame
  // an edit list throws away, not a timeline that starts early.
  const origin =
    containerStartSeconds > START_AT_ORIGIN_EPSILON ? Math.max(0, first) : 0;
  const duration = end - origin;
  return duration > 0 ? duration : null;
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
 *  2. The per-stream `duration` FIELD (MP4/MOV/AVI), but ONLY when the picture
 *     starts at the presentation timeline's origin (see `pictureStartsAtOrigin`).
 *     libavformat computes the field as `packet_span - start_time`, so it is the
 *     picture's own length exactly when that subtraction is a no-op. That covers
 *     every ordinary MP4/MOV/AVI and -- crucially -- every EDIT-LIST MP4, whose
 *     elst rebases presentation to 0: those legitimately report `duration=8.0`
 *     for 250 coded frames of a 10 s source, and 8.0 is what `-c:v copy`
 *     delivers, so 8.0 is the correct bill.
 *
 *     When the picture does NOT start at the origin the field has been measured
 *     from somewhere else, and that somewhere is either a PHANTOM (fragmented
 *     MP4: `start_time` is the first packet in DECODE order, so the field
 *     understates the picture by `2/fps` and underbills it by up to 0.80x,
 *     cutting the speech off) or a REAL clock offset (MPEG-TS). The two need
 *     opposite corrections and cannot be told apart here, so the file falls
 *     through to tier 3 rather than being guessed at.
 *
 *     The field is ALSO rejected when it is a container backfill. When
 *     libavformat cannot establish a track's timing from its packets (a picture
 *     whose packets are sparse in the byte stream: low frame rate, few frames)
 *     it fills `st->duration` in FROM THE CONTAINER'S Duration element, and
 *     ffprobe then prints a video-stream `duration` that is really the max over
 *     all streams, i.e. the audio's length. An ordinary ffmpeg-written 10 s/1 fps
 *     MKV under a 30 s audio track carries BOTH: `duration='30.023000'` (the
 *     audio's) and `tags.DURATION='00:00:10.000000000'` (the picture's).
 *     Preferring the tag is what keeps that file from being billed at 3.3x. A
 *     backfilled field is spotted by what it is indistinguishable from: it
 *     equals `format.duration`, and its stream carries no per-track frame
 *     accounting (see `framesAccountedPerTrack`) to say the demuxer ever tracked
 *     it separately.
 *
 *  3. MEASURE the picture from its own packets (see `measurePictureSpan`). Not
 *     "authoritative and container-agnostic" -- it reads the CODED timeline, and
 *     has to reconcile it with the PRESENTED one -- but it is the only tier that
 *     resolves a phantom start against reality, and the only one that survives a
 *     container offering no per-track metadata at all (MPEG-TS, FLV).
 *
 * There is deliberately no tier 4. A picture whose length cannot be established
 * makes probeVideo THROW, before anything is uploaded or charged, rather than
 * report a number that came from another stream. */
async function pictureDurationSeconds(
  video: string,
  stream: FfprobeStream,
  containerSeconds: number,
  containerStartSeconds: number,
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
  if (plausible(field) && !looksLikeTheContainers && pictureStartsAtOrigin(stream)) {
    return field;
  }

  return measurePictureSpan(video, stream.index, containerStartSeconds, ffprobePath);
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
    // The CONTAINER's clock offset, not the picture's. 0 for every file-based
    // container; ~1.4 s for MPEG-TS, whose PCR starts at an arbitrary value.
    // It is what tells a real offset apart from a fragmented MP4's phantom one.
    const containerStartSeconds = finiteSeconds(parsed.format?.start_time) ?? 0;
    videoDurationSeconds = await pictureDurationSeconds(
      video,
      videoStream,
      durationSeconds,
      containerStartSeconds,
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
 * (mix.ts, whose mix pads rather than truncates).
 *
 * THE ONE KNOWN, ACCEPTED, BOUNDED OVERBILL. For an aac source this takes the
 * `-c:a copy` path, and A STREAM COPY CANNOT CUT MID-PACKET: `-t 10.000` lands
 * on the next AAC frame boundary, so the uploaded track — and therefore the
 * bill — runs slightly LONG. The overshoot is exactly one AAC frame, 1024
 * samples:
 *
 *     sample rate    worst case    measured
 *     48 kHz          21.3 ms       5.0 ms
 *     44.1 kHz        23.2 ms       8.0 ms
 *
 * It is accepted rather than fixed, on four counts:
 *
 *  - It CANNOT UNDERBILL. A copy only ever rounds UP to a packet boundary, so
 *    the uploaded voice always spans the whole picture and the speech is never
 *    cut off. The dangerous direction is unreachable by construction.
 *  - It is BOUNDED BY ONE AAC FRAME and does not grow with duration: ~21 ms on a
 *    5 s clip and ~21 ms on a 360 s one.
 *  - The server bills STRICTLY LINEARLY — `unit_price * duration_seconds`,
 *    quantized to 0.0001 of a currency unit, with no ceil, no per-second
 *    granularity and no minimum charge (billing_service.calculate_cost;
 *    minute pools likewise divide by 60 without rounding up). So 21 ms costs 21 ms
 *    of money — 0.006% of a maximum-length job — and there is no rounding cliff
 *    that could turn it into a whole extra second.
 *  - Eliminating it means re-encoding, and that is NOT cheap: measured on a
 *    360 s 48 kHz track, `-c:a aac` takes 6.0 s against 51 ms for the copy — 120x,
 *    on the happy path, on EVERY call. Worse, it would impose a lossy AAC->AAC
 *    generation on the very speech the paid ducking API analyses and hands back
 *    inside the mix, degrading the deliverable's audio to save 21 ms of billing.
 *
 * Note the asymmetry this creates and why it is the right way round: the
 * containers that take the re-encode path below (WebM/Opus, AVI/MP3, anything
 * not already aac) come out EXACT, because an encoder can cut anywhere. They pay
 * for that exactness with an encode they were going to need anyway. */
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
