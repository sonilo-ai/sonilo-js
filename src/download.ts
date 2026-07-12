import { SoniloError } from "./errors.js";
import type { SfxMedia } from "./types.js";

/** Fetch a result media file. The URL is presigned — no API key is sent. */
export async function download(
  media: SfxMedia,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Uint8Array> {
  const res = await fetchFn(media.url);
  if (!res.ok) {
    throw new SoniloError(`Download failed: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
