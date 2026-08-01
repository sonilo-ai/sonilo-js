export type SegmentLabel =
  | "intro"
  | "verse"
  | "pre-chorus"
  | "chorus"
  | "bridge"
  | "break"
  | "silence"
  | "outro"
  | "none";

export interface Segment {
  start: number;
  prompt: string;
  label?: SegmentLabel;
}

/** Monetary fields are strings, exactly as the backend serializes them. */
export interface CostInfo {
  billing_rate_per_sec: string;
  billing_before_discount: string;
  billing_after_discount: string;
  discount_factor: string;
}

export interface AudioChunkEvent {
  type: "audio_chunk";
  /** Decoded from the wire's base64 by the SDK. */
  data: Uint8Array;
}

export interface TitleEvent {
  type: "title";
  title: string;
  summary?: string;
  display_tags?: string[];
  [key: string]: unknown;
}

export interface CompleteEvent {
  type: "complete";
  [key: string]: unknown;
}

export interface ErrorEvent {
  type: "error";
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface CostEvent extends CostInfo {
  type: "cost";
}

/** Forward-compatibility: unrecognized event types are passed through. */
export interface UnknownEvent {
  type: string;
  [key: string]: unknown;
}

export type StreamEvent =
  | AudioChunkEvent
  | TitleEvent
  | CompleteEvent
  | ErrorEvent
  | CostEvent
  | UnknownEvent;

export interface Track {
  audio: Uint8Array;
  title?: string;
  cost?: CostInfo;
}

export interface TextToMusicParams {
  prompt: string;
  duration: number;
  segments?: Segment[];
  /** "stream" (default) or "async" (required by `submit()` and by any
   * `outputFormat` other than the m4a default). */
  mode?: "stream" | "async";
  /** Container for the async result. `wav` and `mp3` (320 kbps) are
   * finalize-time transcodes and require `mode: "async"`; m4a is what the
   * stream itself carries. Defaults to m4a server-side. */
  outputFormat?: "m4a" | "wav" | "mp3";
  /** How many distinct music variants to generate in one request (1-10,
   * default 1). Cost scales linearly, and values above 1 are never covered
   * by the free trial. Values above 1 require `mode: "async"` — only
   * meaningful via `submit()`; `stream()`/`generate()` never send it, since
   * they always request a plain stream. */
  variantsNum?: number;
  /** Bounds the stream: aborting this cancels the in-flight generation.
   * Passed straight through to `fetch` — it is never rewrapped as
   * RequestTimeoutError, since the client's own absolute timeout does not
   * apply to streaming music generation. */
  signal?: AbortSignal;
}

/** string = file path (Node.js only). */
export type VideoInput =
  | File
  | Blob
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | string;

export interface VideoToMusicParams {
  video?: VideoInput;
  videoUrl?: string;
  prompt?: string;
  segments?: Segment[];
  /** Bounds the stream: aborting this cancels the in-flight generation.
   * Passed straight through to `fetch` — it is never rewrapped as
   * RequestTimeoutError, since the client's own absolute timeout does not
   * apply to streaming music generation. Only meaningful for `stream()`/
   * `generate()`; `submit()` ignores it. */
  signal?: AbortSignal;
  /** "stream" (the default, used by `stream()`/`generate()`) or "async"
   * (required for `submit()`, and for `isolateVocals`). Only consulted by
   * `submit()` — `stream()`/`generate()` always request a stream. */
  mode?: "stream" | "async";
  /** Split the generated track into a vocals-only stem alongside the mix.
   * Requires `mode: "async"`; if `mode` is left unset it defaults to
   * "async" automatically. Only usable via `submit()` — the backend
   * rejects it on the plain stream. */
  isolateVocals?: boolean;
  /** Keep the source speech/vocals in the async result. Current name for
   * `isolateVocals`; both are accepted and OR'd server-side. Requires
   * `mode: "async"` (auto-selected by `submit()`). */
  preserveSpeech?: boolean;
  /** Container for the async result. `wav` and `mp3` (320 kbps) are
   * finalize-time transcodes and require async. Defaults to m4a. */
  outputFormat?: "m4a" | "wav" | "mp3";
  /** Duck the generated music under the source voice at finalize time.
   * Default-ON server-side in async mode: leave unset to keep it on, pass
   * `false` to opt out. Free, best-effort; only valid on `submit()`. */
  ducking?: boolean;
  /** How many distinct music variants to generate in one request (1-10,
   * default 1). Cost scales linearly, and values above 1 are never covered
   * by the free trial. Values above 1 require `mode: "async"` (auto-selected
   * by `submit()`) — only meaningful via `submit()`; `stream()`/`generate()`
   * never send it, since they always request a plain stream. */
  variantsNum?: number;
}

/** One service's free-trial allowance. `remaining` is already floored at 0,
 * so it is safe to compare directly. */
export interface TrialQuota {
  granted: number;
  used: number;
  remaining: number;
}

export interface AccountServices {
  available_services: string[];
  rpm_limit: number;
  concurrency_limit: number;
  discount_factor: number | string;
  max_upload_size_mb: number | null;
  /** Free-trial allowance keyed by service (`granted` / `used` /
   * `remaining`). Present only for self-serve accounts — always treat it as
   * possibly absent, and treat a service missing from the map as "no trial
   * allowance", not as an error. */
  trial?: Record<string, TrialQuota>;
}

export interface UsageSummary {
  total_requests: number;
  total_duration_seconds: number;
  total_cost: number | string;
  period_start: string;
  period_end: string;
  [key: string]: unknown;
}

export interface DailyUsage {
  date: string;
  requests: number;
  duration_seconds: number;
  cost: number | string;
}

export interface UsageResponse {
  summary: UsageSummary;
  daily: DailyUsage[];
}

export function isAudioChunkEvent(event: StreamEvent): event is AudioChunkEvent {
  return event.type === "audio_chunk" && (event as AudioChunkEvent).data instanceof Uint8Array;
}

export function isErrorEvent(event: StreamEvent): event is ErrorEvent {
  return event.type === "error";
}

/** SFX segments (unlike music `Segment`) require `end`, must start at 0,
 * and be contiguous; validated server-side. */
export interface SfxSegment {
  start: number;
  end: number;
  prompt: string;
}

export type SfxAudioFormat = "wav" | "mp3" | "aac" | "flac";

/** Submission ack for the async SFX endpoints. */
export interface SfxTask {
  task_id: string;
  status: string;
}

/** A generated file re-hosted on R2 behind a presigned URL. */
export interface SfxMedia {
  url: string;
  content_type?: string;
  file_size?: number;
}

export interface SfxError {
  code?: string;
  message?: string;
}

/**
 * Common shape of any polled task (`tasks.get`/`tasks.wait`), regardless of
 * which endpoint created it. `Tasks.get`/`Tasks.wait` are generic over this so
 * each endpoint's result type (e.g. `SfxResult`, `MusicTaskResult`) can add
 * its own `audio`/media fields while sharing the status/error/refund
 * bookkeeping the poller relies on.
 */
export interface BaseTaskResult {
  task_id: string;
  type?: string;
  status: "processing" | "succeeded" | "failed" | (string & {});
  /** Only present when the account's task-field whitelist enables cost. */
  cost?: number;
  error?: SfxError;
  refunded?: boolean;
  /** Echoes the request's `variantsNum`. Present regardless of task status
   * (so a `processing`/`failed` poll explains the charge too), but only
   * when it was above 1 — a default (single-variant) request sees the same
   * shape it always has. */
  variants_num?: number;
  [key: string]: unknown;
}

/** State of an SFX task (`tasks.get`) or its final result (`wait`/`generate`). */
export interface SfxResult extends BaseTaskResult {
  audio?: SfxMedia;
  /** Kept for backward compatibility; no longer populated — video-to-sfx returns audio only. */
  video?: SfxMedia;
}

export interface TextToSfxParams {
  prompt: string;
  duration: number;
  audioFormat?: SfxAudioFormat;
}

export interface VideoToSfxParams {
  video?: VideoInput;
  videoUrl?: string;
  prompt?: string;
  segments?: SfxSegment[];
  audioFormat?: SfxAudioFormat;
}

/** One decoded audio stream of an async video-to-music result. Unlike SFX,
 * `audio` on a music task is always an array — even without `isolateVocals` —
 * since a music generation can carry more than one output stream. */
export interface MusicMediaEntry extends SfxMedia {
  stream_index: number;
  sample_rate?: number;
  channels?: number;
  /** This entry's own title, present when `variantsNum` was above 1 (and
   * titles are visible on the account). Each variant is a distinct creative
   * direction, so it can carry its own title rather than sharing the
   * top-level `MusicTaskResult.title`, which always names variant 0. */
  title?: MusicTitle;
}

/** One muxed audio+video-aligned output, present only when `isolateVocals`
 * is set. */
export interface MusicMuxEntry extends SfxMedia {
  stream_index: number;
}

export interface MusicTitle {
  title: string;
  summary?: string;
  display_tags?: string[];
}

/** State of an async video-to-music task (`tasks.get`) or its final result
 * (`tasks.wait<MusicTaskResult>()`). Only reachable via `videoToMusic.submit()`
 * with `mode: "async"`. */
export interface MusicTaskResult extends BaseTaskResult {
  /** One entry per stream, or one entry per variant when `variantsNum` was
   * greater than 1 — each variant entry may carry its own `title`. */
  audio?: MusicMediaEntry[];
  /** Vocals-only stem; present only when `isolateVocals` was requested. */
  vocals?: SfxMedia;
  /** Muxed output per stream (or per variant); present only when
   * `isolateVocals` was requested. */
  mux?: MusicMuxEntry[];
  /** Music ducked under the source voice (per variant when `variantsNum` is
   * above 1); present only when `ducking` ran. */
  ducked?: MusicMediaEntry[];
  /** Variant 0's title — the top-level field always names the first variant,
   * even when `variantsNum` produced others with their own titles on
   * `audio[]`. */
  title?: MusicTitle;
  duration_seconds?: number;
}

export interface WaitOptions {
  /** Milliseconds between polls. Default 2000. */
  pollInterval?: number;
  /** Overall deadline in milliseconds. Default 600000. */
  timeout?: number;
}

/** Result of an async video-to-video task (`videoToVideoMusic`/`videoToVideoSfx`):
 * a re-hosted video with generated music or SFX muxed in. */
export interface VideoResult extends BaseTaskResult {
  /** One re-hosted video per variant. On `videoToVideoMusic` this is
   * populated even at the default `variantsNum` of 1 (as a single-entry
   * array); `videoToVideoSfx` has no variants knob and always sends one. */
  videos?: SfxMedia[];
  /** Permanent alias for `videos[0]`. */
  video?: SfxMedia;
  duration_seconds?: number;
}

/** Params for `videoToVideoMusic`.
 *
 * The delivered video's audio depends on `ducking` and `preserveSpeech`:
 *
 * | Request | Audio in the returned video |
 * | --- | --- |
 * | neither set | source speech + music ducked under it |
 * | `ducking: false` | music only |
 * | `preserveSpeech: true` | isolated vocals + music ducked under them |
 * | both (`ducking: false`) | static vocal-forward mix of vocals + music |
 *
 * The source picture is copied without re-encoding, so the input must carry
 * H.264, H.265/HEVC, VP9 or AV1 video in an mp4, mov, m4v or webm container —
 * animated gif and VP8 webm are rejected. Maximum input duration is 360
 * seconds. */
export interface VideoToVideoMusicParams {
  video?: VideoInput;
  videoUrl?: string;
  prompt?: string;
  /** How the music should develop over time. Same shape as
   * `videoToMusic`'s: the first `start` must be 0. Supplying these skips the
   * prompt-service plan the server would otherwise derive from `prompt`. */
  segments?: Segment[];
  /** Duck the generated music under the source's speech — or, with
   * `preserveSpeech`, under the isolated vocals. Default-ON server-side:
   * leave unset to keep it on, pass `false` for music-only audio. Free and
   * best-effort; silently falls back to music-only if the source has no
   * usable audio track, voice isolation fails, or the duck mix fails. */
  ducking?: boolean;
  /** Keep the source speech/vocals in the output. Both this and the legacy
   * `isolateVocals` are accepted and OR'd server-side. */
  preserveSpeech?: boolean;
  /** @deprecated Legacy alias for `preserveSpeech`. */
  isolateVocals?: boolean;
  /** How many distinct music variants to generate in one request (1-10,
   * default 1). Cost scales linearly, and values above 1 are never covered
   * by the free trial. This endpoint is always async, so no extra `mode`
   * gating applies. The result's `videos[]` gets one entry per variant. */
  variantsNum?: number;
}

export interface VideoToVideoSfxParams {
  video?: VideoInput;
  videoUrl?: string;
  prompt?: string;
  segments?: SfxSegment[];
}

/** Params for `videoToVideoSound`, and the base every `videoToSound` param
 * also has. The two endpoints are identical except that only the audio one
 * accepts `outputFormat` — `videoToVideoSound` always muxes the mix into an
 * mp4 — so `VideoToSoundParams` extends this rather than the two sharing a
 * single type, and passing `outputFormat` to the video endpoint is a
 * compile error instead of a value the server silently ignores. */
export interface VideoToVideoSoundParams {
  video?: VideoInput;
  videoUrl?: string;
  /** Style hint for the generated music bed. */
  musicPrompt?: string;
  /** Description of the sound effects layered over the music. */
  sfxPrompt?: string;
  /** Per-segment SFX descriptions; must start at 0 and be contiguous. */
  segments?: SfxSegment[];
  /** Keep the source speech in the result. */
  preserveSpeech?: boolean;
  /** Duck the generated music under the source speech. Default-ON
   * server-side: leave unset to keep it on, pass `false` to opt out. */
  ducking?: boolean;
  /** How many distinct variants to generate in one request (1-10, default
   * 1). Cost scales linearly, and values above 1 are never covered by the
   * free trial. Both `videoToSound` and `videoToVideoSound` are always
   * async, so no extra `mode` gating applies. The result's `outputs[]` gets
   * one entry per variant. */
  variantsNum?: number;
}

/** Params for `videoToSound`. Everything `videoToVideoSound` takes, plus the
 * delivery container for the combined track. */
export interface VideoToSoundParams extends VideoToVideoSoundParams {
  /** Container for the combined music + SFX track. Defaults to `wav`;
   * `mp3` is 320 kbps. Applies to the combined output only — the `music`
   * and `sfx` stems keep their native formats. Not available on
   * `videoToVideoSound`, which always returns an mp4. */
  outputFormat?: "wav" | "m4a" | "mp3";
}

/** One variant's outputs on a `videoToSound` / `videoToVideoSound` result.
 * Present even at the default `variantsNum` of 1, as a single-entry array. */
export interface SoundOutputEntry {
  variant_index: number;
  output_url: string;
  output_type: "audio" | "video";
  output_bytes: number;
  music?: SfxMedia;
  /** Present only when `preserveSpeech`/`ducking` altered this variant's music bed. */
  music_processed?: SfxMedia;
  sfx?: SfxMedia;
}

/** Result of a `videoToSound` / `videoToVideoSound` task (`tasks.get`) or its
 * final state (`generate`).
 *
 * The combined music+SFX result is `output_url` — a bare presigned URL rather
 * than a media object, since these endpoints render one artifact whose kind is
 * announced by `output_type` ("audio" for video-to-sound, "video" for
 * video-to-video-sound). `music`, `music_processed` and `sfx` are the
 * individual stems; pass any of them, or `output_url` itself, to `download()`.
 *
 * `outputs` carries the same fields per variant when `variantsNum` was
 * greater than 1; `output_url`/`output_type`/`output_bytes`/`music`/
 * `music_processed`/`sfx` remain permanent aliases for `outputs[0]`. */
export interface SoundResult extends BaseTaskResult {
  output_url?: string;
  output_type?: "audio" | "video";
  output_bytes?: number;
  music?: SfxMedia;
  /** Present only when `preserveSpeech`/`ducking` altered the music bed. */
  music_processed?: SfxMedia;
  sfx?: SfxMedia;
  duration_seconds?: number;
  /** One entry per variant; see `SoundOutputEntry`. */
  outputs?: SoundOutputEntry[];
}

/**
 * A target language for /v1/dubbing. The union stays open (`string & {}`) so a
 * language added server-side still type-checks against an older SDK — the
 * backend, not this list, is the authority on what is supported.
 */
export type DubbingLanguage =
  | "en"
  | "zh_cn"
  | "ja"
  | "ko"
  | "pt"
  | "es"
  | "de"
  | "fr"
  | "it"
  | "ru"
  | (string & {});

export interface DubbingParams {
  /** Exactly one of `video` / `videoUrl`. */
  video?: VideoInput;
  /**
   * Exactly one of `video` / `videoUrl`. Must be an `https://` URL — the
   * dubbing pipeline fetches the source itself and rejects plain http.
   */
  videoUrl?: string;
  /** Omit to get the server default, `["zh_cn", "es", "fr"]`. */
  languages?: DubbingLanguage[];
  /**
   * Duck the background music/effects bed under the dubbed voice. Default
   * OFF server-side (the opposite of video-to-music's `ducking`): the bed
   * is always kept, at a constant level unless this is `true`. Free.
   */
  ducking?: boolean;
}

export interface DubbingResult extends BaseTaskResult {
  /**
   * One dubbed video URL per requested language, keyed by language code.
   * Unlike every other endpoint's envelope this is a map, not an `audio`/
   * `video` slot — a dubbing task renders N artifacts, one per language.
   */
  outputs?: Record<string, string>;
}
