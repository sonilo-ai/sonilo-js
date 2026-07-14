import { spawn } from "node:child_process";
import { FfmpegError, FfmpegNotFoundError, VideoKitError } from "./errors.js";

/** The silent audio the mux dry run (`probeMuxFeasibility`) encodes to aac.
 *
 * Synthesised (lavfi), never taken from the video itself, for the same reason
 * the real mux's audio comes from a filter graph and not from the input: the
 * question is whether the CONTAINER can hold the copied picture and an aac
 * track, and that question must not be able to fail for an unrelated reason.
 * The video's own audio would introduce one — an aac stream that `extractAudio`
 * would happily `-c:a copy` but that this decode chokes on would be REFUSED a
 * mix it could actually have received. Silence cannot fail to decode.
 *
 * Bounded (`d=0.05`) rather than infinite-with-`-frames:a`, so the input EOFs on
 * its own and termination never depends on ffmpeg's "all output streams have hit
 * their frame limit" bookkeeping. */
const MUX_PROBE_SILENCE = "anullsrc=r=44100:cl=stereo:d=0.05";

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
  /** Where libavformat thinks this stream's presentation BEGINS. Load-bearing
   * twice over: it is the start the `duration` FIELD is measured from (so the
   * field is a length from HERE, not from the timeline's zero), and on MPEG-TS it
   * is also the REBASE ORIGIN itself. See THE TIME MODEL. */
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
  /** `start_time` is the CONTAINER's clock offset (0 for most files, nonzero for
   * MPEG-TS, and for any container written with `-output_ts_offset`/`-copyts`),
   * and `format_name` is the demuxer libavformat picked. Both are load-bearing:
   * together they give the REBASE ORIGIN (see `rebaseOriginSeconds`). */
  format?: { duration?: string; start_time?: string; format_name?: string };
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

/** Below this, a timestamp is "zero". Deliberately TIGHT (1 ms). The phantom
 * start a fragmented MP4 reports is `2/fps`, which is only 0.08 s at 25 fps; a
 * generous epsilon would wave exactly the file this exists for straight back
 * onto the path that underbills it. */
const START_AT_ORIGIN_EPSILON = 1e-3;

/* ===========================================================================
 * THE TIME MODEL
 * ===========================================================================
 *
 * ONE definition, and every tier below is a conversion INTO it. Six rounds of
 * billing bugs all had the same shape: each metadata source states the picture's
 * timing in ITS OWN CONVENTION, and each round hard-coded an assumption about one
 * of them. So state the target once:
 *
 *     D  =  E  -  O
 *
 *     D = what we bill and what we mux to: THE END OF THE PICTURE ON THE
 *         PRESENTATION TIMELINE FFMPEG WILL ACTUALLY OUTPUT. Not "how much
 *         picture there is" -- a picture that starts late still occupies the
 *         lead-in, and the deliverable runs to where the picture ENDS.
 *
 *     E = the picture's END on the INPUT timeline: max(timestamp + duration)
 *         over the picture's packets.
 *
 *     O = the REBASE ORIGIN: the input timestamp ffmpeg maps to output zero
 *         (see `rebaseOriginSeconds`).
 *
 * The conventions each source is written in, MEASURED (never assumed) across the
 * container matrix, and the correction each therefore needs:
 *
 *   source                        | convention                    | E is...
 *   ------------------------------|-------------------------------|-----------------
 *   format.duration               | max over ALL streams          | NOT the picture. Never used here.
 *   streams[].duration (field)    | a LENGTH from the stream's    | field + stream.start_time
 *                                 | own start: libavformat sets   |
 *                                 | it to packet_span - start_time|
 *   streams[].duration (backfill) | the CONTAINER's duration,     | unrelated to the picture. Rejected.
 *                                 | copied in when the demuxer    |
 *                                 | cannot time the track         |
 *   tags.DURATION (Matroska)      | an END POSITION from the      | the tag itself
 *                                 | container's zero -- a         |
 *                                 | position, NOT a length        |
 *   raw packet pts                | the CODED timeline; an edit   | max(pts + duration)
 *                                 | list is NOT applied and       |
 *                                 | surfaces as negative pts      |
 *
 * Both metadata conversions were verified to hold exactly (`tag == E`, and
 * `field + start_time == E`, on every container in the matrix, at clock offsets
 * of 0.5/2/10/30 s). But they are only EXPLOITED where the conversion is the
 * IDENTITY -- i.e. where the origin is already zero, so the correction is a
 * no-op and the source's convention cannot matter. Anything needing a nonzero
 * correction is MEASURED instead, because a measurement observes E directly
 * rather than trusting a muxer to have shared libavformat's bookkeeping. That
 * single rule is what subsumes all six rounds of special cases.
 * ======================================================================== */

/** O: THE REBASE ORIGIN — the input timestamp ffmpeg maps to output zero.
 *
 * This is the one irreducibly CONTAINER-DEPENDENT quantity in the model, and it
 * is not a matter of taste: `pcr.ts` and `copyts.mp4` (the standard TS -> MP4
 * archive remux) are IDENTICAL on every timing field ffprobe reports --
 * format.start_time=4.272, stream.start_time=4.400, duration=10.000, packets
 * spanning 4.400..14.400 -- and their delivered pictures differ by 0.128 s
 * (10.000 vs 10.128). No function of the metadata can tell them apart. Only the
 * demuxer's identity can, so the model reads it:
 *
 *  - MPEG-TS / MPEG-PS (libavformat flags these AVFMT_TS_DISCONT: a broadcast
 *    clock with no meaningful file-relative zero, free to wrap and jump).
 *    ffmpeg discards that clock and zeroes the stream on ITS OWN first
 *    timestamp, so O is the PICTURE's `start_time`, not the container's.
 *    Measured: a TS whose PCR starts at 4.4 and whose picture ends at 14.4
 *    delivers exactly 10.0 s of picture.
 *
 *  - Every file-based container (MP4, MOV, MKV, WebM, AVI, FLV, fragmented MP4).
 *    ffmpeg subtracts the CONTAINER's `start_time` (`ts_offset = -start_time`),
 *    so O is `format.start_time` -- even where that differs from the picture's
 *    own start, which is precisely the FLV case: an FLV reports
 *    format.start_time=0.057 and a video stream starting at 0.080, ffmpeg
 *    rebases by 0.057, and the picture therefore lands at [0.023, 10.023] in the
 *    deliverable. Billing on the picture's own first packet instead (0.080)
 *    lands 0.021 s short -- the picture outlives the audio, leaving a one-frame
 *    silent tail, and the customer's last 21 ms of speech is never uploaded.
 *
 * NOT the picture's first PACKET, ever, in either branch. That was the old
 * reading, and it is what made the FLV underbill and forced a zero-clamp to stop
 * an edit list's negative pts from dragging the origin below zero. The origin now
 * comes only from DECLARED starts, which an edit list rebases to 0 for us, so a
 * negative pts can no longer reach it and no clamp is needed. */
function rebaseOriginSeconds(format: FfprobeJson["format"], stream: FfprobeStream): number {
  const names = (format?.format_name ?? "").split(",");
  const discontinuous = names.some((n) => n === "mpegts" || n === "mpegtsraw" || n === "mpeg");
  const declared = discontinuous
    ? finiteSeconds(stream.start_time)
    : finiteSeconds(format?.start_time);
  return declared ?? 0;
}

/** Is `seconds` close enough to zero that a correction by it is a no-op? */
function isZero(seconds: number): boolean {
  return Math.abs(seconds) <= START_AT_ORIGIN_EPSILON;
}

/** E, MEASURED: the picture's END on the input timeline, from its own packets.
 *
 *     E = max(timestamp + packet duration)
 *
 * An END, deliberately -- never the span `max - min`, which is wrong in BOTH
 * directions, and each error is a real file:
 *
 *  - `max - min` OVERBILLS an EDIT-LIST MP4 by 1.25x. Raw packet timestamps do
 *    NOT have the edit list applied, and an elst surfaces as NEGATIVE pts:
 *    `ffmpeg -ss 2 -c copy` (and every iPhone trim) keeps all 250 coded frames
 *    of a 10 s source with pts running -2.000 .. 8.000. The span is 10.000; the
 *    picture the viewer receives is 8.000. Taking the END alone ignores min
 *    entirely, so the discarded frames cannot inflate anything -- and, unlike a
 *    clamp bolted onto the origin, that is true by CONSTRUCTION rather than by
 *    a guard someone has to remember to keep.
 *
 *  - `max - min` UNDERBILLS a picture that genuinely begins part-way into the
 *    timeline (a fragmented MP4 at pts 0.4; an MKV whose video track starts
 *    0.5 s after its audio). Subtracting that lead-in bills 10.0 s for a picture
 *    that runs to 10.4 s and CUTS THE SPEECH OFF. The picture occupies
 *    [0.4, 10.4] of the deliverable; the deliverable is as long as where it ENDS.
 *
 * Timestamps, not a packet COUNT divided by a frame rate: MPEG-TS reports
 * `avg_frame_rate=0/0`, so a count/fps measurement returns nothing for exactly
 * the container that needs measuring most. Falls back from `pts_time` to
 * `dts_time` because AVI carries no presentation timestamps at all
 * (`pts_time=N/A` on every packet), and takes the max rather than the last
 * because B-frames put pts out of order.
 *
 * Demuxes, never decodes: measured 543 ms (MPEG-TS) / 160 ms (fragmented MP4) on
 * a 649 MB 4K file. Only files whose metadata needs a nonzero correction reach it
 * -- MPEG-TS, fragmented MP4, FLV, and the rare container carrying a clock
 * offset. MP4/MOV/MKV/WebM/AVI, edit-list MP4 included, are answered from the
 * probe already in hand (23/22/57 ms) and never demux. Returns null when the
 * picture has no timestamped packets at all, which is a file with no picture to
 * bill for. */
async function measurePictureEnd(
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
    if (end === null || until > end) end = until;
  }
  return end;
}

/** D: the picture's end on the timeline ffmpeg will output — the length of
 * picture the viewer receives, the length the deliverable runs to, and the length
 * the ducking API bills on. See THE TIME MODEL above: D = E - O, and every tier
 * here is a conversion of one source's convention into E.
 *
 * NEVER the container's `format.duration`, which is ffprobe's maximum over ALL
 * streams: for a video whose audio outlives its picture (routine encoder padding)
 * that is the AUDIO's length, and billing it overcharges for seconds nobody
 * receives.
 *
 * The tiers, cheapest first. A metadata tier is used ONLY where its conversion
 * into E is the IDENTITY, so no source's convention is ever relied on under a
 * nonzero correction; anything else is MEASURED.
 *
 * There is deliberately no tier 4. A picture whose end cannot be established
 * makes probeVideo THROW, before anything is uploaded or charged, rather than
 * report a number that came from another stream. */
async function pictureDurationSeconds(
  video: string,
  stream: FfprobeStream,
  format: FfprobeJson["format"],
  containerSeconds: number,
  ffprobePath: string,
): Promise<number | null> {
  const origin = rebaseOriginSeconds(format, stream);
  const tolerance = frameTolerance(stream);
  // The picture can never outlive the container: format.duration is the maximum
  // over ALL streams, this one included. A figure that claims otherwise is not
  // this picture's, whatever it says -- fall through and measure.
  const plausible = (seconds: number | null): seconds is number =>
    seconds !== null && seconds > 0 && seconds <= containerSeconds + tolerance;

  // TIER 1 -- the Matroska/WebM DURATION TAG.
  //
  // CONVENTION: an END POSITION measured from the container's zero. A position,
  // not a length: it already includes any lead-in before the picture starts, and
  // it already includes any clock offset the container carries.
  // CORRECTION: E = tag, so D = tag - O.
  //
  // Applied ONLY when O is zero, which is every Matroska a `-c copy` remux ever
  // wrote (that normalizes start_time to 0) and so every everyday MKV/WebM -- the
  // correction is then a no-op and the tag's convention cannot matter. When the
  // container DOES carry a clock offset (`-copyts`, the standard TS->MKV
  // timestamp-preserving archive step; `-output_ts_offset`; any segmented, live
  // or hardware-recorder muxer that starts its tracks at a nonzero timecode) the
  // tag overstates the picture by exactly that offset -- 11.606 s billed for a
  // 10.000 s picture, and 4.00x at a 30 s offset, UNBOUNDED -- and the file is
  // measured instead of guessed at. Matroska is the only container exposed to
  // that, because it is the only one carrying this tag; the identical MP4 has no
  // tag and measures already.
  if (isZero(origin)) {
    const tagEnd = durationTagSeconds(stream.tags);
    if (plausible(tagEnd)) return tagEnd;
  }

  // TIER 2 -- the per-stream `duration` FIELD (MP4/MOV/AVI/TS).
  //
  // CONVENTION: a LENGTH measured from the STREAM's own start. libavformat sets
  // `st->duration = packet_span - st->start_time`.
  // CORRECTION: E = field + stream.start_time, so D = field + start_time - O.
  //
  // Applied ONLY when that correction is the IDENTITY -- i.e. when the stream's
  // own start and the rebase origin coincide, so `+ start_time - O` cancels and
  // the field can be handed back untouched. Written as the one condition it
  // actually is (`start_time - O == 0`) rather than as two separate zero-checks,
  // so there is nothing here whose necessity cannot be demonstrated.
  //
  // That covers every ordinary MP4/MOV/AVI (both zero), every EDIT-LIST MP4 (the
  // elst rebases presentation to 0, so those legitimately report `duration=8.0`
  // for 250 coded frames of a 10 s source -- and 8.0 is what `-c:v copy`
  // delivers, so 8.0 is the correct bill; measuring on the "disagreement" with
  // nb_frames/avg_frame_rate would bill 10 s for an 8 s deliverable, a 1.25x
  // overbill on the commonest video on earth), and a well-formed MPEG-TS, where
  // the stream's start IS the origin and the PCR offset therefore cancels exactly.
  //
  // When it does NOT cancel, the field was measured from a start that is not the
  // one ffmpeg will rebase by, and the gap is one of two incompatible things that
  // METADATA CANNOT TELL APART: a PHANTOM (fragmented MP4, where libavformat takes
  // `start_time` from the first packet in DECODE order -- under B-pyramid not the
  // smallest pts -- so the field understates the picture by `2/fps`, underbilling
  // up to 0.80x and CUTTING THE USER'S SPEECH OFF), or a REAL lead-in (an MP4/MKV
  // whose video track legitimately starts after its audio, where the field
  // understates the picture by the lead-in). So it is not guessed at: it is
  // measured.
  const field = positiveSeconds(stream.duration);
  const streamStart = finiteSeconds(stream.start_time) ?? 0;
  // The correction `E = field + start_time`, then `D = E - O`. Identity iff zero.
  const fieldCorrection = streamStart - origin;
  // A BACKFILLED field is not this stream's at all. When libavformat cannot time
  // a track from its packets (a picture whose packets are sparse in the byte
  // stream: low frame rate, few frames) it fills `st->duration` in FROM THE
  // CONTAINER's Duration, and ffprobe prints a video-stream `duration` that is
  // really the max over all streams, i.e. the audio's length. An ffmpeg-written
  // 10 s/1 fps MKV under a 30 s audio track carries BOTH `duration='30.023000'`
  // (the audio's) and `tags.DURATION='00:00:10.000000000'` (the picture's), and
  // billing the field is a 3x overcharge. Spotted by what it is
  // indistinguishable from: it equals `format.duration`, and the stream carries
  // no per-track frame accounting (see `framesAccountedPerTrack`) to say the
  // demuxer ever tracked it separately.
  const backfilledFromContainer =
    field !== null &&
    Math.abs(field - containerSeconds) <= tolerance &&
    !framesAccountedPerTrack(stream);
  if (isZero(fieldCorrection) && !backfilledFromContainer && plausible(field)) {
    return field;
  }

  // TIER 3 -- MEASURE E from the picture's own packets, and rebase it.
  const end = await measurePictureEnd(video, stream.index, ffprobePath);
  if (end === null) return null;
  const duration = end - origin;
  return duration > 0 ? duration : null;
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
      parsed.format,
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

/** CAN THIS PICTURE BE STREAM-COPIED INTO THIS CONTAINER AT ALL? Asked by
 * DRY-RUNNING THE REAL MUX, before anything is uploaded or charged.
 *
 * `probeVideo` succeeding does not answer this, and two everyday files prove it:
 *
 *  - a LOW-FRAME-RATE MPEG-TS, whose picture ffprobe reports as `width=0
 *    height=0` (the demuxer never gathers codec parameters from packets that
 *    sparse) while every duration guard passes, because the time model measures
 *    packets. The mux then dies with "dimensions not set" / "Could not write
 *    header";
 *  - an h264 source with a `.webm` `output` -- an ORDINARY USER MISTAKE, a wrong
 *    file extension. WebM carries only VP8/VP9/AV1, so `-c:v copy` cannot write
 *    it, and the mux dies with "Could not write header".
 *
 * Both were knowable up front; both used to be discovered at the mux, which runs
 * AFTER the ducking API has been called and the account CHARGED. Hence this.
 *
 * The question is put to FFMPEG, not to a hand-written codec/container
 * compatibility matrix: such a matrix is exactly the thing that goes stale, and
 * a wrong entry either charges for a mux that then fails (too permissive) or
 * REFUSES A VIDEO THE USER COULD HAVE DUCKED (too strict -- worse). So this runs
 * the SAME argv shape as `muxVideoWithAudio` -- `-map 0:V`, `-c:v copy`, `-c:a
 * aac`, and an output path carrying the CALLER'S OWN extension, from which
 * ffmpeg infers the identical muxer -- and simply asks whether ffmpeg can write
 * the header and a frame. It cannot pass while the real mux fails: the
 * compatibility check ffmpeg performs is the muxer's own `write_header`, which is
 * where both failures above land.
 *
 * ONE FRAME, not zero. Writing the header alone is not enough, and an existing
 * fixture proves it: h264 out of Matroska into `.avi` passes `write_header` and
 * then fails on the FIRST PACKET ("h264 bitstream malformed, no startcode found,
 * use the bitstream filter 'h264_mp4toannexb'"), because AVI wants Annex-B and
 * the copied packets are AVCC. A header-only check would wave that straight
 * through to a post-charge mux failure. Copying one real packet exercises the
 * muxer's `write_packet` too, which is where every bitstream-format mismatch
 * lands.
 *
 * `-frames:v 1` is what makes it CHEAP: ffmpeg opens the input, writes the
 * header, copies ONE video packet, writes the trailer, and stops. Measured on a
 * 1156 MB / 120 s 4K h264 file: 20-40 ms (MP4), 50 ms (MKV, fragmented MP4),
 * 60 ms (MPEG-TS) -- an order of magnitude cheaper than the packet measurement
 * `probeVideo` already performs on the same file (670 ms), and 10x cheaper than
 * the real mux (320 ms). Cost does not grow with the file: nothing past the
 * first frame is ever read.
 *
 * `outPath` must carry the caller's `output` extension and is disposable: it is
 * written to (a header, one frame, a trailer -- a few hundred KB at 4K) and
 * never read. Returns the reason instead of throwing, because the caller has a
 * far better error to throw than ffmpeg's stderr. A missing binary still throws:
 * that is not a verdict on the video. */
export async function probeMuxFeasibility(
  video: string,
  outPath: string,
  ffmpegPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await runProcess(ffmpegPath, [
      "-y",
      "-v", "error",
      "-i", video,
      "-f", "lavfi",
      "-i", MUX_PROBE_SILENCE,
      "-map", "0:V",
      "-map", "1:a",
      "-c:v", "copy",
      "-c:a", "aac",
      "-frames:v", "1",
      outPath,
    ]);
    return { ok: true };
  } catch (err) {
    // A non-zero exit is the ANSWER (this container cannot hold this picture).
    // Anything else -- ffmpeg missing, a timeout -- is not a verdict on the
    // video and must not be reported as one.
    if (err instanceof FfmpegError) {
      // The FIRST lines, not FfmpegError's usual LAST three. Under `-v error`
      // ffmpeg prints the CAUSE first ("Only VP8 or VP9 or AV1 video ... are
      // supported for WebM."; "dimensions not set"; "Could not write header")
      // and the CONSEQUENCES after it ("Task finished with error code -22",
      // "Nothing was written into output file"). Quoting the tail hands the user
      // three lines of downstream noise and throws away the one sentence that
      // tells them what is actually wrong with their file.
      const lines = err.stderrTail.trim().split("\n").filter((l) => l.trim().length > 0);
      return { ok: false, reason: lines.slice(0, 3).join(" | ") };
    }
    throw err;
  }
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
