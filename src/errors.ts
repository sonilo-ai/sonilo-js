export class VideoKitError extends Error {
  /** The error this one wraps, when it wraps one — the standard `Error.cause`.
   *
   * Some failures have to be re-thrown as a VideoKitError to carry context the
   * original error does not have (chiefly: the ducking task id, and the fact
   * that the account has ALREADY been charged — see duck.ts). Losing the
   * original in the process would cost the caller the only thing they can
   * branch on: an abort they requested themselves arrives as a plain
   * VideoKitError, and `catch (e) { if (e.name === "AbortError") return; }`
   * treats their own cancellation as a hard failure. The original stays
   * reachable here, so `err.cause` still answers "was this my abort?".
   *
   * Declared and assigned explicitly rather than passed to `super(message,
   * { cause })`: this package targets ES2020, whose `Error` has no `cause`
   * option in the lib types. */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options !== undefined && "cause" in options) this.cause = options.cause;
  }
}

export class FfmpegNotFoundError extends VideoKitError {
  constructor(binary: string) {
    super(
      `${binary} was not found. Install ffmpeg (macOS: \`brew install ffmpeg\`, ` +
        `Debian/Ubuntu: \`apt-get install ffmpeg\`) or point the ffmpegPath/ffprobePath ` +
        `options at a binary (e.g. the path exported by the ffmpeg-static package).`,
    );
  }
}

export class FfmpegError extends VideoKitError {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(message: string, exitCode: number | null, stderrTail: string) {
    super(`${message} (exit code ${exitCode}): ${stderrTail.trim().split("\n").slice(-3).join(" | ")}`);
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** A ducking task the API accepted but could not finish. `refunded` reports
 * what the server said about the charge at the moment it was polled — surface
 * it, never swallow it. */
export class DuckingFailedError extends VideoKitError {
  readonly code: string;
  readonly refunded: boolean;

  constructor(message: string, code: string, refunded: boolean) {
    // The server derives `code` by splitting its own error_message on ":"
    // (error_message = "DUCKING_FAILED: audio processing failed"), so both
    // fields carry the code and a naive compose renders it twice:
    // `Ducking failed [DUCKING_FAILED]: DUCKING_FAILED: audio processing failed`.
    const detail = message.startsWith(`${code}:`)
      ? message.slice(code.length + 1).trim() || message
      : message;
    // `refunded: false` is a SNAPSHOT, not a verdict: the backend commits the
    // `failed` status BEFORE it reverses the charge, and a reversal that throws
    // is retried on a later sweep. A client that polls inside that window is
    // told `false` about a refund that is merely still in flight — so the
    // wording must not assert that the customer ate the charge.
    const note = refunded
      ? " — the charge was refunded"
      : " — the charge had not been reversed yet when the task was polled; the server " +
        "reverses it after marking the task failed, and retries a reversal that fails, " +
        "so it may still land. Check your usage before assuming you were billed for this.";
    super(`Ducking failed [${code}]: ${detail}${note}`);
    this.code = code;
    this.refunded = refunded;
  }
}
