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
