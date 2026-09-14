import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
import { SoniloError } from "../src/errors.js";
import type { DubbingResult } from "../src/types.js";

/** Write a throwaway subtitle file and return its path, for the "a string that
 * is not an https URL is a local path" half of the subtitle contract. */
async function tempScript(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sonilo-subs-"));
  const path = join(dir, name);
  await writeFile(path, "1\n00:00:00,000 --> 00:00:01,000\nhola\n");
  return path;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACK = { task_id: "db1", status: "processing" };

function ackClient() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(ACK, 202),
  );
  return { fetch, client: new SoniloClient({ apiKey: "k", fetch }) };
}

describe("dubbing", () => {
  it("posts video_url and languages as a JSON array string to /v1/dubbing", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      languages: ["es", "fr"],
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/dubbing");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("video_url")).toBe("https://x/v.mp4");
    expect(JSON.parse(form.get("languages") as string)).toEqual(["es", "fr"]);
    expect(form.has("video")).toBe(false);
  });

  it("omits languages when unset so the server default applies", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("languages")).toBe(false);
  });

  it("sends ducking=true only when explicitly enabled", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4", ducking: true });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("ducking")).toBe("true");
  });

  it("omits ducking when unset so the server default (off) applies", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("ducking")).toBe(false);
  });

  it("sends an explicit ducking=false through unchanged", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4", ducking: false });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("ducking")).toBe("false");
  });

  it("uploads a File as the video part", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ video: new File(["bytes"], "clip.mp4") });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("video") as File).name).toBe("clip.mp4");
    expect(form.has("video_url")).toBe(false);
  });

  it("rejects a non-https videoUrl before sending anything", async () => {
    const { fetch, client } = ackClient();
    await expect(
      client.dubbing.submit({ videoUrl: "http://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when both or neither of video and videoUrl are given", async () => {
    const { client } = ackClient();
    await expect(
      client.dubbing.submit({ video: new Blob(["x"]), videoUrl: "https://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.dubbing.submit({})).rejects.toBeInstanceOf(SoniloError);
  });

  it("passes an unknown language code through for the server to reject", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4", languages: ["xx"] });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(form.get("languages") as string)).toEqual(["xx"]);
  });

  it("generate() polls to a DubbingResult carrying one URL per language", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "db1",
          type: "dubbing",
          status: "succeeded",
          outputs: { es: "https://r2/es.mp4", fr: "https://r2/fr.mp4" },
          cost: 1.5,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.dubbing.generate(
      { videoUrl: "https://x/v.mp4", languages: ["es", "fr"] },
      { pollInterval: 0 },
    );
    expect(res.outputs).toEqual({
      es: "https://r2/es.mp4",
      fr: "https://r2/fr.mp4",
    });
    expect(res.cost).toBe(1.5);
  });

  it("sends each subtitle under its own bracketed language key", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      languages: ["ja", "es"],
      subtitles: { ja: "https://x/ja.srt", es: "https://x/es.vtt" },
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("subtitles[ja]")).toBe("https://x/ja.srt");
    expect(form.get("subtitles[es]")).toBe("https://x/es.vtt");
    // A bare `subtitles` key is refused server-side, so it must never appear.
    expect(form.has("subtitles")).toBe(false);
  });

  it("uploads a path as a file part and keeps its .srt filename", async () => {
    const { fetch, client } = ackClient();
    const path = await tempScript("ja.srt");
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4", subtitles: { ja: path } });
    const part = (fetch.mock.calls[0]![1]!.body as FormData).get("subtitles[ja]");
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe("ja.srt");
    expect(await (part as File).text()).toContain("hola");
  });

  it("uploads a File subtitle under its own name", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      subtitles: { ja: new File(["cues"], "script.vtt") },
    });
    const part = (fetch.mock.calls[0]![1]!.body as FormData).get("subtitles[ja]") as File;
    expect(part.name).toBe("script.vtt");
  });

  it("refuses a subtitle path that is not .srt or .vtt before uploading it", async () => {
    const { fetch, client } = ackClient();
    const path = await tempScript("ja.txt");
    await expect(
      client.dubbing.submit({ videoUrl: "https://x/v.mp4", subtitles: { ja: path } }),
    ).rejects.toThrow(/ja\.txt/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses exportSrt with no subtitles to align against", async () => {
    const { fetch, client } = ackClient();
    await expect(
      client.dubbing.submit({ videoUrl: "https://x/v.mp4", exportSrt: true }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses exportSrt with an empty subtitles map, not just an absent one", async () => {
    const { fetch, client } = ackClient();
    await expect(
      client.dubbing.submit({ videoUrl: "https://x/v.mp4", subtitles: {}, exportSrt: true }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits export_srt entirely when exportSrt is unset", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      subtitles: { ja: "https://x/ja.srt" },
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("export_srt")).toBe(false);
  });

  it("treats an uppercased HTTPS:// subtitle as a URL, not a local path", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      subtitles: { ja: "HTTPS://X/JA.SRT" },
    });
    // A text field, not a File: scheme casing must never send the client
    // looking for a local file by that name.
    const part = (fetch.mock.calls[0]![1]!.body as FormData).get("subtitles[ja]");
    expect(part).toBe("HTTPS://X/JA.SRT");
  });

  it("surfaces the 202's subtitle_preflight from submit()", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          task_id: "db1",
          status: "processing",
          subtitle_preflight: {
            ja: { status: "review_required", cue_count: "5", changes_count: "2", report_url: null },
          },
        },
        202,
      ),
    );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const task = await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      subtitles: { ja: "https://x/ja.srt" },
    });
    expect(task.subtitle_preflight?.ja?.status).toBe("review_required");
    expect(task.subtitle_preflight?.ja?.changes_count).toBe("2");
    // The server writes the key with a null value rather than omitting it.
    expect(task.subtitle_preflight?.ja?.report_url).toBeNull();
  });

  it("sends export_srt alongside the subtitles it requires", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({
      videoUrl: "https://x/v.mp4",
      subtitles: { ja: "https://x/ja.srt" },
      exportSrt: true,
    });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("export_srt")).toBe("true");
  });

  it("omits lipsync when unset so the server default (on) applies", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("lipsync")).toBe(false);
  });

  it("sends an explicit lipsync=false through unchanged", async () => {
    const { fetch, client } = ackClient();
    await client.dubbing.submit({ videoUrl: "https://x/v.mp4", lipsync: false });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("lipsync")).toBe("false");
  });

  it("carries the subtitle maps, whose numbers may arrive as strings", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "db1",
          type: "dubbing",
          status: "succeeded",
          outputs: { ja: "https://r2/ja.mp4" },
          subtitles: { ja: "https://r2/ja.srt" },
          subtitle_preflight: { ja: { status: "ok", cue_count: "5", issues: [], changes_count: 0 } },
          subtitle_export: { ja: { status: "exported", alignment_loss: "0.6305176995017312" } },
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res: DubbingResult = await client.dubbing.generate(
      { videoUrl: "https://x/v.mp4", subtitles: { ja: "https://x/ja.srt" }, exportSrt: true },
      { pollInterval: 0 },
    );
    expect(res.subtitles?.ja).toBe("https://r2/ja.srt");
    expect(res.subtitle_preflight?.ja?.cue_count).toBe("5");
    expect(Number(res.subtitle_export?.ja?.alignment_loss)).toBeCloseTo(0.63, 2);
    expect(res.subtitle_export?.ja?.status).toBe("exported");
  });
});
