import { mkdtemp, readdir, readFile } from "node:fs/promises";
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

/** A stub SoniloClient: hands back queued responses and records every call.
 * A queued entry with `throws` rejects instead -- which is what the real
 * SoniloClient does on any non-2xx (`if (!res.ok) throw await
 * errorFromResponse(res)`), so that is the shape a 502 from a load balancer
 * actually reaches this package in. */
function stubClient(
  responses: Array<{ status?: number; body?: unknown; throws?: unknown }>,
) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const client: DuckingClient = {
    async request(path, init) {
      calls.push({ path, init });
      const next = queue.shift();
      if (!next) throw new Error(`stub client: no response queued for ${path}`);
      if (next.throws) throw next.throws;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { client, calls };
}

/** The sonilo SDK's APIError: an Error carrying a numeric `status`. Modelled
 * rather than imported so these tests stay independent of the SDK's internals. */
function apiError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}: request failed`), {
    name: "APIError",
    status,
  });
}

const SUCCEEDED = {
  status: "succeeded",
  output_url: "https://r2.example/ducked.wav",
  output_type: "audio",
} as const;

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

  it("rejects an oversized submit body instead of buffering/parsing it", async () => {
    // A compromised API must not OOM the client through `await res.json()`. The
    // envelope is tiny; a multi-MB body is refused before JSON.parse. Pre-fix
    // (unbounded res.json) this would buffer the whole 2 MB and parse it.
    const huge = { task_id: "t_1", padding: "x".repeat(2 * 1024 * 1024) };
    const client: DuckingClient = {
      async request() {
        return new Response(JSON.stringify(huge), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    };
    await expect(submitDuckingJob(client, VOICE, MUSIC)).rejects.toThrow(/too large|exceeded/i);
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

  it("surfaces output_bytes from the authenticated success envelope when present", async () => {
    const { client } = stubClient([
      {
        body: {
          status: "succeeded",
          output_url: "https://r2.example/ducked.wav",
          output_type: "audio",
          output_bytes: 123456,
        },
      },
    ]);
    await expect(awaitDuckingResult(client, "t_1", opts)).resolves.toEqual({
      outputUrl: "https://r2.example/ducked.wav",
      outputType: "audio",
      outputBytes: 123456,
    });
  });

  it("works against an older backend that omits output_bytes", async () => {
    const { client } = stubClient([{ body: SUCCEEDED }]);
    const result = await awaitDuckingResult(client, "t_1", opts);
    expect(result.outputUrl).toBe("https://r2.example/ducked.wav");
    expect(result.outputBytes).toBeUndefined();
  });

  it("drops a non-positive or non-integer output_bytes, treating it as absent", async () => {
    // output_bytes is only ever kept as a POSITIVE INTEGER (a real artifact is
    // never 0 bytes; a fractional/non-finite/wrong-typed value is not a byte
    // count). Anything else must be treated as ABSENT so the hard cap in duck.ts
    // applies alone -- crucially 0, which pre-fix (`>= 0`) became a valid exact
    // size and let a 0-byte download pass the floor, and 1.5, which the old
    // finite-only check also let through.
    for (const bad of [0, -5, 1.5, NaN, Infinity, "100", null]) {
      const { client } = stubClient([
        {
          body: {
            status: "succeeded",
            output_url: "https://r2.example/ducked.wav",
            output_type: "audio",
            output_bytes: bad,
          },
        },
      ]);
      const result = await awaitDuckingResult(client, "t_1", opts);
      expect(result.outputBytes, `output_bytes=${String(bad)} must be dropped`).toBeUndefined();
    }
  });

  it("keeps a positive-integer output_bytes", async () => {
    const { client } = stubClient([
      {
        body: {
          status: "succeeded",
          output_url: "https://r2.example/ducked.wav",
          output_type: "audio",
          output_bytes: 1,
        },
      },
    ]);
    const result = await awaitDuckingResult(client, "t_1", opts);
    expect(result.outputBytes).toBe(1);
  });

  it("rejects an oversized poll body instead of buffering/parsing it", async () => {
    const huge = { status: "succeeded", padding: "x".repeat(2 * 1024 * 1024) };
    const client: DuckingClient = {
      async request() {
        return new Response(JSON.stringify(huge), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    await expect(awaitDuckingResult(client, "t_1", opts)).rejects.toThrow(/too large|exceeded/i);
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

  it("retries a poll that fails with a transient 5xx, instead of binning a paid task", async () => {
    // The account was charged at submit and the task is still running
    // server-side. A single 502 from a load balancer (or a deploy, or a reset
    // connection) must not abort the call: pre-fix awaitDuckingResult had zero
    // retry, so this threw "HTTP 502: request failed" -- a message that doesn't
    // even name the task -- while the paid-for mix finished and sat in R2.
    const { client, calls } = stubClient([
      { body: { status: "processing" } },
      { throws: apiError(502) },
      { throws: new TypeError("fetch failed") }, // network-level: ECONNRESET & co.
      { body: SUCCEEDED },
    ]);

    await expect(awaitDuckingResult(client, "t_1", opts)).resolves.toEqual({
      outputUrl: "https://r2.example/ducked.wav",
      outputType: "audio",
    });
    expect(calls).toHaveLength(4); // the two failures were retried, not fatal
  });

  it("reports a 5xx RESPONSE as a failure rather than mistaking it for 'still processing'", async () => {
    // A custom DuckingClient need not throw on non-2xx (the real SoniloClient
    // does). Pre-fix the 503's error body was parsed straight into a TaskBody,
    // whose `status` is then undefined -- so a dead gateway was indistinguishable
    // from "still processing", and the call spun out its whole timeout before
    // reporting "did not finish within 10000 ms", blaming the task for what was
    // an HTTP failure.
    const { client, calls } = stubClient(
      Array.from({ length: 20 }, () => ({
        status: 503,
        body: { detail: "upstream unavailable" },
      })),
    );

    await expect(awaitDuckingResult(client, "t_1", opts)).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(4); // retried three times, then reported honestly
  });

  it("does not retry a 4xx poll: it is terminal", async () => {
    const { client, calls } = stubClient([{ throws: apiError(404) }]);
    await expect(awaitDuckingResult(client, "t_1", opts)).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
  });

  it("gives up on a persistent 5xx instead of retrying forever", async () => {
    const { client, calls } = stubClient(
      Array.from({ length: 20 }, () => ({ throws: apiError(500) })),
    );
    await expect(awaitDuckingResult(client, "t_1", opts)).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(4); // one try + three retries, bounded
  });

  it("honors an abort promptly during a long poll interval", async () => {
    // No injected sleep: this exercises the REAL one. Pre-fix it was a bare
    // setTimeout with no abort wiring, and `signal` was only consulted at the
    // top of the loop -- so abort() went unseen for a full poll interval. With
    // pollIntervalMs at 60_000 this test hung until vitest killed it.
    const { client } = stubClient([{ body: { status: "processing" } }]);
    const controller = new AbortController();

    const started = Date.now();
    const result = awaitDuckingResult(client, "t_1", {
      pollIntervalMs: 60_000,
      timeoutMs: 600_000,
      signal: controller.signal,
    });
    // Let the first poll resolve and the sleep begin, then abort mid-interval.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort(new Error("caller went away mid-sleep"));

    await expect(result).rejects.toThrow("caller went away mid-sleep");
    expect(Date.now() - started).toBeLessThan(2_000); // not the 60 s interval
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
  const CAP = 300 * 1024 * 1024; // the kit's hard ceiling; the default in these tests

  it("fetches the presigned URL with no Authorization header and writes the bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push([url, init]);
      return new Response(new Uint8Array([9, 8, 7]));
    }) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, { maxBytes: CAP });

    expect(seen[0]![0]).toBe("https://r2.example/ducked.wav");
    // The API key must never reach the R2 host: no Authorization header (indeed
    // no headers at all) on the download fetch.
    expect(seen[0]![1]?.headers).toBeUndefined();
    // And redirects are refused, so a 200-looking URL cannot 302 into internal
    // infrastructure.
    expect(seen[0]![1]?.redirect).toBe("error");
    expect(new Uint8Array(await readFile(dest))).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("throws on a non-2xx download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const fakeFetch = (async () => new Response("gone", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(
      downloadDuckedMix("https://r2.example/ducked.wav", join(dir, "x.wav"), fakeFetch, { maxBytes: CAP }),
    ).rejects.toThrow(VideoKitError);
  });

  it("retries a transient download failure and still writes the paid-for mix", async () => {
    // The task has SUCCEEDED by now, so the account has been charged and the
    // mix exists. Pre-fix, one 503 from R2 (or one reset connection) threw the
    // whole call away -- and the error named neither the task nor the URL, so
    // the only way to get the mix was to pay for it again.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts += 1;
      if (attempts === 1) return new Response("upstream", { status: 503 });
      if (attempts === 2) throw new TypeError("fetch failed"); // connection reset
      return new Response(new Uint8Array([9, 8, 7]));
    }) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
      maxBytes: CAP,
      sleep: NO_SLEEP,
    });

    expect(attempts).toBe(3);
    expect(new Uint8Array(await readFile(dest))).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("does not retry a 4xx download, and never names the presigned URL", async () => {
    // A 403 means the presigned URL has expired or is wrong -- retrying it just
    // delays the report. And the message must not carry the URL: it is a
    // capability granting read access to the customer's artifact, and errors
    // get logged.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts += 1;
      return new Response("gone", { status: 403 });
    }) as unknown as typeof globalThis.fetch;

    const err = await downloadDuckedMix(
      "https://r2.example/ducked.wav?sig=SECRET",
      join(dir, "x.wav"),
      fakeFetch,
      { maxBytes: CAP, sleep: NO_SLEEP },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    expect(attempts).toBe(1);
    expect((err as VideoKitError).message).not.toContain("SECRET");
  });

  it("gives up on a persistent 5xx download instead of retrying forever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts += 1;
      return new Response("upstream", { status: 502 });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      downloadDuckedMix("https://r2.example/ducked.wav", join(dir, "x.wav"), fakeFetch, {
        maxBytes: CAP,
        sleep: NO_SLEEP,
      }),
    ).rejects.toThrow(/HTTP 502/);
    expect(attempts).toBe(4); // one try + three retries, bounded
  });

  // --- Anti-DoS: the download is bounded, not buffered ------------------------

  /** A fetch stub whose Response body streams `chunkBytes`-sized chunks up to a
   * declared cap of `totalBytes`, but would keep going far past any sane size if
   * nothing stopped it. `content-length` is controllable so we can test the
   * lying/absent case separately from the honest-oversized case. `pulled` counts
   * the bytes actually produced, so a test can assert the stream was aborted
   * after ~cap bytes rather than fully drained. */
  function streamingFetch(opts: {
    contentLength?: number | null;
    chunkBytes?: number;
    hardStopBytes: number;
  }) {
    const chunkBytes = opts.chunkBytes ?? 64 * 1024;
    const counter = { pulled: 0 };
    const fakeFetch = (async () => {
      counter.pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (counter.pulled >= opts.hardStopBytes) {
            // A safety valve so a genuinely-unbounded bug can't hang the test
            // forever; the code under test must abort well before this.
            controller.close();
            return;
          }
          counter.pulled += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes));
        },
      });
      const headers: Record<string, string> = {};
      if (opts.contentLength != null) headers["content-length"] = String(opts.contentLength);
      return new Response(stream, { headers });
    }) as unknown as typeof globalThis.fetch;
    return { fakeFetch, counter };
  }

  it("rejects an oversized body with a lying/absent Content-Length, without buffering it all", async () => {
    // Pre-fix downloadDuckedMix did `new Uint8Array(await res.arrayBuffer())`,
    // which would buffer this whole (effectively unbounded) stream and blow
    // memory. The running byte count must abort it just past the cap.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const cap = 1 * 1024 * 1024; // 1 MB
    const { fakeFetch, counter } = streamingFetch({
      contentLength: null, // no Content-Length: the honest defense is the byte count
      chunkBytes: 64 * 1024,
      hardStopBytes: 64 * 1024 * 1024, // would be 64 MB if never stopped
    });

    await expect(
      downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
        maxBytes: cap,
        sleep: NO_SLEEP,
      }),
    ).rejects.toThrow(VideoKitError);

    // Aborted shortly after the cap, not drained to the 64 MB hard stop.
    expect(counter.pulled).toBeLessThan(cap + 1024 * 1024);
    await expect(readFile(dest)).rejects.toThrow(); // no file left at destPath
  });

  it("rejects an honest oversized Content-Length before reading the body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const cap = 1 * 1024 * 1024;
    const { fakeFetch, counter } = streamingFetch({
      contentLength: 8 * 1024 * 1024, // 8 MB declared, over the 1 MB cap
      chunkBytes: 64 * 1024,
      hardStopBytes: 64 * 1024 * 1024,
    });

    await expect(
      downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
        maxBytes: cap,
        sleep: NO_SLEEP,
      }),
    ).rejects.toThrow(VideoKitError);

    // Rejected on the Content-Length header, before the body is consumed: the
    // stream is never drained. (The ReadableStream may internally pre-buffer a
    // single chunk of its own accord; the point is the code pulls nothing and
    // cancels — nowhere near the 8 MB the header declared.)
    expect(counter.pulled).toBeLessThanOrEqual(64 * 1024);
    await expect(readFile(dest)).rejects.toThrow();
  });

  it("accepts a body at/under the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const payload = new Uint8Array(4 * 1024).fill(7);
    const fakeFetch = (async () => new Response(payload)) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
      maxBytes: payload.byteLength, // exactly at the cap: allowed
      sleep: NO_SLEEP,
    });

    expect(new Uint8Array(await readFile(dest))).toEqual(payload);
  });

  // --- SSRF guard -------------------------------------------------------------

  it("rejects unsafe output_url schemes/hosts before any fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const unsafe = [
      "http://r2.example/ducked.wav", // plain http
      "file:///etc/passwd", // file scheme
      "https://169.254.169.254/latest/meta-data/", // cloud metadata, IPv4 literal
      "https://[::1]/ducked.wav", // IPv6 loopback literal
      "https://127.0.0.1/ducked.wav", // IPv4 loopback literal
      "https://localhost/ducked.wav", // localhost
      "https://foo.internal/ducked.wav", // internal DNS suffix
      "https://foo.local/ducked.wav", // mDNS suffix
    ];
    for (const url of unsafe) {
      let called = false;
      const fakeFetch = (async () => {
        called = true;
        return new Response(new Uint8Array([1]));
      }) as unknown as typeof globalThis.fetch;

      const err = await downloadDuckedMix(url, join(dir, "x.wav"), fakeFetch, {
        maxBytes: CAP,
        sleep: NO_SLEEP,
      }).catch((e: unknown) => e);

      expect(err, url).toBeInstanceOf(VideoKitError);
      expect(called, `fetch must not be called for ${url}`).toBe(false);
    }
  });

  it("allows a normal presigned https R2 URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response(new Uint8Array([9, 8, 7]));
    }) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix(
      "https://abc123.r2.cloudflarestorage.com/mix.wav?X-Amz-Signature=deadbeef",
      dest,
      fakeFetch,
      { maxBytes: CAP, sleep: NO_SLEEP },
    );

    expect(called).toBe(true);
    expect(new Uint8Array(await readFile(dest))).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("rejects a trailing-dot (DNS-root) named host that would otherwise bypass the blocklist", async () => {
    // `localhost.` resolves exactly like `localhost` (dns.lookup returns
    // loopback), and `foo.internal.` / `foo.local.` end with `internal.` /
    // `local.` rather than `.internal` / `.local` -- so an un-normalized blocklist
    // is trivially defeated by appending the DNS root dot (or two). Pre-fix each
    // of these sailed straight through and fetch WAS called against a loopback /
    // internal target.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const bypass = [
      "https://localhost./x",
      "https://localhost../x",
      "https://foo.internal./x",
      "https://foo.local./x",
    ];
    for (const url of bypass) {
      let called = false;
      const fakeFetch = (async () => {
        called = true;
        return new Response(new Uint8Array([1]));
      }) as unknown as typeof globalThis.fetch;

      const err = await downloadDuckedMix(url, join(dir, "x.wav"), fakeFetch, {
        maxBytes: CAP,
        sleep: NO_SLEEP,
      }).catch((e: unknown) => e);

      expect(err, url).toBeInstanceOf(VideoKitError);
      expect(called, `fetch must not be called for ${url}`).toBe(false);
    }
  });

  it("allows a legitimate public R2 host that carries a DNS-root trailing dot", async () => {
    // A trailing dot is a valid FQDN (the DNS root). Normalizing it away is only
    // for the blocklist comparison; a real public presigned host with a root dot
    // is still a legitimate download target, so it is fetched, not refused.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response(new Uint8Array([9, 8, 7]));
    }) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix(
      "https://abc123.r2.cloudflarestorage.com./mix.wav?X-Amz-Signature=deadbeef",
      dest,
      fakeFetch,
      { maxBytes: CAP, sleep: NO_SLEEP },
    );

    expect(called).toBe(true);
    expect(new Uint8Array(await readFile(dest))).toEqual(new Uint8Array([9, 8, 7]));
  });

  // --- Anti-DoS: the download has a wall-clock deadline -----------------------

  it(
    "aborts a slow body dribbling under the cap once the per-attempt deadline fires",
    async () => {
      // A slow-loris server trickles bytes forever, each one under the byte cap,
      // so the cap never trips; undici's bodyTimeout resets on every byte too.
      // Only a wall-clock deadline bounds the connection. Pre-fix downloadDuckedMix
      // had none, so this hung until the test's own timeout killed it.
      const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
      const dest = join(dir, "ducked.wav");
      let pulled = 0;
      let cancelled = false;
      const fakeFetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => {
              // A byte every 5 ms: a real dribble that stays far under the cap.
              const t = setTimeout(() => {
                // Once the download aborts and cancels the reader, a still-pending
                // timer must not enqueue onto the closed stream (ERR_INVALID_STATE).
                if (!cancelled) {
                  pulled += 1;
                  try {
                    controller.enqueue(new Uint8Array(1));
                  } catch {
                    /* stream already cancelled */
                  }
                }
                resolve();
              }, 5);
              (t as unknown as { unref?: () => void }).unref?.();
            });
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream);
      }) as unknown as typeof globalThis.fetch;

      const err = await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
        maxBytes: CAP, // far above what dribbles out: the cap never trips
        timeoutMs: 40, // a short per-attempt deadline so the test is fast
        sleep: NO_SLEEP,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(VideoKitError);
      expect((err as VideoKitError).message).toMatch(/deadline|within|abort/i);
      expect(pulled).toBeLessThan(CAP); // stopped by time, never by the cap
      await expect(readFile(dest)).rejects.toThrow(); // nothing written
    },
    // Bounded well under vitest's default: 4 attempts x 40 ms deadline + overhead.
    5_000,
  );

  it("still honors the caller's own abort signal on the download", async () => {
    // The deadline must COMBINE with the caller's signal, not replace it: a
    // caller who aborts still terminates promptly, and the abort is terminal
    // (not retried) with its AbortError identity intact.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response(new Uint8Array([1]));
    }) as unknown as typeof globalThis.fetch;

    await expect(
      downloadDuckedMix("https://r2.example/ducked.wav", join(dir, "x.wav"), fakeFetch, {
        maxBytes: CAP,
        signal: controller.signal,
        sleep: NO_SLEEP,
      }),
    ).rejects.toThrow("caller went away");
    expect(called).toBe(false);
  });

  // --- Anti-DoS: an OVERALL budget (deadline) bounds the whole download -------

  /** A fetch whose body dribbles one byte every few ms forever -- far under any
   * cap, so only a wall-clock deadline stops it. Records the abort reason its
   * signal is aborted with, so a test can read the per-attempt deadline that
   * fired, and counts how many times it is called. */
  function dribblingFetch() {
    const state = { calls: 0, abortReason: undefined as unknown, cancelled: false };
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      state.calls += 1;
      state.cancelled = false;
      init?.signal?.addEventListener("abort", () => {
        state.abortReason = init.signal!.reason;
      });
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              if (!state.cancelled) {
                try {
                  controller.enqueue(new Uint8Array(1));
                } catch {
                  /* already cancelled */
                }
              }
              resolve();
            }, 5);
            (t as unknown as { unref?: () => void }).unref?.();
          });
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return new Response(stream);
    }) as unknown as typeof globalThis.fetch;
    return { fakeFetch, state };
  }

  it(
    "bounds the WHOLE download by the overall deadline, not 4 x the per-attempt default",
    async () => {
      // A slow-loris body under the cap, with the DEFAULT 120 s per-attempt cap:
      // pre-fix (no `deadline` support) this ran 4 x 120 s = 8 min and only the
      // test's own timeout killed it. With the overall budget it stops at ~budget.
      const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
      const dest = join(dir, "ducked.wav");
      const { fakeFetch } = dribblingFetch();

      const start = Date.now();
      const err = await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
        maxBytes: CAP, // never trips: the cap is not the bound here
        deadline: Date.now() + 120, // 120 ms of overall budget for the whole download
        // no timeoutMs: the 120 s DEFAULT per-attempt cap must be overridden by the budget
        sleep: NO_SLEEP, // no backoff wall-clock between attempts
      }).catch((e: unknown) => e);
      const elapsed = Date.now() - start;

      expect(err).toBeInstanceOf(VideoKitError);
      // Bounded by the budget (~120 ms + a little overhead), NOT 4 x 120_000 ms.
      expect(elapsed).toBeLessThan(3_000);
      await expect(readFile(dest)).rejects.toThrow(); // nothing written
    },
    5_000,
  );

  it(
    "charges spent time against the budget: the download deadline is the REMAINING budget, not a fresh full per-attempt value",
    async () => {
      // Simulate a poll that already spent most of timeoutMs: only ~100 ms of the
      // budget is left, while the per-attempt CAP is a large 5000 ms. The first
      // attempt's deadline must be min(5000, ~100) = ~100 ms -- proving the
      // download got only the LEFTOVER budget, not a fresh 5000 ms. Pre-fix,
      // `deadline` was ignored and each attempt ran the full 5000 ms cap, so the
      // dribble ran until the test's own timeout.
      const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
      const dest = join(dir, "ducked.wav");
      const { fakeFetch, state } = dribblingFetch();

      const err = await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
        maxBytes: CAP,
        timeoutMs: 5_000, // a LARGE per-attempt cap...
        deadline: Date.now() + 100, // ...but only ~100 ms of overall budget remains
        sleep: NO_SLEEP,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(VideoKitError); // the budget-exhausted error
      // The first attempt was aborted by its DEADLINE, and that deadline was the
      // remaining budget (<= 100 ms), NOT the fresh 5000 ms per-attempt cap.
      const reason = state.abortReason as { name?: string; timeoutMs?: number };
      expect(reason?.name).toBe("DownloadTimeoutError");
      expect(reason.timeoutMs).toBeGreaterThan(0);
      expect(reason.timeoutMs).toBeLessThanOrEqual(100);
      // The second attempt short-circuited on the spent budget before fetching.
      expect(state.calls).toBe(1);
      await expect(readFile(dest)).rejects.toThrow();
    },
    5_000,
  );

  // --- Anti-truncation: an exact-size floor when output_bytes is known --------

  it("rejects a body shorter than the API's exact output_bytes and leaves no file or .part", async () => {
    // output_bytes arrives over the AUTHENTICATED channel and is the EXACT size.
    // A hostile/MITM'd R2 answering with fewer bytes and closing cleanly (so no
    // network error fires) would otherwise write a silently-truncated mix. The
    // byte cap is only an UPPER bound and cannot catch this; the exact-size floor
    // can. Pre-fix the 10-byte body was written to destPath as-is.
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const short = new Uint8Array(10).fill(7);
    const fakeFetch = (async () => new Response(short)) as unknown as typeof globalThis.fetch;

    const err = await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
      maxBytes: CAP,
      expectedBytes: 100, // the API declared exactly 100 bytes; only 10 arrived
      sleep: NO_SLEEP,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VideoKitError);
    expect((err as VideoKitError).message).toMatch(/truncated|altered|declared/i);
    await expect(readFile(dest)).rejects.toThrow(); // no finished file
    expect(await readdir(dir)).toEqual([]); // and no leftover `.part` temp either
  });

  it("accepts a body whose length exactly matches output_bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svk-dl-"));
    const dest = join(dir, "ducked.wav");
    const exact = new Uint8Array(100).fill(7);
    const fakeFetch = (async () => new Response(exact)) as unknown as typeof globalThis.fetch;

    await downloadDuckedMix("https://r2.example/ducked.wav", dest, fakeFetch, {
      maxBytes: CAP,
      expectedBytes: 100,
      sleep: NO_SLEEP,
    });

    expect(new Uint8Array(await readFile(dest))).toEqual(exact);
  });
});
