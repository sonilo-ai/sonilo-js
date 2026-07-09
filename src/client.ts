import { SoniloError, errorFromResponse } from "./errors.js";
import { Account } from "./resources/account.js";
import { TextToMusic } from "./resources/textToMusic.js";
import { VideoToMusic } from "./resources/videoToMusic.js";
import { VERSION } from "./version.js";

export interface SoniloClientOptions {
  /** Defaults to the SONILO_API_KEY environment variable (Node.js only). */
  apiKey?: string;
  /** Defaults to https://api.sonilo.com */
  baseUrl?: string;
  /** Injection point for tests and custom transports. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = "https://api.sonilo.com";

export class SoniloClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  readonly account: Account;
  readonly textToMusic: TextToMusic;
  readonly videoToMusic: VideoToMusic;

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
    this.account = new Account(this);
    this.textToMusic = new TextToMusic(this);
    this.videoToMusic = new VideoToMusic(this);
  }

  /** Perform an authenticated request; throws a typed error on non-2xx. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("X-Sonilo-Client", "sdk-js");
    headers.set("X-Sonilo-Client-Version", VERSION);
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }
}
