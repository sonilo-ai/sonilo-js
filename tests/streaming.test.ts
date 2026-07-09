import { describe, expect, it } from "vitest";
import { GenerationError } from "../src/errors.js";
import { collectTrack, decodeBase64, parseNdjson } from "../src/streaming.js";
import { isAudioChunkEvent, isErrorEvent } from "../src/types.js";
import type { AudioChunkEvent, StreamEvent } from "../src/types.js";

function b64(s: string): string {
  return btoa(s);
}

/** Build a ReadableStream that emits `text` split into chunks of `size` bytes. */
function chunkedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of parseNdjson(stream)) out.push(ev);
  return out;
}

const LINES =
  JSON.stringify({ type: "title", title: "Skyline", summary: "s", display_tags: ["a"] }) +
  "\n" +
  JSON.stringify({ type: "audio_chunk", data: b64("abc") }) +
  "\n" +
  JSON.stringify({ type: "audio_chunk", data: b64("def") }) +
  "\n" +
  JSON.stringify({ type: "complete" }) +
  "\n";

describe("decodeBase64", () => {
  it("decodes to the original bytes", () => {
    expect(Array.from(decodeBase64(b64("abc")))).toEqual([97, 98, 99]);
  });
});

describe("parseNdjson", () => {
  it("parses whole-line chunks", async () => {
    const events = await collect(chunkedStream(LINES, LINES.length));
    expect(events.map((e) => e.type)).toEqual(["title", "audio_chunk", "audio_chunk", "complete"]);
  });

  it("handles half-line splits across chunks (1-byte chunks)", async () => {
    const events = await collect(chunkedStream(LINES, 1));
    expect(events.map((e) => e.type)).toEqual(["title", "audio_chunk", "audio_chunk", "complete"]);
  });

  it("decodes audio_chunk data to Uint8Array", async () => {
    const events = await collect(chunkedStream(LINES, 7));
    const chunk = events[1] as AudioChunkEvent;
    expect(chunk.data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(chunk.data)).toBe("abc");
  });

  it("parses a trailing line without a final newline", async () => {
    const text = JSON.stringify({ type: "complete" }); // no \n
    const events = await collect(chunkedStream(text, 3));
    expect(events).toEqual([{ type: "complete" }]);
  });

  it("skips empty lines", async () => {
    const text = "\n\n" + JSON.stringify({ type: "complete" }) + "\n\n";
    const events = await collect(chunkedStream(text, 2));
    expect(events).toEqual([{ type: "complete" }]);
  });

  it("passes unknown event types through", async () => {
    const text = JSON.stringify({ type: "stage_start", stage: "analyze" }) + "\n";
    const events = await collect(chunkedStream(text, 5));
    expect(events).toEqual([{ type: "stage_start", stage: "analyze" }]);
  });

  it("cancels the source stream when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(
          JSON.stringify({ type: "title", title: "t" }) + "\n" + JSON.stringify({ type: "complete" }) + "\n",
        );
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const ev of parseNdjson(stream)) {
      if (ev.type === "title") break;
    }
    expect(cancelled).toBe(true);
  });

  it("type guards narrow stream events", async () => {
    const events = await collect(chunkedStream(LINES, 9));
    const chunks = events.filter(isAudioChunkEvent);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.data).toBeInstanceOf(Uint8Array);
    expect(events.filter(isErrorEvent)).toHaveLength(0);
  });
});

describe("collectTrack", () => {
  it("concatenates audio chunks and captures title and cost", async () => {
    const text =
      LINES.replace(JSON.stringify({ type: "complete" }) + "\n", "") +
      JSON.stringify({
        type: "cost",
        billing_rate_per_sec: "0.01",
        billing_before_discount: "0.6000",
        billing_after_discount: "0.4800",
        discount_factor: "0.8000",
      }) +
      "\n" +
      JSON.stringify({ type: "complete" }) +
      "\n";
    const track = await collectTrack(parseNdjson(chunkedStream(text, 11)));
    expect(new TextDecoder().decode(track.audio)).toBe("abcdef");
    expect(track.title).toBe("Skyline");
    expect(track.cost).toEqual({
      billing_rate_per_sec: "0.01",
      billing_before_discount: "0.6000",
      billing_after_discount: "0.4800",
      discount_factor: "0.8000",
    });
  });

  it("ignores unknown events while collecting", async () => {
    const text =
      JSON.stringify({ type: "stage_start" }) +
      "\n" +
      JSON.stringify({ type: "audio_chunk", data: b64("x") }) +
      "\n" +
      JSON.stringify({ type: "complete" }) +
      "\n";
    const track = await collectTrack(parseNdjson(chunkedStream(text, 100)));
    expect(new TextDecoder().decode(track.audio)).toBe("x");
    expect(track.title).toBeUndefined();
  });

  it("throws GenerationError on a mid-stream error event", async () => {
    const text =
      JSON.stringify({ type: "audio_chunk", data: b64("x") }) +
      "\n" +
      JSON.stringify({ type: "error", code: "PROXY_ERROR", message: "upstream died" }) +
      "\n";
    await expect(collectTrack(parseNdjson(chunkedStream(text, 100)))).rejects.toMatchObject({
      name: "GenerationError",
      code: "PROXY_ERROR",
      message: "upstream died",
    });
    await expect(async () => {
      await collectTrack(parseNdjson(chunkedStream(text, 100)));
    }).rejects.toBeInstanceOf(GenerationError);
  });
});
