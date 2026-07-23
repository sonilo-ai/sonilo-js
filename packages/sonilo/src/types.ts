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
  /** "stream" (default) or "async" (required by `submit()` and `output_format: "wav"`). */
  mode?: "stream" | "async";
  /** Container for the async result. `wav` requires `mode: "async"`. Defaults to m4a server-side. */
  outputFormat?: "m4a" | "wav";
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
  /** Container for the async result. `wav` requires async. Defaults to m4a. */
  outputFormat?: "m4a" | "wav";
  /** Duck the generated music under the source voice at finalize time.
   * Default-ON server-side in async mode: leave unset to keep it on, pass
   * `false` to opt out. Free, best-effort; only valid on `submit()`. */
  ducking?: boolean;
}

export interface AccountServices {
  available_services: string[];
  rpm_limit: number;
  concurrency_limit: number;
  discount_factor: number | string;
  max_upload_size_mb: number | null;
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
  audio?: MusicMediaEntry[];
  /** Vocals-only stem; present only when `isolateVocals` was requested. */
  vocals?: SfxMedia;
  /** Muxed output per stream; present only when `isolateVocals` was requested. */
  mux?: MusicMuxEntry[];
  /** Music ducked under the source voice; present only when `ducking` ran. */
  ducked?: MusicMediaEntry[];
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
  video?: SfxMedia;
  duration_seconds?: number;
}

export interface VideoToVideoMusicParams {
  video?: VideoInput;
  videoUrl?: string;
  prompt?: string;
  /** Keep the source speech/vocals in the output. Both this and the legacy
   * `isolateVocals` are accepted and OR'd server-side. */
  preserveSpeech?: boolean;
  /** @deprecated Legacy alias for `preserveSpeech`. */
  isolateVocals?: boolean;
}

export interface VideoToVideoSfxParams {
  video?: VideoInput;
  videoUrl?: string;
  prompt?: string;
  segments?: SfxSegment[];
}

/** Params for `videoToSound` and `videoToVideoSound`. Both endpoints take the
 * identical form, so they share one params type. */
export interface VideoToSoundParams {
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
}

/** Result of a `videoToSound` / `videoToVideoSound` task (`tasks.get`) or its
 * final state (`generate`).
 *
 * The combined music+SFX result is `output_url` — a bare presigned URL rather
 * than a media object, since these endpoints render one artifact whose kind is
 * announced by `output_type` ("audio" for video-to-sound, "video" for
 * video-to-video-sound). `music`, `music_processed` and `sfx` are the
 * individual stems; pass any of them, or `output_url` itself, to `download()`. */
export interface SoundResult extends BaseTaskResult {
  output_url?: string;
  output_type?: "audio" | "video";
  output_bytes?: number;
  music?: SfxMedia;
  /** Present only when `preserveSpeech`/`ducking` altered the music bed. */
  music_processed?: SfxMedia;
  sfx?: SfxMedia;
  duration_seconds?: number;
}
