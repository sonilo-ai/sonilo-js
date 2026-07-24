import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  DUBBING_WAIT_TIMEOUT_MS,
  extFromUrl,
  extractApiKey,
  languageOutputPath,
  outputPath,
  parseDubbingArgs,
  parseFormat,
  runAccount,
  runDubbing,
  runTasksGet,
  runTasksWait,
  runUsage,
  runVideoToSound,
  runVideoToVideoSound,
} from "../src/cli.js";
import { json, mockClient } from "./helpers.js";

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

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
