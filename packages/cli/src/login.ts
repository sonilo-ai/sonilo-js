/** The response from `POST /cli/auth/device/start`. */
export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** The response from `POST /cli/auth/device/token` once the user approves. */
export interface DeviceToken {
  api_key: string;
  key_id: string;
  account_id: string;
  account_name: string | null;
  expires_at: string;
}

/** Everything I/O-shaped that `startDevice`/`pollForToken` touch, injected so
 *  tests never depend on a real network, clock, or browser. */
export interface LoginDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openBrowser: (url: string) => Promise<void>;
  log: (line: string) => void;
}

const TOO_MANY_ATTEMPTS =
  "too many sign-in attempts right now — wait a minute and run sonilo login again";
const DENIED = "sign-in was denied in the browser — nothing was granted";
const EXPIRED = "that sign-in code expired — run sonilo login again";

/** Reads `key` off `body` as a string, or returns undefined if it isn't one.
 *  `noUncheckedIndexedAccess` means an index signature always includes
 *  `undefined`, so every read needs an explicit narrow like this. */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

async function parseJsonObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Starts the device-code flow: registers this CLI instance with the backend
 *  and gets back the codes the user approves in the browser. */
export async function startDevice(
  apiBase: string,
  deps: LoginDeps,
  meta: { hostname: string; os: string; version: string },
): Promise<DeviceStart> {
  const response = await deps.fetch(`${apiBase}/cli/auth/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client: "sonilo-cli",
      client_version: meta.version,
      hostname: meta.hostname,
      os: meta.os,
    }),
  });

  if (response.status === 429) {
    throw new Error(TOO_MANY_ATTEMPTS);
  }
  if (response.status !== 200) {
    throw new Error(`failed to start sign-in (HTTP ${response.status})`);
  }

  const body = await parseJsonObject(response);
  const device_code = stringField(body, "device_code");
  const user_code = stringField(body, "user_code");
  const verification_uri = stringField(body, "verification_uri");
  const verification_uri_complete = stringField(body, "verification_uri_complete");
  const expires_in = body["expires_in"];
  const interval = body["interval"];
  if (
    device_code === undefined ||
    user_code === undefined ||
    verification_uri === undefined ||
    verification_uri_complete === undefined ||
    typeof expires_in !== "number" ||
    typeof interval !== "number"
  ) {
    throw new Error("sign-in start response was missing required fields");
  }

  return {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in,
    interval,
  };
}

/** Polls `/cli/auth/device/token` until the user approves in the browser (or
 *  the code expires / is denied). The first poll fires immediately — the
 *  wait is between polls, not before the first one — and a poll that reports
 *  `authorization_pending` or `slow_down` is followed by one `intervalMs`
 *  sleep before the next attempt. */
export async function pollForToken(
  apiBase: string,
  start: DeviceStart,
  deps: LoginDeps,
): Promise<DeviceToken> {
  let intervalMs = start.interval * 1000;
  const deadlineMs = start.expires_in * 1000;
  const startedAt = deps.now();

  for (;;) {
    if (deps.now() - startedAt > deadlineMs) {
      throw new Error(EXPIRED);
    }

    const response = await deps.fetch(`${apiBase}/cli/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });

    const body = await parseJsonObject(response);

    if (response.status === 200) {
      const api_key = stringField(body, "api_key");
      const key_id = stringField(body, "key_id");
      const account_id = stringField(body, "account_id");
      const account_name = body["account_name"];
      const expires_at = stringField(body, "expires_at");
      if (
        api_key === undefined ||
        key_id === undefined ||
        account_id === undefined ||
        expires_at === undefined ||
        !(account_name === null || typeof account_name === "string")
      ) {
        throw new Error("sign-in token response was missing required fields");
      }
      return { api_key, key_id, account_id, account_name, expires_at };
    }

    const error = stringField(body, "error");
    switch (error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += 1000;
        break;
      case "access_denied":
        throw new Error(DENIED);
      case "expired_token":
      case "invalid_grant":
        throw new Error(EXPIRED);
      default:
        throw new Error(`sign-in failed (HTTP ${response.status})`);
    }

    await deps.sleep(intervalMs);
  }
}
