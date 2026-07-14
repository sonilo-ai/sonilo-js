import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  awaitDuckingResult,
  downloadDuckedMix,
  submitDuckingJob,
  type DuckingClient,
} from "../src/ducking-api.js";
import { DuckingFailedError, VideoKitError } from "../src/errors.js";

/** A stub SoniloClient: hands back queued responses and records every call. */
function stubClient(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const client: DuckingClient = {
    async request(path, init) {
      calls.push({ path, init });
      const next = queue.shift();
      if (!next) throw new Error(`stub client: no response queued for ${path}`);
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { client, calls };
}

const VOICE = { bytes: new Uint8Array([1, 2, 3]), filename: "voice.m4a" };
const MUSIC = { bytes: new Uint8Array([4, 5, 6]), filename: "music.mp3" };
const NO_SLEEP = async () => {};

describe("submitDuckingJob", () => {
  it("posts both files as multipart and returns the task id", async () => {
    const { client, calls } = stubClient([{ status: 202, body: { task_id: "t_1", status: "processing" } }]);

    await expect(submitDuckingJob(client, VOICE, MUSIC)).resolves.toBe("t_1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/audio-ducking");
    expect(calls[0]!.init!.method).toBe("POST");
    const form = calls[0]!.init!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const voice = form.get("voice_file")! as File;
    const music = form.get("music_file")! as File;
    expect(voice.name).toBe("voice.m4a");
    expect(music.name).toBe("music.mp3");
    expect(new Uint8Array(await voice.arrayBuffer())).toEqual(VOICE.bytes);
    expect(new Uint8Array(await music.arrayBuffer())).toEqual(MUSIC.bytes);
    // Content-Type must be left unset so the runtime writes the multipart boundary.
    expect(calls[0]!.init!.headers).toBeUndefined();
  });

  it("throws when the API answers without a task_id", async () => {
    const { client } = stubClient([{ status: 202, body: { status: "processing" } }]);
    await expect(submitDuckingJob(client, VOICE, MUSIC)).rejects.toThrow(VideoKitError);
  });
});

describe("awaitDuckingResult", () => {
  const opts = { pollIntervalMs: 1, timeoutMs: 10_000, sleep: NO_SLEEP };

  it("polls until the task succeeds and returns the output", async () => {
    const { client, calls } = stubClient([
      { body: { status: "processing" } },
      { body: { status: "processing" } },
      { body: { status: "succeeded", output_url: "https://r2.example/ducked.wav", output_type: "audio" } },
    ]);

    await expect(awaitDuckingResult(client, "t_1", opts)).resolves.toEqual({
      outputUrl: "https://r2.example/ducked.wav",
      outputType: "audio",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.path).toBe("/v1/tasks/t_1");
  });

  it("raises DuckingFailedError carrying the code and the refund flag", async () => {
    const { client } = stubClient([
      {
        body: {
          status: "failed",
          error: { code: "DUCKING_FAILED", message: "audio processing failed" },
          refunded: true,
        },
      },
    ]);

    const err = await awaitDuckingResult(client, "t_1", opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuckingFailedError);
    const failure = err as DuckingFailedError;
    expect(failure.code).toBe("DUCKING_FAILED");
    expect(failure.refunded).toBe(true);
    expect(failure.message).toContain("audio processing failed");
    expect(failure.message).toContain("refunded");
  });

  it("throws when a succeeded task carries no output_url", async () => {
    const { client } = stubClient([{ body: { status: "succeeded" } }]);
    await expect(awaitDuckingResult(client, "t_1", opts)).rejects.toThrow(VideoKitError);
  });

  it("times out instead of polling forever", async () => {
    const { client } = stubClient(Array.from({ length: 50 }, () => ({ body: { status: "processing" } })));
    await expect(
      awaitDuckingResult(client, "t_1", { pollIntervalMs: 1000, timeoutMs: 1, sleep: NO_SLEEP }),
    ).rejects.toThrow(/did not finish within/);
  });

  it("honors an aborted signal", async () => {
    const { client, calls } = stubClient([{ body: { status: "processing" } }]);
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    await expect(
      awaitDuckingResult(client, "t_1", { ...opts, signal: controller.signal }),
    ).rejects.toThrow("caller went away");
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight poll request instead of waiting for it to settle", async () => {
    // A stub whose `request` never resolves on its own: it only settles when
    // the signal it was handed aborts. If awaitDuckingResult forgot to pass
    // `signal` into the poll request (as it used to), this promise would
    // never reject and the test would time out instead of resolving promptly.
    let requestStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const client: DuckingClient = {
      request(_path, init) {
        requestStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal!.reason as Error);
          });
        });
      },
    };

    const controller = new AbortController();
    const result = awaitDuckingResult(client, "t_1", {
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      sleep: NO_SLEEP,
      signal: controller.signal,
    });

    await startedPromise; // the poll request is now in flight
    controller.abort(new Error("caller went away mid-poll"));

    await expect(result).rejects.toThrow("caller went away mid-poll");
  });

  it("escapes special characters in the task id", async () => {
    const { client, calls } = stubClient([
      { body: { status: "succeeded", output_url: "https://r2.example/ducked.wav", output_type: "audio" } },
    ]);
    await awaitDuckingResult(client, "abc?x=1#y", opts);
    expect(calls[0]!.path).toBe("/v1/tasks/abc%3Fx%3D1%23y");
  });
});

describe("downloadDuckedMix", () => {
  it("fetches the presigned URL with no Authorization header and writes the bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push([url, init]);
      return new Response(new Uint8Array([9, 8, 7]));
    }) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch);

    expect(seen[0]![0]).toBe("https://r2.example/ducked.wav");
    expect(seen[0]![1]?.headers).toBeUndefined();
    expect(new Uint8Array(await readFile(dest))).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("throws on a non-2xx download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const fakeFetch = (async () => new Response("gone", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(
      downloadDuckedMix("https://r2.example/ducked.wav", join(dir, "x.wav"), fakeFetch),
    ).rejects.toThrow(VideoKitError);
  });
});
