import { SoniloError } from "./errors.js";
import type { VideoInput } from "./types.js";

const DEFAULT_FILENAME = "video.mp4";

/**
 * Normalize every accepted video input into a FormData-ready Blob.
 * String inputs are file paths and work only in Node.js; browsers must
 * pass File/Blob/bytes/streams.
 */
export async function toUploadBlob(
  video: VideoInput,
): Promise<{ blob: Blob; filename: string }> {
  if (typeof video === "string") {
    const isNode =
      typeof process !== "undefined" && Boolean((process as { versions?: { node?: string } }).versions?.node);
    if (!isNode) {
      throw new SoniloError(
        "File paths are only supported in Node.js; pass a File or Blob in the browser",
      );
    }
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(
      /* webpackIgnore: true */ /* @vite-ignore */ fsModule
    )) as typeof import("node:fs/promises");
    const data = await readFile(video);
    const filename = video.split(/[\\/]/).pop() || DEFAULT_FILENAME;
    return { blob: new Blob([data]), filename };
  }
  if (typeof File !== "undefined" && video instanceof File) {
    return { blob: video, filename: video.name || DEFAULT_FILENAME };
  }
  if (video instanceof Blob) {
    return { blob: video, filename: DEFAULT_FILENAME };
  }
  if (video instanceof Uint8Array) {
    return { blob: new Blob([video as unknown as BlobPart]), filename: DEFAULT_FILENAME };
  }
  if (video instanceof ArrayBuffer) {
    return { blob: new Blob([video]), filename: DEFAULT_FILENAME };
  }
  if (video instanceof ReadableStream) {
    return { blob: await new Response(video).blob(), filename: DEFAULT_FILENAME };
  }
  throw new SoniloError("Unsupported video input type");
}
