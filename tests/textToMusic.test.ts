import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../src/types.js";
import { b64, mockClient, ndjsonResponse } from "./helpers.js";

const EVENTS = [
  { type: "title", title: "Skyline" },
  { type: "audio_chunk", data: b64("abc") },
  { type: "complete" },
];

describe("textToMusic.generate", () => {
  it("posts form fields and returns the buffered track", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS, 9));
    const track = await client.textToMusic.generate({
      prompt: "cinematic orchestral score",
      duration: 60,
      segments: [{ start: 0, prompt: "soft intro", label: "intro" }],
    });

    expect(new TextDecoder().decode(track.audio)).toBe("abc");
    expect(track.title).toBe("Skyline");

    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/text-to-music");
    expect(calls[0]!.init.method).toBe("POST");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("prompt")).toBe("cinematic orchestral score");
    expect(form.get("duration")).toBe("60");
    expect(JSON.parse(form.get("segments") as string)).toEqual([
      { start: 0, prompt: "soft intro", label: "intro" },
    ]);
  });

  it("omits segments field when not provided", async () => {
    const { client, calls } = mockClient(() => ndjsonResponse(EVENTS));
    await client.textToMusic.generate({ prompt: "p", duration: 10 });
    const form = calls[0]!.init.body as FormData;
    expect(form.has("segments")).toBe(false);
  });
});

describe("textToMusic.stream", () => {
  it("yields typed events including a decoded audio chunk", async () => {
    const { client } = mockClient(() => ndjsonResponse(EVENTS, 5));
    const seen: StreamEvent[] = [];
    for await (const ev of client.textToMusic.stream({ prompt: "p", duration: 10 })) {
      seen.push(ev);
    }
    expect(seen.map((e) => e.type)).toEqual(["title", "audio_chunk", "complete"]);
    expect((seen[1] as { data: Uint8Array }).data).toBeInstanceOf(Uint8Array);
  });

  it("yields the error event instead of throwing", async () => {
    const { client } = mockClient(() =>
      ndjsonResponse([{ type: "error", code: "PROXY_ERROR", message: "boom" }]),
    );
    const seen: StreamEvent[] = [];
    for await (const ev of client.textToMusic.stream({ prompt: "p", duration: 10 })) {
      seen.push(ev);
    }
    expect(seen).toEqual([{ type: "error", code: "PROXY_ERROR", message: "boom" }]);
  });
});
