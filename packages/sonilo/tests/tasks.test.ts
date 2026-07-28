import { describe, expect, it } from "vitest";
import { SoniloError, TaskFailedError, TaskTimeoutError } from "../src/errors.js";
import type { MusicTaskResult } from "../src/types.js";
import { mockClient } from "./helpers.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const PROCESSING = { task_id: "t1", type: "text_to_sfx", status: "processing" };
const SUCCEEDED = {
  task_id: "t1",
  type: "text_to_sfx",
  status: "succeeded",
  audio: { url: "https://r2.example.com/audio.m4a", content_type: "audio/mp4", file_size: 123 },
};
const FAILED = {
  task_id: "t1",
  type: "text_to_sfx",
  status: "failed",
  error: { code: "GENERATION_FAILED", message: "boom" },
  refunded: true,
};

describe("tasks.get", () => {
  it("fetches one task with auth", async () => {
    const { client, calls } = mockClient(() => jsonResponse(SUCCEEDED));
    const result = await client.tasks.get("t1");
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/tasks/t1");
    expect(result.status).toBe("succeeded");
    expect(result.audio?.url).toBe("https://r2.example.com/audio.m4a");
  });

  it("URL-encodes the taskId path segment", async () => {
    const { client, calls } = mockClient(() => jsonResponse(PROCESSING));
    await client.tasks.get("t1/../other");
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/tasks/t1%2F..%2Fother");
  });

  it("returns failed results as data without throwing", async () => {
    const { client } = mockClient(() => jsonResponse(FAILED));
    const result = await client.tasks.get("t1");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("GENERATION_FAILED");
    expect(result.refunded).toBe(true);
  });
});

describe("tasks.wait", () => {
  it("polls until succeeded", async () => {
    let n = 0;
    const { client, calls } = mockClient(() => jsonResponse(++n < 3 ? PROCESSING : SUCCEEDED));
    const result = await client.tasks.wait("t1", { pollInterval: 0 });
    expect(result.status).toBe("succeeded");
    expect(calls.length).toBe(3);
  });

  it("throws TaskFailedError with code and refunded", async () => {
    const { client } = mockClient(() => jsonResponse(FAILED));
    const err = await client.tasks.wait("t1", { pollInterval: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(TaskFailedError);
    expect(err.code).toBe("GENERATION_FAILED");
    expect(err.taskId).toBe("t1");
    expect(err.refunded).toBe(true);
  });

  it("throws TaskTimeoutError when the deadline passes", async () => {
    const { client } = mockClient(() => jsonResponse(PROCESSING));
    await expect(
      client.tasks.wait("t1", { pollInterval: 0, timeout: 0 }),
    ).rejects.toBeInstanceOf(TaskTimeoutError);
  });

  it("rejects a negative pollInterval or timeout before polling", async () => {
    // A negative delay is clamped to 0 by setTimeout, which would busy-loop
    // against the API until the deadline instead of failing fast.
    const { client, calls } = mockClient(() => jsonResponse(PROCESSING));
    await expect(
      client.tasks.wait("t1", { pollInterval: -1000, timeout: 200 }),
    ).rejects.toBeInstanceOf(SoniloError);
    await expect(client.tasks.wait("t1", { timeout: -1 })).rejects.toBeInstanceOf(
      SoniloError,
    );
    expect(calls.length).toBe(0);
  });

  it("clamps the poll sleep to the remaining deadline instead of sleeping the full interval", async () => {
    const { client } = mockClient(() => jsonResponse(PROCESSING));
    const start = performance.now();
    await expect(
      client.tasks.wait("t1", { pollInterval: 10_000, timeout: 20 }),
    ).rejects.toBeInstanceOf(TaskTimeoutError);
    // Without clamping this would wait ~10s for the first sleep to elapse.
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("falls back to 'Generation failed' when the error message is an empty string", async () => {
    const { client } = mockClient(() =>
      jsonResponse({
        task_id: "t1",
        status: "failed",
        error: { code: "X", message: "" },
      }),
    );
    const err = await client.tasks.wait("t1", { pollInterval: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(TaskFailedError);
    expect((err as Error).message).toBe("Task t1 failed: Generation failed");
  });
});

const MUSIC_PROCESSING = { task_id: "t1", type: "video_to_music", status: "processing" };
const MUSIC_SUCCEEDED = {
  task_id: "t1",
  type: "video_to_music",
  status: "succeeded",
  audio: [
    {
      stream_index: 0,
      url: "https://r2.example.com/audio.m4a",
      content_type: "audio/mp4",
      sample_rate: 44100,
      channels: 2,
      file_size: 123,
    },
  ],
  vocals: {
    url: "https://r2.example.com/vocals.m4a",
    content_type: "audio/mp4",
    file_size: 456,
  },
  mux: [
    {
      stream_index: 0,
      url: "https://r2.example.com/mux.mp4",
      content_type: "audio/mp4",
      file_size: 789,
    },
  ],
  title: {
    title: "Sunset Drive",
    summary: "A dreamy synthwave track",
    display_tags: ["synthwave", "chill"],
  },
  duration_seconds: 92.5,
};

describe("tasks.wait<MusicTaskResult>", () => {
  it("parses the audio array, vocals, mux, and title of a succeeded async video-to-music task", async () => {
    let n = 0;
    const { client } = mockClient(() =>
      jsonResponse(++n < 2 ? MUSIC_PROCESSING : MUSIC_SUCCEEDED),
    );
    const result = await client.tasks.wait<MusicTaskResult>("t1", { pollInterval: 0 });
    expect(result.status).toBe("succeeded");
    expect(result.audio).toHaveLength(1);
    expect(result.audio?.[0]!.stream_index).toBe(0);
    expect(result.audio?.[0]!.sample_rate).toBe(44100);
    expect(result.audio?.[0]!.channels).toBe(2);
    expect(result.vocals?.url).toBe("https://r2.example.com/vocals.m4a");
    expect(result.mux?.[0]!.stream_index).toBe(0);
    expect(result.mux?.[0]!.url).toBe("https://r2.example.com/mux.mp4");
    expect(result.title?.title).toBe("Sunset Drive");
    expect(result.duration_seconds).toBe(92.5);
  });

  it("still throws TaskFailedError for a failed async video-to-music task", async () => {
    const { client } = mockClient(() =>
      jsonResponse({
        task_id: "t1",
        type: "video_to_music",
        status: "failed",
        error: { code: "GENERATION_FAILED", message: "boom" },
        refunded: true,
      }),
    );
    const err = await client.tasks
      .wait<MusicTaskResult>("t1", { pollInterval: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TaskFailedError);
    expect(err.code).toBe("GENERATION_FAILED");
    expect(err.refunded).toBe(true);
  });

  it("parses per-variant titles and the variants_num echo", async () => {
    const { client } = mockClient(() =>
      jsonResponse({
        task_id: "t1",
        type: "video_to_music",
        status: "succeeded",
        variants_num: 2,
        audio: [
          {
            stream_index: 0,
            url: "https://r2.example.com/v0.m4a",
            title: { title: "Sunset Drive", summary: "Dreamy synthwave" },
          },
          {
            stream_index: 1,
            url: "https://r2.example.com/v1.m4a",
            title: { title: "Night Run" },
          },
        ],
        title: { title: "Sunset Drive", summary: "Dreamy synthwave" },
      }),
    );
    const result = await client.tasks.wait<MusicTaskResult>("t1", { pollInterval: 0 });
    expect(result.variants_num).toBe(2);
    expect(result.audio?.[0]!.title?.title).toBe("Sunset Drive");
    expect(result.audio?.[1]!.title?.title).toBe("Night Run");
    expect(result.title?.title).toBe("Sunset Drive");
  });
});

describe("tasks.get variants_num echo", () => {
  it("is omitted by default (variants_num <= 1)", async () => {
    const { client } = mockClient(() => jsonResponse(MUSIC_SUCCEEDED));
    const result = await client.tasks.get<MusicTaskResult>("t1");
    expect(result.variants_num).toBeUndefined();
  });

  it("is present on a processing task, not only a succeeded one", async () => {
    const { client } = mockClient(() =>
      jsonResponse({ task_id: "t1", type: "video_to_music", status: "processing", variants_num: 3 }),
    );
    const result = await client.tasks.get<MusicTaskResult>("t1");
    expect(result.status).toBe("processing");
    expect(result.variants_num).toBe(3);
  });
});
