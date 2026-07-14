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

export interface DuckingResult {
  outputUrl: string;
  outputType: "audio" | "video";
}

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

/** POST the voice and music tracks to /v1/audio-ducking. Returns the task id;
 * the endpoint is async (202 + poll). Non-2xx responses reach the caller as the
 * sonilo SDK's typed errors (PaymentRequiredError, RateLimitError, ...). */
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

/** Poll GET /v1/tasks/{id} until the task leaves `processing`. */
export async function awaitDuckingResult(
  client: DuckingClient,
  taskId: string,
  opts: {
    pollIntervalMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Injected by tests so polling costs no wall-clock time. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DuckingResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    opts.signal?.throwIfAborted();

    const init: RequestInit | undefined = opts.signal ? { signal: opts.signal } : undefined;
    const res = await client.request(`/v1/tasks/${encodeURIComponent(taskId)}`, init);
    const body = (await res.json()) as TaskBody;

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
    await sleep(opts.pollIntervalMs);
  }
}

/** Download the finished mix.
 *
 * Deliberately takes a plain `fetch`, NOT the SoniloClient: `url` is a presigned
 * R2 link on a different host, and routing it through `client.request` would put
 * the Authorization header — the customer's API key — on a request to R2. */
export async function downloadDuckedMix(
  url: string,
  destPath: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchFn(url, signal ? { signal } : {});
  if (!res.ok) {
    throw new VideoKitError(`Could not download the ducked mix (HTTP ${res.status})`);
  }
  await writeFile(destPath, new Uint8Array(await res.arrayBuffer()));
}
