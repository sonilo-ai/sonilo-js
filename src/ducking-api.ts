import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  /** The exact size of the finished artifact, as reported by the AUTHENTICATED
   * API (api.sonilo.com), NOT R2's untrusted Content-Length. OPTIONAL: an older
   * backend does not send it, and the client must work without it — see
   * ducking-api's `output_bytes` handling and duck.ts's effective download cap. */
  outputBytes?: number;
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
  /** Exact byte size of the artifact, delivered over the trusted API channel.
   * The backend adds this to the success envelope; older backends omit it. */
  output_bytes?: number;
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

/** A download attempt that blew its per-attempt wall-clock deadline. Transient
 * on purpose (see isTransient): a stalled/slow attempt is retried with a FRESH
 * deadline, and only after MAX_ATTEMPTS does it surface -- as a VideoKitError,
 * which this is, so callers still only ever see a VideoKitError. Its distinct
 * `name` keeps isAborted from mistaking it for the caller's own abort. */
class DownloadTimeoutError extends VideoKitError {
  /** The per-attempt deadline that fired. Kept as a field (not only in the
   * message) so a retry's fresh, budget-derived deadline is observable. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `The ducked-mix download did not complete within its ${timeoutMs} ms deadline and was aborted.`,
    );
    this.name = "DownloadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The whole post-submit operation's time budget (the caller's `timeoutMs`,
 * shared between polling and the download) ran out mid-download. Unlike
 * DownloadTimeoutError this is TERMINAL, not transient (see isTransient): the
 * budget is spent, so a retry would only start a fresh attempt past a deadline
 * the caller already set. Surfaces as a VideoKitError, which duck.ts wraps with
 * the task id and the "already charged, re-fetchable" note via rethrowWithTaskId,
 * so the caller learns the mix exists server-side and how to re-collect it. */
class DownloadBudgetExhaustedError extends VideoKitError {
  constructor() {
    super(
      "The ducked-mix download did not complete within the overall time budget for this " +
        "operation (the caller's timeoutMs, shared with polling) and was stopped before " +
        "starting a fresh attempt past it.",
    );
    this.name = "DownloadBudgetExhaustedError";
  }
}

/** Per-attempt wall-clock deadline for the mix download. A byte cap bounds
 * MEMORY but not TIME: a slow-loris server dribbling bytes under the cap (undici's
 * bodyTimeout resets on every byte, so it never trips) holds the call open
 * indefinitely. This bounds each attempt's lifetime. Generous for a few-dozen-MB
 * audio wav over a slow link, small enough that a wedged connection cannot hang
 * the caller. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

/** Task/submit JSON envelopes are a few hundred bytes; 1 MB is orders of
 * magnitude of headroom while still capping a compromised API that tries to OOM
 * the client through `await res.json()`. */
const MAX_JSON_BYTES = 1024 * 1024;

/** Read `res.body` chunk by chunk, feeding each to `onChunk`, and abort the
 * instant the running total exceeds `maxBytes` — throwing the VideoKitError
 * that `tooLarge()` builds. Returns the total bytes consumed.
 *
 * This running byte count is the REAL defense against an unbounded body: it
 * holds even when Content-Length is absent or lies, because it counts the bytes
 * actually delivered, never a header. Content-Length is only used as an
 * early-reject optimisation below (R2's header is untrusted, so it may reject
 * early but a small value is never trusted). Shared by the three previously
 * unbounded reads — the submit JSON, the poll JSON, and the mix download — so
 * the cap logic exists once. undici buffers off the V8 heap, so this cannot be
 * left to `--max-old-space-size`. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  tooLarge: () => VideoKitError,
  signal?: AbortSignal,
): Promise<number> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const body = res.body;
  if (!body) return 0;
  const reader = body.getReader();
  // Race each read against `signal` so a stalled or dribbling body is
  // interrupted the instant the signal fires -- not only when (or if) the next
  // chunk finally arrives. A real undici body also rejects its pending read when
  // the signal passed to fetch aborts, but that relies on the socket; racing
  // here additionally bounds a body whose read never resolves at all (a
  // slow-loris connection that accepts then sends nothing), and it is what makes
  // the deadline observable to a test's in-memory stream. The abort promise
  // carries a no-op catch so that a signal firing AFTER the read already won the
  // race cannot surface as an unhandled rejection.
  let abortRace: Promise<never> | undefined;
  let removeAbort: (() => void) | undefined;
  if (signal) {
    abortRace = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
    abortRace.catch(() => {});
  }
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await (abortRace
        ? Promise.race([reader.read(), abortRace])
        : reader.read());
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Strictly greater than the cap: a body exactly at the cap is allowed.
      if (total > maxBytes) throw tooLarge();
      await onChunk(value);
    }
  } finally {
    removeAbort?.();
    // On overflow/abort this aborts the in-flight download so nothing keeps
    // streaming; on the normal path the stream is already drained and this is a
    // no-op.
    await reader.cancel().catch(() => {});
  }
  return total;
}

/** `await res.json()`, but refusing to buffer more than MAX_JSON_BYTES. */
async function readJsonCapped(res: Response, what: string): Promise<unknown> {
  const decoder = new TextDecoder();
  let text = "";
  await readBodyCapped(
    res,
    MAX_JSON_BYTES,
    (chunk) => {
      text += decoder.decode(chunk, { stream: true });
    },
    () =>
      new VideoKitError(
        `The ducking API's ${what} response exceeded ${MAX_JSON_BYTES} bytes; refusing to buffer it.`,
      ),
  );
  text += decoder.decode();
  return JSON.parse(text);
}

/** A host that is never a legitimate presigned R2 location: an IP literal (v4
 * dotted-quad or any v6, which URL.hostname surfaces bracketed / colon-bearing)
 * is exactly the shape an SSRF payload uses to reach 169.254.169.254, loopback,
 * or a private range directly. */
function isIpLiteralHost(host: string): boolean {
  if (host.includes(":") || host.startsWith("[")) return true; // IPv6 literal
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host); // IPv4 dotted-quad
}

/** Validate the presigned download URL before fetching it.
 *
 * `output_url` arrives in the task body, i.e. from the API — which a compromise
 * could turn hostile. Unchecked, it is an SSRF primitive: the client would GET
 * whatever scheme/host the server named. This raises the bar against the
 * obvious payloads:
 *   - only `https:` is allowed (a presigned R2 GET always is), so `http:`,
 *     `file:`, `data:`, etc. are refused;
 *   - IP-literal hosts (v4/v6), `localhost`, and `*.local` / `*.internal` are
 *     refused — the cloud-metadata (169.254.169.254), loopback and internal-DNS
 *     targets an SSRF aims at, never a real presigned R2 host.
 *
 * What it does NOT stop: a public hostname that resolves (or later re-resolves)
 * to a private address. This is not DNS-rebinding protection — the first DNS
 * resolution is trusted. The download fetch additionally sets `redirect:"error"`
 * so a 200-looking URL cannot 302 into internal infrastructure, but a full
 * defense would need a pinned-IP / allowlisted-resolver agent, out of scope for
 * a zero-dependency kit.
 *
 * On rejection: name only the scheme or host, never the full URL — its query
 * string carries the signing signature (a capability), and errors get logged. */
function assertSafeDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VideoKitError("The ducking API returned an output_url that is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new VideoKitError(
      `The ducking API's output_url uses an unsupported scheme "${parsed.protocol}"; ` +
        `only https is allowed for the presigned download.`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  // Strip the DNS-root trailing dot(s) before the NAMED-host blocklist. `foo.`
  // and `foo` resolve identically (dns.lookup("localhost.") returns loopback),
  // and a suffix test is defeated by the dot: `foo.internal.` ends with
  // `internal.`, not `.internal`. Collapse a whole run of trailing dots so
  // `localhost..` cannot sneak through either. This normalization is
  // comparison-ONLY: the fetch below still uses the original URL, so a
  // legitimate public FQDN that happens to carry a root dot is downloaded
  // unchanged rather than rejected. (The IP-literal check needs no such fix: the
  // WHATWG URL parser already strips a trailing dot from a dotted-quad and
  // canonicalizes decimal/hex/octal/IPv4-mapped forms before we see `host`.)
  const namedHost = host.replace(/\.+$/, "");
  if (
    isIpLiteralHost(host) ||
    namedHost === "localhost" ||
    namedHost.endsWith(".local") ||
    namedHost.endsWith(".internal")
  ) {
    throw new VideoKitError(
      `The ducking API's output_url points at a non-public host "${host}", which is never a ` +
        `legitimate presigned download location; refusing to fetch it.`,
    );
  }
}

/** Stream `res.body` to `destPath`, bounded by `maxBytes`, without ever leaving
 * partial bytes at `destPath`: write to a sibling temp file in the same
 * directory (same filesystem, so the rename can't EXDEV) and rename it into
 * place only once the whole body is in hand and under the cap. On overflow or
 * any I/O error the temp file is removed, so a rejected/failed download leaves
 * nothing behind — and on a retry the caller starts a fresh temp file with the
 * byte count back at zero. */
async function streamToFileCapped(
  res: Response,
  destPath: string,
  opts: { maxBytes: number; expectedBytes?: number; signal?: AbortSignal },
): Promise<void> {
  const tempPath = join(dirname(destPath), `.${basename(destPath)}.${randomUUID()}.part`);
  const handle = await open(tempPath, "w");
  try {
    const total = await readBodyCapped(
      res,
      opts.maxBytes,
      async (chunk) => {
        await handle.write(chunk);
      },
      () =>
        // The message never names `url` (a capability URL); duck.ts wraps this
        // with the task id via rethrowWithTaskId, matching the message policy.
        new VideoKitError(
          `The ducked mix exceeded the maximum allowed size (${opts.maxBytes} bytes) and was refused.`,
        ),
      opts.signal,
    );
    await handle.close();
    // The authenticated API (api.sonilo.com) told us the EXACT artifact size in
    // output_bytes. The byte cap is only an UPPER bound, so it cannot catch a
    // SHORT read: a hostile/MITM'd R2 answering `Content-Length: 100` for a real
    // artifact and closing cleanly (no network error fires) would otherwise write
    // a silently-truncated mix. Since the exact size is known over the trusted
    // channel, require the completed body to match it exactly -- a shortfall (or
    // any surplus) means this is not the mix that was paid for. Thrown inside the
    // try so the catch removes the temp file: nothing is left at destPath or as a
    // `.part`. The message never names `url`; duck.ts's rethrowWithTaskId adds the
    // task id. When output_bytes is absent (older backend) there is no floor to
    // check and any under-cap body is accepted, exactly as before.
    if (opts.expectedBytes !== undefined && total !== opts.expectedBytes) {
      throw new VideoKitError(
        `The ducked mix download was ${total} bytes but the ducking API declared exactly ` +
          `${opts.expectedBytes} bytes; refusing this truncated or altered download.`,
      );
    }
    await rename(tempPath, destPath);
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
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
  // A blown per-attempt download deadline: retry with a fresh deadline. Checked
  // before the VideoKitError terminal test below, since it IS a VideoKitError.
  // (isAborted above already returned false for it -- its name is not
  // "AbortError"/"TimeoutError", and the caller's signal is not aborted -- so a
  // TIMEOUT is retried while the caller's own ABORT stays terminal.)
  if (err instanceof DownloadTimeoutError) return true;
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
  const body = (await readJsonCapped(res, "submit")) as SubmitBody;
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
      return (await readJsonCapped(res, "task")) as TaskBody;
    }, retryOpts);

    if (body.status === "succeeded") {
      if (!body.output_url) {
        throw new VideoKitError(`Ducking task ${taskId} succeeded but carried no output_url`);
      }
      const result: DuckingResult = {
        outputUrl: body.output_url,
        outputType: body.output_type ?? "audio",
      };
      // Only when the backend actually sent a USABLE size (older backends omit
      // it, and the client must work without it). It is only ever kept as a
      // POSITIVE INTEGER: a real ducking artifact is never 0 bytes, and a
      // fractional/non-finite/negative/wrong-typed value is not a byte count.
      // Anything else — 0, -5, 1.5, NaN, Infinity, "100", null — is treated as
      // ABSENT (Number.isInteger already rejects NaN/Infinity/fractions/non-numbers),
      // so `outputBytes` is only ever a positive integer or undefined and the
      // hard cap in duck.ts then applies alone, exactly as for an older backend.
      // In particular a 0 must NOT become an exact-size floor, or an empty
      // download would pass it and a truncated/empty mix be written.
      if (Number.isInteger(body.output_bytes) && (body.output_bytes as number) > 0) {
        result.outputBytes = body.output_bytes;
      }
      return result;
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
 * to `destPath` until the whole body is in hand and under the cap.
 *
 * The body is STREAMED to disk, never buffered whole: an unbounded
 * `arrayBuffer()` let a compromised/spoofed/MITM'd R2 host stream forever and
 * OOM the client (undici buffers off the V8 heap, so a heap limit does not
 * contain it). `maxBytes` is the effective cap the caller computed — the local
 * hard ceiling, clamped under the server's authenticated expected size when it
 * sent one (see duck.ts). Content-Length is only an early-reject hint; the
 * running byte count in readBodyCapped is the real bound. */
export async function downloadDuckedMix(
  url: string,
  destPath: string,
  fetchFn: typeof globalThis.fetch,
  opts: {
    maxBytes: number;
    /** The EXACT artifact size from the authenticated API (output_bytes), when
     * the backend sent it. Enforced as a floor after the stream completes (see
     * streamToFileCapped) so a truncated download is rejected, not silently
     * written. Absent for an older backend, in which case only the byte cap
     * applies. */
    expectedBytes?: number;
    /** Per-attempt wall-clock CAP. Defaults to DEFAULT_DOWNLOAD_TIMEOUT_MS. Each
     * attempt gets at most this long — but never longer than the budget left
     * under `deadline`, when one is set. */
    timeoutMs?: number;
    /** Absolute epoch-ms ceiling for the WHOLE operation (poll + download),
     * established once by the caller from its `timeoutMs`. When set, every
     * attempt's deadline is `min(timeoutMs, deadline - now)`, and once the
     * budget is spent the download STOPS (a DownloadBudgetExhaustedError)
     * rather than starting a fresh full-length attempt past it — so a slow or
     * hostile server cannot hold the call materially longer than the caller's
     * `timeoutMs`. Absent: each attempt just uses the per-attempt cap, with no
     * overall bound (the pre-existing behavior). */
    deadline?: number;
    signal?: AbortSignal;
    sleep?: Sleep;
  },
): Promise<void> {
  const sleep = opts.sleep ?? delay;
  const perAttemptMs = opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  // Runs ONCE, before any fetch or retry: a bad scheme/host is terminal, and
  // rejecting here means the hostile URL is never fetched at all.
  assertSafeDownloadUrl(url);

  await withRetry(
    async () => {
      // This attempt's wall-clock deadline. Without an overall `deadline` it is
      // just the per-attempt cap. With one, every attempt must fit under the
      // budget the CALLER set for the whole operation (poll + download), so the
      // per-attempt cap is shrunk to whatever budget is LEFT -- and once the
      // budget is spent the download STOPS here rather than starting a fresh
      // full-length attempt past the caller's deadline. A retried
      // DownloadTimeoutError re-enters and recomputes against the SAME fixed
      // deadline, so time already spent is never resurrected as fresh budget.
      let attemptTimeoutMs = perAttemptMs;
      if (opts.deadline !== undefined) {
        const remaining = opts.deadline - Date.now();
        if (remaining <= 0) throw new DownloadBudgetExhaustedError();
        attemptTimeoutMs = Math.min(perAttemptMs, remaining);
      }
      // Each retry gets a FRESH per-attempt timeout, combined with the caller's
      // signal BY HAND: AbortSignal.any (which would compose them) is not on
      // Node 18 -- it landed in 20.3 -- and this kit targets Node >= 18.
      // AbortSignal.timeout exists (since 17.3) but we drive our own controller
      // so a timeout can be told apart from the caller's abort: a timeout aborts
      // with a DownloadTimeoutError (transient -> retried with a fresh deadline),
      // while the caller's abort forwards the caller's OWN reason, so it stays
      // terminal and its AbortError identity survives for rethrowWithTaskId.
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(opts.signal!.reason);
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new DownloadTimeoutError(attemptTimeoutMs)), attemptTimeoutMs);
      // Never let the deadline timer keep the process alive on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
      try {
        // Already aborted (caller pre-aborted, or a same-tick deadline): fail
        // before the fetch so a hostile/aborted request is never even issued.
        // Mid-flight aborts are caught by the read race in readBodyCapped.
        controller.signal.throwIfAborted();
        const res = await fetchFn(url, {
          // A presigned R2 GET never legitimately 302s; refusing redirects stops a
          // 200-looking URL from bouncing into internal infrastructure (see
          // assertSafeDownloadUrl for what this does and does not cover).
          redirect: "error",
          // Still NO Authorization header -- the customer's API key must never
          // reach R2; only the combined abort/deadline signal is attached.
          signal: controller.signal,
        });
        if (!res.ok) {
          // The message deliberately never names `url`: it is a capability URL
          // granting read access to the customer's artifact, and error messages
          // end up in logs. The task id is the handle worth carrying (see duck.ts).
          throw new HttpStatusError(res.status, "Could not download the ducked mix");
        }
        await streamToFileCapped(res, destPath, {
          maxBytes: opts.maxBytes,
          ...(opts.expectedBytes !== undefined ? { expectedBytes: opts.expectedBytes } : {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
    { sleep, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
}
