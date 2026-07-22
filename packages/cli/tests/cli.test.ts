import { afterEach, describe, expect, it, vi } from "vitest";
import {
  outputPath,
  runAccount,
  runTasksGet,
  runTasksWait,
  runUsage,
} from "../src/cli.js";
import { json, mockClient } from "./helpers.js";

describe("outputPath", () => {
  it("uses the explicit path when given", () => {
    expect(outputPath("track.wav", "m4a")).toBe("track.wav");
  });

  it("falls back to output.<ext> when omitted", () => {
    expect(outputPath(undefined, "m4a")).toBe("output.m4a");
    expect(outputPath(undefined, "wav")).toBe("output.wav");
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
