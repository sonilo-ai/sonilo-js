import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SoniloError } from "../src/errors.js";
import { toUploadBlob } from "../src/upload.js";

async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

describe("toUploadBlob", () => {
  it("passes File through and keeps its name", async () => {
    const file = new File(["vid"], "clip.mp4", { type: "video/mp4" });
    const { blob, filename } = await toUploadBlob(file);
    expect(filename).toBe("clip.mp4");
    expect(await blobText(blob)).toBe("vid");
  });

  it("wraps Blob with a default filename", async () => {
    const { blob, filename } = await toUploadBlob(new Blob(["vid"]));
    expect(filename).toBe("video.mp4");
    expect(await blobText(blob)).toBe("vid");
  });

  it("wraps Uint8Array and ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode("vid");
    expect(await blobText((await toUploadBlob(bytes)).blob)).toBe("vid");
    expect(await blobText((await toUploadBlob(bytes.slice().buffer)).blob)).toBe("vid");
  });

  it("buffers a ReadableStream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("vi"));
        controller.enqueue(new TextEncoder().encode("d"));
        controller.close();
      },
    });
    const { blob } = await toUploadBlob(stream);
    expect(await blobText(blob)).toBe("vid");
  });

  it("reads a file path in Node and uses the basename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sonilo-test-"));
    const path = join(dir, "movie.mp4");
    await writeFile(path, "vid");
    const { blob, filename } = await toUploadBlob(path);
    expect(filename).toBe("movie.mp4");
    expect(await blobText(blob)).toBe("vid");
  });

  it("rejects unsupported input with SoniloError", async () => {
    await expect(toUploadBlob(42 as never)).rejects.toBeInstanceOf(SoniloError);
  });
});
