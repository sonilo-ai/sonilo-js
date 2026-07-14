import { writeFile } from "node:fs/promises";
import { DuckingFailedError, VideoKitError } from "./errors.js";

/** The minimal client surface the ducking calls need. A real SoniloClient
 * satisfies it (its `request` applies the base URL, the Authorization header,
 * and typed-error mapping); tests pass a stub without touching the network.
 * Mirrors VideoMusicClient in generate.ts.
 *
 * The sonilo SDK has no ducking method yet — `request` is its documented
 * escape hatch. When a native method lands, swap the internals here; this
 * package's public surface does not change. */
export interface DuckingClient {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface DuckingUpload {
  bytes: Uint8Array;
  filename: string;
}

/** Internal only — deliberately NOT re-exported from index.ts: no public
 * signature mentions it (duckMusicUnderSpeech returns the output path), and
 * its `"video"` variant describes a server state this package refuses to
 * produce, since it only ever uploads an extracted audio track. */
export interface DuckingResult {
  outputUrl: string;
  outputType: "audio" | "video";
}

/** How the poll and the download sleep between retries. Injected by tests so
 * a retry costs no wall-clock time. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

interface SubmitBody {
  task_id?: string;
}

interface TaskBody {
  status?: string;
  output_url?: string;
  output_type?: "audio" | "video";
  error?: { code?: string; message?: string };
  refunded?: boolean;
}

/** One initial try plus three retries. */
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 4_000;

/** A non-2xx from a DuckingClient (or the R2 host) that answered rather than
 * threw. Carries `status`, so `isTransient` classifies it exactly like the
 * sonilo SDK's own APIError. Not exported: callers only ever see a
 * VideoKitError, which this is. */
class HttpStatusError extends VideoKitError {
  readonly status: number;

  constructor(status: number, what: string) {
    super(`${what} (HTTP ${status})`);
    this.status = status;
  }
}

/** Sleep `ms`, but observe `signal` while sleeping.
 *
 * A bare setTimeout only lets an abort be noticed at the top of the next poll,
 * so `abort()` appears to hang for up to a full poll interval — invisible at
 * the 2 s default, a full minute for a caller passing pollIntervalMs: 60_000.
 * Racing the timer against the abort event makes the abort prompt. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff, capped. */
function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

function isAborted(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Worth another go?
 *
 * The account is charged when the job is SUBMITTED, so between submit and the
 * mix landing on disk a single transient blip -- a load balancer's 502, a
 * deploy, a reset connection, R2 answering 503 -- must not throw away work the
 * customer has already paid for. Those are retried.
 *
 * 4xx are terminal: a bad key, a task that isn't ours, an expired presigned
 * URL. So are this package's own VideoKitErrors (a `succeeded` task with no
 * output_url, a failed task) -- retrying either only delays the report. An
 * abort is the caller's own instruction and is never retried. */
function isTransient(err: unknown, signal?: AbortSignal): boolean {
  if (isAborted(err, signal)) return false;
  // Checked before the VideoKitError test: HttpStatusError is a VideoKitError
  // and must still be classified on its status. The sonilo SDK's APIError (and
  // its subclasses) carry the same numeric `status` field.
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number") return status >= 500;
  if (err instanceof VideoKitError) return false;
  // No status at all: a network-level failure (ECONNRESET, DNS, TLS), which
  // fetch surfaces as a TypeError.
  return err instanceof Error;
}

async function withRetry<T>(
  op: () => Promise<T>,
  opts: { signal?: AbortSignal; sleep: Sleep },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransient(err, opts.signal)) throw err;
      await opts.sleep(retryDelayMs(attempt), opts.signal);
    }
  }
}

/** POST the voice and music tracks to /v1/audio-ducking. Returns the task id;
 * the endpoint is async (202 + poll). Non-2xx responses reach the caller as the
 * sonilo SDK's typed errors (PaymentRequiredError, RateLimitError, ...).
 *
 * Deliberately NOT retried, unlike the poll and the download below: the POST is
 * what CHARGES the account (calculate_and_charge runs in the request handler,
 * before the background job is even spawned), and it carries no idempotency
 * key. A retry after a response we failed to read would risk submitting -- and
 * paying for -- the same job twice. Failing here is safe; failing after here is
 * what has to be recovered. */
export async function submitDuckingJob(
  client: DuckingClient,
  voice: DuckingUpload,
  music: DuckingUpload,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("voice_file", new Blob([voice.bytes]), voice.filename);
  form.append("music_file", new Blob([music.bytes]), music.filename);

  // No Content-Type header: the runtime must set it, since only it knows the
  // multipart boundary it generated.
  const init: RequestInit = { method: "POST", body: form };
  if (signal) init.signal = signal;

  const res = await client.request("/v1/audio-ducking", init);
  const body = (await res.json()) as SubmitBody;
  if (!body?.task_id) {
    throw new VideoKitError("The ducking API accepted the request but returned no task_id");
  }
  return body.task_id;
}

/** Poll GET /v1/tasks/{id} until the task leaves `processing`.
 *
 * Each poll is retried through transient failures. The task has already been
 * charged by the time this runs, and it keeps running server-side regardless of
 * what happens to this client, so aborting the whole call on one 502 from a
 * load balancer would bin a mix the customer has paid for. The retry is safe:
 * the endpoint is a read, and it is NOT rate-limited server-side (the backend's
 * enforce_rate_limit runs only in the POST handlers, never in GET /v1/tasks). */
export async function awaitDuckingResult(
  client: DuckingClient,
  taskId: string,
  opts: {
    pollIntervalMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Injected by tests so polling costs no wall-clock time. */
    sleep?: Sleep;
  },
): Promise<DuckingResult> {
  const sleep = opts.sleep ?? delay;
  const deadline = Date.now() + opts.timeoutMs;
  const retryOpts = { sleep, ...(opts.signal ? { signal: opts.signal } : {}) };

  for (;;) {
    opts.signal?.throwIfAborted();

    const body = await withRetry(async () => {
      const init: RequestInit | undefined = opts.signal ? { signal: opts.signal } : undefined;
      const res = await client.request(`/v1/tasks/${encodeURIComponent(taskId)}`, init);
      // A real SoniloClient throws its typed error on a non-2xx, but a custom
      // DuckingClient may just hand the response back -- and parsing an error
      // page as a TaskBody would silently look like "still processing".
      if (!res.ok) throw new HttpStatusError(res.status, `Could not poll ducking task ${taskId}`);
      return (await res.json()) as TaskBody;
    }, retryOpts);

    if (body.status === "succeeded") {
      if (!body.output_url) {
        throw new VideoKitError(`Ducking task ${taskId} succeeded but carried no output_url`);
      }
      return { outputUrl: body.output_url, outputType: body.output_type ?? "audio" };
    }
    if (body.status === "failed") {
      throw new DuckingFailedError(
        body.error?.message ?? "the ducking task failed",
        body.error?.code ?? "DUCKING_FAILED",
        body.refunded ?? false,
      );
    }
    if (Date.now() + opts.pollIntervalMs >= deadline) {
      throw new VideoKitError(
        `Ducking task ${taskId} did not finish within ${opts.timeoutMs} ms`,
      );
    }
    await sleep(opts.pollIntervalMs, opts.signal);
  }
}

/** Download the finished mix.
 *
 * Deliberately takes a plain `fetch`, NOT the SoniloClient: `url` is a presigned
 * R2 link on a different host, and routing it through `client.request` would put
 * the Authorization header — the customer's API key — on a request to R2.
 *
 * Retried through transient failures for the same reason the poll is: by the
 * time there is something to download, the task has succeeded and the account
 * has been charged, so losing the mix to one 503 from R2 would mean paying
 * twice for it. A GET of a presigned URL is idempotent, and nothing is written
 * to `destPath` until the whole body is in hand. */
export async function downloadDuckedMix(
  url: string,
  destPath: string,
  fetchFn: typeof globalThis.fetch,
  opts: { signal?: AbortSignal; sleep?: Sleep } = {},
): Promise<void> {
  const sleep = opts.sleep ?? delay;
  const bytes = await withRetry(
    async () => {
      const res = await fetchFn(url, opts.signal ? { signal: opts.signal } : {});
      if (!res.ok) {
        // The message deliberately never names `url`: it is a capability URL
        // granting read access to the customer's artifact, and error messages
        // end up in logs. The task id is the handle worth carrying (see duck.ts).
        throw new HttpStatusError(res.status, "Could not download the ducked mix");
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    { sleep, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  await writeFile(destPath, bytes);
}
