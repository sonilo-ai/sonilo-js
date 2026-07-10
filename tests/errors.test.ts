import { describe, expect, it } from "vitest";
import { FfmpegError, FfmpegNotFoundError, VideoKitError } from "../src/errors.js";

describe("errors", () => {
  it("FfmpegNotFoundError carries install hints and extends VideoKitError", () => {
    const err = new FfmpegNotFoundError("ffprobe");
    expect(err).toBeInstanceOf(VideoKitError);
    expect(err.name).toBe("FfmpegNotFoundError");
    expect(err.message).toContain("ffprobe");
    expect(err.message).toContain("brew install ffmpeg");
    expect(err.message).toContain("ffmpegPath");
  });

  it("FfmpegError carries exit code and stderr tail", () => {
    const err = new FfmpegError("ffmpeg failed", 1, "Invalid data found when processing input");
    expect(err).toBeInstanceOf(VideoKitError);
    expect(err.exitCode).toBe(1);
    expect(err.stderrTail).toContain("Invalid data");
    expect(err.message).toContain("Invalid data");
  });
});
