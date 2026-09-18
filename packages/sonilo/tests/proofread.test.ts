import { describe, expect, it, vi } from "vitest";
import { SoniloClient } from "../src/client.js";
import { SoniloError } from "../src/errors.js";
import type { ProofreadResult } from "../src/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACK = { task_id: "pr1", status: "processing" };

function ackClient() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(ACK, 202),
  );
  return { fetch, client: new SoniloClient({ apiKey: "k", fetch }) };
}

/** The exact envelope a finished proofread task carries in production (URLs
 * shortened), verbatim: a subtitles map that includes the DETECTED source
 * language alongside the requested targets, the cue count, and the
 * per-language warnings with their code-specific measurement. */
const FINISHED = {
  task_id: "4288764d-0057-4a77-885e-03c0391c7c1d",
  type: "proofread",
  status: "succeeded",
  duration_seconds: 206.32,
  source_language: "en",
  subtitles: {
    en: "https://r2/en.srt",
    ko: "https://r2/ko.srt",
    fr: "https://r2/fr.srt",
    de: "https://r2/de.srt",
    ar: "https://r2/ar.srt",
    th: "https://r2/th.srt",
    ru: "https://r2/ru.srt",
  },
  cue_count: 65,
  warnings: {
    fr: [
      {
        cue: 33,
        code: "high_text_speed",
        severity: "warning",
        characters_per_second: 26.92,
      },
    ],
  },
};

describe("proofread", () => {
  it("posts video_url and languages as a JSON array string to /v1/proofread", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({
      videoUrl: "https://x/v.mp4",
      languages: ["ja", "zh_cn"],
    });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sonilo.com/v1/proofread");
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("video_url")).toBe("https://x/v.mp4");
    expect(JSON.parse(form.get("languages") as string)).toEqual(["ja", "zh_cn"]);
    expect(form.has("video")).toBe(false);
  });

  it("omits languages when unset — that is what asks for the transcript alone", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("languages")).toBe(false);
  });

  it("sends an explicit empty languages array through as []", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({ videoUrl: "https://x/v.mp4", languages: [] });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.get("languages")).toBe("[]");
  });

  it("sends source_language only when the caller passed the hint", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({ videoUrl: "https://x/v.mp4", sourceLanguage: "en" });
    expect((fetch.mock.calls[0]![1]!.body as FormData).get("source_language")).toBe("en");
  });

  it("omits source_language when unset so the language is detected", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({ videoUrl: "https://x/v.mp4" });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(form.has("source_language")).toBe(false);
  });

  it("uploads a File as the video part", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({ video: new File(["bytes"], "clip.mp4") });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect((form.get("video") as File).name).toBe("clip.mp4");
    expect(form.has("video_url")).toBe(false);
  });

  it("rejects a non-https videoUrl before sending anything", async () => {
    const { fetch, client } = ackClient();
    await expect(
      client.proofread.submit({ videoUrl: "http://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when both or neither of video and videoUrl are given", async () => {
    const { client } = ackClient();
    await expect(
      client.proofread.submit({ video: new Blob(["x"]), videoUrl: "https://x/v.mp4" }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.proofread.submit({})).rejects.toBeInstanceOf(SoniloError);
  });

  it("passes an unknown language code through for the server to reject", async () => {
    const { fetch, client } = ackClient();
    await client.proofread.submit({ videoUrl: "https://x/v.mp4", languages: ["klingon"] });
    const form = fetch.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(form.get("languages") as string)).toEqual(["klingon"]);
  });

  it("generate() polls to a ProofreadResult carrying one .srt per language", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(jsonResponse(FINISHED));
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res: ProofreadResult = await client.proofread.generate(
      { videoUrl: "https://x/v.mp4", languages: ["ko", "fr", "de", "ar", "th", "ru"] },
      { pollInterval: 0 },
    );
    expect(res.type).toBe("proofread");
    expect(res.source_language).toBe("en");
    expect(res.cue_count).toBe(65);
    expect(res.duration_seconds).toBe(206.32);
    // The source language is in the map even though it was never requested.
    expect(Object.keys(res.subtitles ?? {}).sort()).toEqual([
      "ar",
      "de",
      "en",
      "fr",
      "ko",
      "ru",
      "th",
    ]);
    expect(res.subtitles?.en).toBe("https://r2/en.srt");
  });

  it("keeps each warning's named fields and its code-specific extras", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(jsonResponse(FINISHED));
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.proofread.generate(
      { videoUrl: "https://x/v.mp4" },
      { pollInterval: 0 },
    );
    const issue = res.warnings?.fr?.[0];
    expect(issue?.cue).toBe(33);
    expect(issue?.code).toBe("high_text_speed");
    expect(issue?.severity).toBe("warning");
    // Server-owned codes each bring their own measurement; it is kept, not dropped.
    expect(issue?.characters_per_second).toBe(26.92);
  });

  it("tolerates a finished task with no warnings key at all", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(ACK, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "pr2",
          type: "proofread",
          status: "succeeded",
          source_language: "ja",
          subtitles: { ja: "https://r2/ja.srt" },
          cue_count: 4,
          some_field_added_later: true,
        }),
      );
    const client = new SoniloClient({ apiKey: "k", fetch });
    const res = await client.proofread.generate(
      { videoUrl: "https://x/v.mp4" },
      { pollInterval: 0 },
    );
    expect(res.warnings).toBeUndefined();
    expect(res.subtitles).toEqual({ ja: "https://r2/ja.srt" });
    // Unknown keys survive rather than being stripped.
    expect(res.some_field_added_later).toBe(true);
  });

  it("surfaces the 202 acknowledgement's task id from submit()", async () => {
    const { client } = ackClient();
    const task = await client.proofread.submit({ videoUrl: "https://x/v.mp4" });
    expect(task.task_id).toBe("pr1");
    expect(task.status).toBe("processing");
  });
});
