import { DEFAULT_TIMEOUT_MS } from "./client.js";
import { RequestTimeoutError, SoniloError, isTimeoutSignalError } from "./errors.js";
import type { SfxMedia } from "./types.js";

/** Fetch a result media file. The URL is presigned — no API key is sent. */
export async function download(
  media: SfxMedia | undefined,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  timeout: number = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  if (!media?.url) {
    throw new SoniloError("No media to download");
  }
  let res: Response;
  try {
    res = await fetchFn(media.url, { signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    if (isTimeoutSignalError(err)) {
      throw new RequestTimeoutError(`Download of ${media.url} timed out after ${timeout}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new SoniloError(`Download failed: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
