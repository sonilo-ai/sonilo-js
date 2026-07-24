import { RequestTimeoutError, SoniloError, errorFromResponse, isTimeoutSignalError } from "./errors.js";
import { Account } from "./resources/account.js";
import { Tasks } from "./resources/tasks.js";
import { TextToMusic } from "./resources/textToMusic.js";
import { VideoToMusic } from "./resources/videoToMusic.js";
import { TextToSfx } from "./resources/textToSfx.js";
import { VideoToSfx } from "./resources/videoToSfx.js";
import { VideoToVideoMusic } from "./resources/videoToVideoMusic.js";
import { VideoToVideoSfx } from "./resources/videoToVideoSfx.js";
import { VideoToSound } from "./resources/videoToSound.js";
import { VideoToVideoSound } from "./resources/videoToVideoSound.js";
import { Dubbing } from "./resources/dubbing.js";
import { VERSION } from "./version.js";

export interface SoniloClientOptions {
  /** Defaults to the SONILO_API_KEY environment variable (Node.js only). */
  apiKey?: string;
  /** Defaults to https://api.sonilo.com */
  baseUrl?: string;
  /** Injection point for tests and custom transports. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds before an in-flight request is aborted. Default 600000. */
  timeout?: number;
  /**
   * Identifies a wrapper built on this SDK (the CLI, the video kit) in the
   * `X-Sonilo-Client` header. Leave unset for direct SDK use — without an
   * override a wrapper's traffic is indistinguishable from the SDK's own.
   */
  clientName?: string;
  /** Version reported alongside `clientName`. Defaults to the SDK's version. */
  clientVersion?: string;
}

const DEFAULT_BASE_URL = "https://api.sonilo.com";

/**
 * Reported in `X-Sonilo-Client` unless a wrapper overrides it. First-party
 * wrappers (the CLI, the video kit) pass their own name so their traffic stays
 * distinguishable from direct SDK use in server-side analytics.
 */
export const DEFAULT_CLIENT_NAME = "sdk-js";

/** Milliseconds before an in-flight request is aborted, unless overridden. */
export const DEFAULT_TIMEOUT_MS = 600_000;

export class SoniloClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeout: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  readonly account: Account;
  readonly tasks: Tasks;
  readonly textToMusic: TextToMusic;
  readonly videoToMusic: VideoToMusic;
  readonly textToSfx: TextToSfx;
  readonly videoToSfx: VideoToSfx;
  readonly videoToVideoMusic: VideoToVideoMusic;
  readonly videoToVideoSfx: VideoToVideoSfx;
  readonly videoToSound: VideoToSound;
  readonly videoToVideoSound: VideoToVideoSound;
  readonly dubbing: Dubbing;

  constructor(options: SoniloClientOptions = {}) {
    const envKey =
      typeof process !== "undefined" ? process.env?.SONILO_API_KEY : undefined;
    const apiKey = options.apiKey ?? envKey;
    if (!apiKey) {
      throw new SoniloError(
        "Missing API key: pass { apiKey } or set the SONILO_API_KEY environment variable",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.clientName = options.clientName ?? DEFAULT_CLIENT_NAME;
    this.clientVersion = options.clientVersion ?? VERSION;
    this.account = new Account(this);
    this.tasks = new Tasks(this);
    this.textToMusic = new TextToMusic(this);
    this.videoToMusic = new VideoToMusic(this);
    this.textToSfx = new TextToSfx(this);
    this.videoToSfx = new VideoToSfx(this);
    this.videoToVideoMusic = new VideoToVideoMusic(this);
    this.videoToVideoSfx = new VideoToVideoSfx(this);
    this.videoToSound = new VideoToSound(this);
    this.videoToVideoSound = new VideoToVideoSound(this);
    this.dubbing = new Dubbing(this);
  }

  /**
   * Perform an authenticated request; throws a typed error on non-2xx.
   *
   * `opts.timeout` overrides the client's default timeout for this call;
   * pass `null` to disable the abort-on-timeout behavior entirely (used by
   * the streaming music endpoints — see textToMusic.ts / videoToMusic.ts).
   * A caller-supplied `init.signal` always wins over any timeout signal.
   */
  async request(
    path: string,
    init: RequestInit = {},
    opts: { timeout?: number | null } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("X-Sonilo-Client", this.clientName);
    headers.set("X-Sonilo-Client-Version", this.clientVersion);
    const timeout = opts.timeout === undefined ? this.timeout : opts.timeout;
    // We only "own" the signal (and may later rewrap its abort as a
    // RequestTimeoutError) when the caller didn't supply one and a timeout
    // is actually enabled.
    const ownsSignal = init.signal == null && timeout !== null;
    const signal = init.signal ?? (timeout === null ? undefined : AbortSignal.timeout(timeout));
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers, signal });
      if (!res.ok) throw await errorFromResponse(res);
      return res;
    } catch (err) {
      if (ownsSignal && isTimeoutSignalError(err)) {
        throw new RequestTimeoutError(`Request to ${path} timed out after ${timeout}ms`);
      }
      throw err;
    }
  }
}
