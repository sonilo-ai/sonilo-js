import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { parseVideoAnalysisArgs, runVideoAnalysis } from "../src/cli.js";
import { json, mockClient } from "./helpers.js";

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));

const ACK = { task_id: "va1", status: "processing" };
const BRIEF = {
  task_id: "va1",
  type: "video_analysis",
  status: "succeeded",
  variants_num: 2,
  segments: [{ start: 0, end: 12, label: "intro", prompt: "sparse piano" }],
  variations: [
    { prompt: "cinematic strings, 90bpm" },
    { prompt: "lo-fi hip hop, warm keys" },
  ],
  duration_seconds: 30,
  cost: 0.24,
};

function briefClient() {
  return mockClient((url) =>
    url.endsWith("/v1/video-analysis") ? json(ACK) : json(BRIEF),
  );
}

describe("parseVideoAnalysisArgs", () => {
  it("maps --prompt and --variants onto the SDK params", () => {
    const { params } = parseVideoAnalysisArgs([
      "--video-url",
      "https://x/v.mp4",
      "--prompt",
      "focus on the chase",
      "--variants",
      "2",
    ]);
    expect(params.videoUrl).toBe("https://x/v.mp4");
    expect(params.prompt).toBe("focus on the chase");
    expect(params.variantsNum).toBe(2);
  });

  it("leaves prompt and variantsNum undefined when unset", () => {
    const { params } = parseVideoAnalysisArgs(["--video", "clip.mp4"]);
    expect(params.prompt).toBeUndefined();
    expect(params.variantsNum).toBeUndefined();
  });
});

describe("runVideoAnalysis", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(writeFile).mockClear();
  });

  it("prints the brief as JSON and writes nothing without --output", async () => {
    const { client } = briefClient();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runVideoAnalysis(client, ["--video-url", "https://x/v.mp4"]);

    const printed = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(printed.variations.map((v: { prompt: string }) => v.prompt)).toEqual([
      "cinematic strings, 90bpm",
      "lo-fi hip hop, warm keys",
    ]);
    expect(printed.segments[0]).toEqual({
      start: 0,
      end: 12,
      label: "intro",
      prompt: "sparse piano",
    });
    // The result is a brief, not a file: nothing lands on disk unless asked.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes the brief to --output instead of printing it", async () => {
    const { client } = briefClient();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runVideoAnalysis(client, [
      "--video-url",
      "https://x/v.mp4",
      "--output",
      "brief.json",
    ]);

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, contents] = vi.mocked(writeFile).mock.calls[0]!;
    expect(String(path)).toBe("brief.json");
    expect(JSON.parse(String(contents)).variations).toHaveLength(2);
  });

  it("sends prompt and variants_num on the wire", async () => {
    const { client, calls } = briefClient();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runVideoAnalysis(client, [
      "--video-url",
      "https://x/v.mp4",
      "--prompt",
      "focus on the chase",
      "--variants",
      "2",
    ]);

    const form = calls[0]!.init.body as FormData;
    expect(form.get("prompt")).toBe("focus on the chase");
    expect(form.get("variants_num")).toBe("2");
  });
});
