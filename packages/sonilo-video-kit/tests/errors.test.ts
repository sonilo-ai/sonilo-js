import { describe, expect, it } from "vitest";
import {
  DuckingFailedError,
  FfmpegError,
  FfmpegNotFoundError,
  VideoKitError,
} from "../src/errors.js";

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

  it("DuckingFailedError does not print the error code twice", () => {
    // What the server actually sends: it sets
    // error_message = "DUCKING_FAILED: audio processing failed" and then
    // derives `code` by splitting that same string on ":", so BOTH fields
    // carry the code. Pre-fix this rendered
    // `Ducking failed [DUCKING_FAILED]: DUCKING_FAILED: audio processing failed`.
    const err = new DuckingFailedError(
      "DUCKING_FAILED: audio processing failed",
      "DUCKING_FAILED",
      true,
    );
    expect(err.message).toContain("[DUCKING_FAILED]");
    expect(err.message).toContain("audio processing failed");
    expect(err.message.match(/DUCKING_FAILED/g)).toHaveLength(1);
  });

  it("keeps a message that does not merely repeat the code", () => {
    const err = new DuckingFailedError("ffmpeg died", "DUCKING_FAILED", true);
    expect(err.message).toBe("Ducking failed [DUCKING_FAILED]: ffmpeg died — the charge was refunded");
  });

  it("does not claim the customer ate the charge when refunded is false", () => {
    // `refunded: false` is a SNAPSHOT, not a verdict: the backend commits the
    // `failed` status BEFORE reversing the charge, and retries a reversal that
    // throws. A client polling inside that window sees false about a refund
    // that is merely still in flight -- pre-fix the message said nothing at
    // all about the charge, which reads as "you were billed for this".
    const err = new DuckingFailedError("audio processing failed", "DUCKING_FAILED", false);
    expect(err.refunded).toBe(false);
    expect(err.message).toMatch(/not been reversed yet/i);
    expect(err.message).toMatch(/may still land/i);
    expect(err.message).not.toMatch(/was refunded/);
  });
});
