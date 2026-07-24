import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DUBBING_WAIT_TIMEOUT_MS,
  MUSIC_SEGMENTS,
  SFX_SEGMENTS,
  extFromUrl,
  extractApiKey,
  formatTrialSummary,
  languageOutputPath,
  outputPath,
  parseDubbingArgs,
  parseFormat,
  readSegments,
  runAccount,
  runDubbing,
  runTasksGet,
  runTasksWait,
  runTextToMusic,
  runUsage,
  runVideoToMusic,
  runVideoToSfx,
  runVideoToSound,
  runVideoToVideoSound,
} from "../src/cli.js";
import { json, mockClient } from "./helpers.js";

/** A one-shot readable stream carrying `content`, for `--segments @-`. */
function stdinWith(content: string): NodeJS.ReadableStream {
  return Readable.from([content]);
}

// Only writeFile is mocked (tests assert what would have been written without
// touching disk); readFile passes through to the real implementation so
// `--segments @<path>` tests can read real temp files.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

describe("outputPath", () => {
  it("uses the explicit path when given", () => {
    expect(outputPath("track.wav", "m4a")).toBe("track.wav");
  });

  it("falls back to output.<ext> when omitted", () => {
    expect(outputPath(undefined, "m4a")).toBe("output.m4a");
    expect(outputPath(undefined, "wav")).toBe("output.wav");
  });
});

describe("parseFormat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("folds case so --format WAV behaves like wav", () => {
    expect(parseFormat("WAV", ["m4a", "wav"] as const, "m4a")).toBe("wav");
  });

  it("falls back when the value is undefined", () => {
    expect(parseFormat(undefined, ["m4a", "wav"] as const, "m4a")).toBe("m4a");
  });

  it("exits on an unsupported format instead of mislabeling the file", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => parseFormat("flac", ["m4a", "wav"] as const, "m4a")).toThrow("process.exit");
  });
});

describe("extractApiKey", () => {
  it("strips --api-key when it comes after the command", () => {
    expect(extractApiKey(["account", "--api-key", "sk-1"])).toEqual({
      apiKeyFlag: "sk-1",
      rest: ["account"],
    });
  });

  it("strips --api-key when it comes before the command", () => {
    expect(extractApiKey(["--api-key", "sk-1", "account"])).toEqual({
      apiKeyFlag: "sk-1",
      rest: ["account"],
    });
  });

  it("returns the args unchanged when --api-key is absent", () => {
    expect(extractApiKey(["account"])).toEqual({ apiKeyFlag: undefined, rest: ["account"] });
  });
});

describe("extFromUrl", () => {
  it("reads the extension from the path, ignoring the query string", () => {
    expect(extFromUrl("https://cdn.example.com/a/out.mp4?sig=abc", "bin")).toBe("mp4");
  });

  it("falls back when the path has no extension", () => {
    expect(extFromUrl("https://cdn.example.com/a/out", "mp4")).toBe("mp4");
  });
});

describe("readSegments", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when the flag was not passed", async () => {
    await expect(readSegments("text-to-music", undefined, MUSIC_SEGMENTS)).resolves.toBeUndefined();
  });

  it("parses an inline JSON array", async () => {
    await expect(
      readSegments(
        "text-to-music",
        '[{"start":0,"prompt":"airy pads","label":"intro"}]',
        MUSIC_SEGMENTS,
      ),
    ).resolves.toEqual([{ start: 0, prompt: "airy pads", label: "intro" }]);
  });

  it("reads from @<path>", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sonilo-segments-"));
    const file = join(tmpDir, "segments.json");
    writeFileSync(file, '[{"start":0,"end":5,"prompt":"engine hum"}]');

    await expect(readSegments("video-to-sfx", `@${file}`, SFX_SEGMENTS)).resolves.toEqual([
      { start: 0, end: 5, prompt: "engine hum" },
    ]);
  });

  it("reads from @- (stdin)", async () => {
    const stdin = stdinWith('[{"start":0,"prompt":"airy pads"}]');
    await expect(readSegments("text-to-music", "@-", MUSIC_SEGMENTS, stdin)).resolves.toEqual([
      { start: 0, prompt: "airy pads" },
    ]);
  });

  it("fails with the parse error and names the inline value as the source", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(readSegments("text-to-music", "{not json", MUSIC_SEGMENTS)).rejects.toThrow(
      "process.exit",
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("text-to-music --segments: invalid JSON in the --segments value"),
    );
  });

  it("fails with the parse error and names the file as the source", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sonilo-segments-"));
    const file = join(tmpDir, "bad.json");
    writeFileSync(file, "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(readSegments("text-to-music", `@${file}`, MUSIC_SEGMENTS)).rejects.toThrow(
      "process.exit",
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`text-to-music --segments: invalid JSON in file "${file}"`),
    );
  });

  it("fails when the value is not an array", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      readSegments("text-to-music", '{"start":0,"prompt":"x"}', MUSIC_SEGMENTS),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("text-to-music --segments must be a non-empty JSON array"),
    );
  });

  it("fails when the array is empty", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(readSegments("text-to-music", "[]", MUSIC_SEGMENTS)).rejects.toThrow(
      "process.exit",
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("got an empty array"),
    );
  });

  it("rejects a music command given SFX-shaped segments, naming the music shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      readSegments(
        "video-to-music",
        '[{"start":0,"end":5,"prompt":"engine hum"}]',
        MUSIC_SEGMENTS,
      ),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      "sonilo: video-to-music segments take {start, prompt, label?} — got an object with keys start, end, prompt",
    );
  });

  it("rejects an SFX command given music-shaped segments, naming the SFX shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      readSegments(
        "video-to-sfx",
        '[{"start":0,"prompt":"airy pads","label":"intro"}]',
        SFX_SEGMENTS,
      ),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      "sonilo: video-to-sfx segments take {start, end, prompt} — got an object with keys start, prompt, label",
    );
  });

  it("fails when a required field has the wrong type", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      readSegments("text-to-music", '[{"start":"0","prompt":"x"}]', MUSIC_SEGMENTS),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"start" must be a number'),
    );
  });

  it("passes an unrecognized future key through untouched", async () => {
    await expect(
      readSegments(
        "text-to-music",
        '[{"start":0,"prompt":"x","futureField":"kept"}]',
        MUSIC_SEGMENTS,
      ),
    ).resolves.toEqual([{ start: 0, prompt: "x", futureField: "kept" }]);
  });
});

describe("runTextToMusic --segments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reaches the async submit request as JSON", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/text-to-music")
        ? json({ task_id: "tm1", status: "processing" })
        : json({
            task_id: "tm1",
            status: "succeeded",
            audio: [{ stream_index: 0, url: "https://cdn.example.com/out.m4a" }],
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runTextToMusic(client, [
      "--prompt",
      "warm pads",
      "--duration",
      "30",
      "--async",
      "--segments",
      '[{"start":0,"prompt":"airy pads","label":"intro"}]',
    ]);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("segments")).toBe(
      JSON.stringify([{ start: 0, prompt: "airy pads", label: "intro" }]),
    );
  });

  it("sends no segments field at all when --segments is omitted", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/text-to-music")
        ? json({ task_id: "tm2", status: "processing" })
        : json({
            task_id: "tm2",
            status: "succeeded",
            audio: [{ stream_index: 0, url: "https://cdn.example.com/out.m4a" }],
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runTextToMusic(client, ["--prompt", "warm pads", "--duration", "30", "--async"]);

    const form = calls[0]!.init.body as FormData;
    expect(form.has("segments")).toBe(false);
  });
});

describe("runVideoToMusic --segments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reaches the async submit request as JSON", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/video-to-music")
        ? json({ task_id: "vm1", status: "processing" })
        : json({
            task_id: "vm1",
            status: "succeeded",
            audio: [{ stream_index: 0, url: "https://cdn.example.com/out.m4a" }],
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runVideoToMusic(client, [
      "--video-url",
      "https://in.example.com/clip.mp4",
      "--async",
      "--segments",
      '[{"start":0,"prompt":"tense synths"}]',
    ]);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("segments")).toBe(JSON.stringify([{ start: 0, prompt: "tense synths" }]));
  });
});

describe("runVideoToSfx --segments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reaches the submit request from inline JSON", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/video-to-sfx")
        ? json({ task_id: "vs1", status: "processing" })
        : json({
            task_id: "vs1",
            status: "succeeded",
            audio: { url: "https://cdn.example.com/foley.wav" },
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runVideoToSfx(client, [
      "--video-url",
      "https://in.example.com/clip.mp4",
      "--segments",
      '[{"start":0,"end":5,"prompt":"engine hum"}]',
    ]);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("segments")).toBe(
      JSON.stringify([{ start: 0, end: 5, prompt: "engine hum" }]),
    );
  });

  it("reaches the submit request from @<file>", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sonilo-segments-"));
    try {
      const file = join(tmpDir, "segments.json");
      writeFileSync(file, '[{"start":0,"end":5,"prompt":"engine hum"}]');
      const { client, calls } = mockClient((url) =>
        url.endsWith("/v1/video-to-sfx")
          ? json({ task_id: "vs2", status: "processing" })
          : json({
              task_id: "vs2",
              status: "succeeded",
              audio: { url: "https://cdn.example.com/foley.wav" },
            }),
      );
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      await runVideoToSfx(client, [
        "--video-url",
        "https://in.example.com/clip.mp4",
        "--segments",
        `@${file}`,
      ]);

      const form = calls[0]!.init.body as FormData;
      expect(form.get("segments")).toBe(
        JSON.stringify([{ start: 0, end: 5, prompt: "engine hum" }]),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits with a shape-mismatch error naming video-to-sfx when given music-shaped segments", async () => {
    const { client } = mockClient(() => json({}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      runVideoToSfx(client, [
        "--video-url",
        "https://in.example.com/clip.mp4",
        "--segments",
        '[{"start":0,"prompt":"airy pads"}]',
      ]),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("video-to-sfx segments take {start, end, prompt}"),
    );
  });
});

describe("runVideoToSound", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits to /v1/video-to-sound, polls, and downloads output_url", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/video-to-sound")
        ? json({ task_id: "t1", status: "processing" })
        : json({
            task_id: "t1",
            status: "succeeded",
            output_url: "https://cdn.example.com/out.m4a",
            output_type: "audio",
          }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runVideoToSound(client, [
      "--video-url",
      "https://in.example.com/clip.mp4",
      "--sfx-prompt",
      "footsteps",
    ]);

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/video-to-sound");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://cdn.example.com/out.m4a",
      expect.anything(),
    );
    expect(vi.mocked(writeFile)).toHaveBeenCalled();
  });

  it("exits when neither --video nor --video-url is given", async () => {
    const { client } = mockClient(() => json({}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runVideoToSound(client, ["--sfx-prompt", "x"])).rejects.toThrow("process.exit");
  });

  it("sends --segments through to the request", async () => {
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/video-to-sound")
        ? json({ task_id: "t1b", status: "processing" })
        : json({
            task_id: "t1b",
            status: "succeeded",
            output_url: "https://cdn.example.com/out.m4a",
            output_type: "audio",
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runVideoToSound(client, [
      "--video-url",
      "https://in.example.com/clip.mp4",
      "--segments",
      '[{"start":0,"end":5,"prompt":"footsteps"}]',
    ]);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("segments")).toBe(JSON.stringify([{ start: 0, end: 5, prompt: "footsteps" }]));
  });
});

describe("runVideoToVideoSound", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the output from the video URL's extension", async () => {
    const { client } = mockClient((url) =>
      url.endsWith("/v1/video-to-video-sound")
        ? json({ task_id: "t2", status: "processing" })
        : json({
            task_id: "t2",
            status: "succeeded",
            output_url: "https://cdn.example.com/scored.mp4",
            output_type: "video",
          }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1])));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(writeFile).mockClear();

    await runVideoToVideoSound(client, ["--video-url", "https://in.example.com/clip.mp4"]);

    expect(vi.mocked(writeFile).mock.calls[0]?.[0]).toBe("output.mp4");
  });

  it("exits with a shape-mismatch error naming video-to-video-sound when given music-shaped segments", async () => {
    const { client } = mockClient(() => json({}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(
      runVideoToVideoSound(client, [
        "--video-url",
        "https://in.example.com/clip.mp4",
        "--segments",
        '[{"start":0,"prompt":"footsteps","label":"intro"}]',
      ]),
    ).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith(
      "sonilo: video-to-video-sound segments take {start, end, prompt} — got an object with keys start, prompt, label",
    );
  });
});

describe("languageOutputPath", () => {
  it("inserts the language before the extension", () => {
    expect(languageOutputPath("out/clip.mp4", "es")).toBe("out/clip.es.mp4");
    expect(languageOutputPath("output.mp4", "zh_cn")).toBe("output.zh_cn.mp4");
  });

  it("appends .<lang>.mp4 when the template has no extension", () => {
    expect(languageOutputPath("clip", "fr")).toBe("clip.fr.mp4");
  });

  it("does not mistake a dot in a directory name for an extension", () => {
    expect(languageOutputPath("v1.2/clip", "de")).toBe("v1.2/clip.de.mp4");
  });
});

describe("parseDubbingArgs", () => {
  it("splits --languages on commas and trims", () => {
    const { params } = parseDubbingArgs([
      "--video-url",
      "https://x/v.mp4",
      "--languages",
      "es, fr ,de",
    ]);
    expect(params.languages).toEqual(["es", "fr", "de"]);
    expect(params.videoUrl).toBe("https://x/v.mp4");
  });

  it("leaves languages undefined when the flag is absent", () => {
    const { params } = parseDubbingArgs(["--video-url", "https://x/v.mp4"]);
    expect(params.languages).toBeUndefined();
  });

  it("parses --timeout as a number", () => {
    const { timeout } = parseDubbingArgs(["--video-url", "https://x/v.mp4", "--timeout", "5000"]);
    expect(timeout).toBe(5000);
  });

  it("leaves timeout undefined when the flag is absent", () => {
    const { timeout } = parseDubbingArgs(["--video-url", "https://x/v.mp4"]);
    expect(timeout).toBeUndefined();
  });
});

describe("runDubbing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one file per language, named from the --output template", async () => {
    // `json()` from ./helpers.js takes no status argument, and `download()`
    // defaults to globalThis.fetch rather than the client's injected fetch —
    // so the result URLs are served by a spy on globalThis.fetch, exactly as
    // the runVideoToSound test above does.
    const { client, calls } = mockClient((url) =>
      url.endsWith("/v1/dubbing")
        ? json({ task_id: "db1", status: "processing" })
        : json({
            task_id: "db1",
            status: "succeeded",
            outputs: {
              es: "https://cdn.example.com/es.mp4",
              fr: "https://cdn.example.com/fr.mp4",
            },
          }),
    );
    // A fresh Response per call: runDubbing downloads once per language, and
    // a Response body can only be read once, so reusing a single instance
    // (mockResolvedValue) would throw "Body has already been read" on the
    // second download.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3])),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    // `vi.restoreAllMocks()` in afterEach does not reset a vi.mock-factory
    // vi.fn like `writeFile` — its call history accumulates across tests in
    // this file, so clear it here or `toContain` below could pass even if
    // the function wrote extra, unwanted files.
    vi.mocked(writeFile).mockClear();

    await runDubbing(client, [
      "--video-url",
      "https://in.example.com/clip.mp4",
      "--languages",
      "es,fr",
      "--output",
      "out/clip.mp4",
    ]);

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/dubbing");
    const written = vi.mocked(writeFile).mock.calls.map((c) => c[0]);
    expect(written).toHaveLength(2);
    expect(written).toContain("out/clip.es.mp4");
    expect(written).toContain("out/clip.fr.mp4");
  });

  it("exits when neither --video nor --video-url is given", async () => {
    const { client } = mockClient(() => json({}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runDubbing(client, ["--languages", "es"])).rejects.toThrow("process.exit");
  });

  it("waits with the dubbing-specific default timeout when --timeout is not given", async () => {
    const { client } = mockClient((url) =>
      url.endsWith("/v1/dubbing") ? json({ task_id: "db2", status: "processing" }) : json({}),
    );
    const waitSpy = vi.spyOn(client.tasks, "wait").mockResolvedValue({
      task_id: "db2",
      status: "succeeded",
      outputs: { es: "https://cdn.example.com/es.mp4" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3])),
    );
    vi.mocked(writeFile).mockClear();

    await runDubbing(client, ["--video-url", "https://in.example.com/clip.mp4"]);

    expect(waitSpy).toHaveBeenCalledWith("db2", { timeout: DUBBING_WAIT_TIMEOUT_MS });
  });

  it("parses --timeout and forwards it to tasks.wait, overriding the default", async () => {
    const { client } = mockClient((url) =>
      url.endsWith("/v1/dubbing") ? json({ task_id: "db3", status: "processing" }) : json({}),
    );
    const waitSpy = vi.spyOn(client.tasks, "wait").mockResolvedValue({
      task_id: "db3",
      status: "succeeded",
      outputs: { es: "https://cdn.example.com/es.mp4" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([1, 2, 3])),
    );
    vi.mocked(writeFile).mockClear();

    await runDubbing(client, [
      "--video-url",
      "https://in.example.com/clip.mp4",
      "--timeout",
      "5000",
    ]);

    expect(waitSpy).toHaveBeenCalledWith("db3", { timeout: 5000 });
  });
});

describe("runAccount", () => {
  it("fetches /v1/account/services and prints the JSON body", async () => {
    const services = {
      available_services: ["text_to_music"],
      rpm_limit: 60,
      concurrency_limit: 5,
      discount_factor: 1,
      max_upload_size_mb: 300,
    };
    const { client, calls } = mockClient(() => json(services));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runAccount(client);

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/account/services");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(services, null, 2));
    logSpy.mockRestore();
  });

  it("prints the free-trial summary on stderr, leaving stdout pure JSON", async () => {
    const services = {
      available_services: ["text_to_music", "video_to_music"],
      rpm_limit: 60,
      concurrency_limit: 5,
      discount_factor: 1,
      max_upload_size_mb: 300,
      trial: {
        text_to_music: { granted: 2, used: 1, remaining: 1 },
        video_to_music: { granted: 1, used: 1, remaining: 0 },
      },
    };
    const { client } = mockClient(() => json(services));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runAccount(client);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(services, null, 2));
    expect(errSpy).toHaveBeenCalledWith(
      "Free trial: text-to-music 1/2 left, video-to-music 0/1 left",
    );
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("prints no summary when the account has no trial field", async () => {
    const { client } = mockClient(() =>
      json({
        available_services: ["text_to_music"],
        rpm_limit: 60,
        concurrency_limit: 5,
        discount_factor: 1,
        max_upload_size_mb: 300,
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runAccount(client);

    expect(errSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("formatTrialSummary", () => {
  it("returns undefined for an absent or empty allowance", () => {
    expect(formatTrialSummary(undefined)).toBeUndefined();
    expect(formatTrialSummary({})).toBeUndefined();
  });

  it("spells service keys the way the endpoints do", () => {
    expect(
      formatTrialSummary({ video_to_video_sound: { granted: 1, used: 0, remaining: 1 } }),
    ).toBe("Free trial: video-to-video-sound 1/1 left");
  });
});

describe("runUsage", () => {
  it("omits the days query param when not given", async () => {
    const { client, calls } = mockClient(() =>
      json({ summary: {}, daily: [] }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runUsage(client, undefined);

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/account/usage");
  });

  it("passes --days through as a query param", async () => {
    const { client, calls } = mockClient(() =>
      json({ summary: {}, daily: [] }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runUsage(client, "7");

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/account/usage?days=7");
  });
});

describe("runTasksGet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the task and prints it", async () => {
    const task = { task_id: "abc123", status: "succeeded" };
    const { client, calls } = mockClient(() => json(task));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTasksGet(client, "abc123");

    expect(calls[0]?.url).toBe("https://api.sonilo.com/v1/tasks/abc123");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(task, null, 2));
  });

  it("exits with an error when no task id is given", async () => {
    const { client } = mockClient(() => json({}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTasksGet(client, undefined)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runTasksWait", () => {
  it("polls until the task succeeds and prints the result", async () => {
    let calls = 0;
    const { client } = mockClient(() => {
      calls += 1;
      return json(
        calls < 2
          ? { task_id: "abc123", status: "processing" }
          : { task_id: "abc123", status: "succeeded" },
      );
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTasksWait(client, "abc123", { pollInterval: 0 });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ task_id: "abc123", status: "succeeded" }, null, 2),
    );
  });
});
