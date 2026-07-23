import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS } from "../src/client.js";
import { download } from "../src/download.js";
import { RequestTimeoutError, SoniloError } from "../src/errors.js";
import { neverResolvingFetch } from "./helpers.js";

describe("download", () => {
  it("fetches the presigned URL without auth headers", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof globalThis.fetch;

    const bytes = await download({ url: "https://r2.example.com/a.m4a" }, fetchFn);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seenUrl).toBe("https://r2.example.com/a.m4a");
    expect(seenInit?.headers).toBeUndefined();
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws SoniloError on non-2xx (e.g. expired presigned URL)", async () => {
    const fetchFn = (async () =>
      new Response("expired", { status: 403 })) as typeof globalThis.fetch;
    await expect(
      download({ url: "https://r2.example.com/a.m4a" }, fetchFn),
    ).rejects.toBeInstanceOf(SoniloError);
  });

  it("rejects with SoniloError when media is undefined (task still processing/failed)", async () => {
    const fetchFn = (async () => {
      throw new Error("should not be called");
    }) as typeof globalThis.fetch;
    await expect(download(undefined, fetchFn)).rejects.toBeInstanceOf(SoniloError);
  });

  it("rejects with SoniloError when media has no url", async () => {
    const fetchFn = (async () => {
      throw new Error("should not be called");
    }) as typeof globalThis.fetch;
    await expect(
      download({ url: "" }, fetchFn),
    ).rejects.toBeInstanceOf(SoniloError);
  });

  it("passes a default timeout signal and honors a custom timeout", async () => {
    let seenTimeout: number | undefined;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // AbortSignal.timeout doesn't expose its delay, so just assert presence
      // by default and confirm a custom value is threaded through without throwing.
      seenTimeout = init?.signal ? 1 : undefined;
      return new Response(new Uint8Array([1]));
    }) as typeof globalThis.fetch;

    await download({ url: "https://r2.example.com/a.m4a" }, fetchFn);
    expect(seenTimeout).toBe(1);

    await download({ url: "https://r2.example.com/a.m4a" }, fetchFn, 1_000);
    expect(seenTimeout).toBe(1);
  });

  it("exports a 600s default timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  it("rejects with RequestTimeoutError when the timeout fires", async () => {
    await expect(
      download({ url: "https://r2.example.com/a.m4a" }, neverResolvingFetch(), 5),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("accepts a bare URL string (the output_url of a video-to-sound task)", async () => {
    let seenUrl = "";
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(new Uint8Array([7, 8]));
    }) as typeof globalThis.fetch;

    const bytes = await download("https://r2.example.com/sound.wav", fetchFn);
    expect(Array.from(bytes)).toEqual([7, 8]);
    expect(seenUrl).toBe("https://r2.example.com/sound.wav");
  });

  it("rejects with SoniloError on an empty URL string", async () => {
    const fetchFn = (async () => {
      throw new Error("should not be called");
    }) as typeof globalThis.fetch;
    await expect(download("", fetchFn)).rejects.toBeInstanceOf(SoniloError);
  });
});
