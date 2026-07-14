export class VideoKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
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
 * whether the backend reversed the charge — surface it, never swallow it. */
export class DuckingFailedError extends VideoKitError {
  readonly code: string;
  readonly refunded: boolean;

  constructor(message: string, code: string, refunded: boolean) {
    super(`Ducking failed [${code}]: ${message}${refunded ? " — the charge was refunded" : ""}`);
    this.code = code;
    this.refunded = refunded;
  }
}
