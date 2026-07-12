import { describe, expect, it } from "vitest";
import { download } from "../src/download.js";
import { SoniloError } from "../src/errors.js";

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
    expect(seenInit).toBeUndefined();
  });

  it("throws SoniloError on non-2xx (e.g. expired presigned URL)", async () => {
    const fetchFn = (async () =>
      new Response("expired", { status: 403 })) as typeof globalThis.fetch;
    await expect(
      download({ url: "https://r2.example.com/a.m4a" }, fetchFn),
    ).rejects.toBeInstanceOf(SoniloError);
  });
});
