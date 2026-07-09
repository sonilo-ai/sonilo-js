import { GenerationError } from "./errors.js";
import type { CostInfo, StreamEvent, Track } from "./types.js";

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toEvent(line: string): StreamEvent {
  const raw = JSON.parse(line) as { type: string; [key: string]: unknown };
  if (raw.type === "audio_chunk" && typeof raw.data === "string") {
    return { ...raw, type: "audio_chunk", data: decodeBase64(raw.data) };
  }
  return raw as StreamEvent;
}

export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield toEvent(line);
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) yield toEvent(tail);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function collectTrack(events: AsyncIterable<StreamEvent>): Promise<Track> {
  const chunks: Uint8Array[] = [];
  let title: string | undefined;
  let cost: CostInfo | undefined;
  let sawComplete = false;

  for await (const ev of events) {
    if (ev.type === "audio_chunk" && ev.data instanceof Uint8Array) {
      chunks.push(ev.data);
    } else if (ev.type === "title" && typeof ev.title === "string") {
      title = ev.title;
    } else if (ev.type === "cost") {
      const { type: _type, ...rest } = ev;
      cost = rest as CostInfo;
    } else if (ev.type === "error") {
      const message = typeof ev.message === "string" ? ev.message : "generation failed";
      const code = typeof ev.code === "string" ? ev.code : undefined;
      throw new GenerationError(message, code);
    } else if (ev.type === "complete") {
      sawComplete = true;
    }
    // unknown event types: ignored
  }

  if (!sawComplete) {
    throw new GenerationError("stream ended before a 'complete' event (truncated response)");
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    audio.set(c, offset);
    offset += c.length;
  }
  return { audio, title, cost };
}
