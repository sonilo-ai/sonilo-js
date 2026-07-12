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
   * apply to streaming music generation. */
  signal?: AbortSignal;
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

/** State of an SFX task (`tasks.get`) or its final result (`wait`/`generate`). */
export interface SfxResult {
  task_id: string;
  type?: string;
  status: "processing" | "succeeded" | "failed" | (string & {});
  audio?: SfxMedia;
  video?: SfxMedia;
  /** Only present when the account's task-field whitelist enables cost. */
  cost?: number;
  error?: SfxError;
  refunded?: boolean;
  [key: string]: unknown;
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

export interface WaitOptions {
  /** Milliseconds between polls. Default 2000. */
  pollInterval?: number;
  /** Overall deadline in milliseconds. Default 600000. */
  timeout?: number;
}
