import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { readCredential, writeCredential, type StoredCredential } from "./credentials.js";
import { VERSION } from "./version.js";

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

/** An ISO timestamp's date portion, in UTC, for the human-readable "expires
 *  <date>" lines. UTC (not the local zone) keeps this deterministic in tests
 *  and consistent regardless of where the CLI runs. */
function expiryDate(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().slice(0, 10);
}

/** The name to greet the user by: the account name the backend assigned, or
 *  the account id when the backend has none on file (e.g. a POC account). */
function accountLabel(cred: { account_name: string | null; account_id: string }): string {
  return cred.account_name ?? cred.account_id;
}

/** `sonilo login`: runs the device-code flow end to end and stores the
 *  resulting key. Reused across api bases (prod, staging, ...) by keying the
 *  credential store on `apiBase`, so signing into staging never disturbs a
 *  production credential. */
export async function runLogin(
  argv: string[],
  deps: LoginDeps,
  filePath?: string,
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "api-base": { type: "string" },
    },
  });

  const apiBase = values["api-base"] ?? process.env["SONILO_API_URL"] ?? "https://api.sonilo.com";
  const previous = readCredential(apiBase, filePath);

  if (previous && values.force !== true) {
    // The backend names the minted key "cli: {hostname}" using the same
    // os.hostname() this file sends from startDevice() below — not the API
    // host — so a user can find it in the dashboard by matching this line
    // against the key list.
    deps.log(
      `Already signed in as ${accountLabel(previous)} (cli: ${hostname()}, expires ${expiryDate(previous.expires_at)}). Re-authenticate with --force.`,
    );
    return;
  }

  const start = await startDevice(apiBase, deps, {
    hostname: hostname(),
    os: process.platform,
    version: VERSION,
  });

  deps.log(`First copy your one-time code: ${start.user_code}`);
  deps.log(`Then open this URL to confirm: ${start.verification_uri_complete}`);
  if (values["no-browser"] !== true) {
    await deps.openBrowser(start.verification_uri_complete);
  }

  const token = await pollForToken(apiBase, start, deps);

  const credential: StoredCredential = {
    api_key: token.api_key,
    key_id: token.key_id,
    account_id: token.account_id,
    account_name: token.account_name,
    expires_at: token.expires_at,
    created_at: new Date().toISOString(),
    created_by: `sonilo-cli/${VERSION}`,
  };
  writeCredential(apiBase, credential, filePath);

  // The new credential is already saved at this point, so a revoke failure
  // is a note, never a login failure — the superseded key still expires on
  // its own even if this call never lands.
  if (previous) {
    try {
      const response = await deps.fetch(`${apiBase}/v1/account/keys/self`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${previous.api_key}` },
      });
      if (!response.ok) {
        deps.log(`Note: could not revoke the previous key (HTTP ${response.status}).`);
      }
    } catch {
      deps.log("Note: could not revoke the previous key.");
    }
  }

  deps.log(`Signed in as ${accountLabel(token)}. Key expires ${expiryDate(token.expires_at)}.`);
}

/** Opens `url` in the platform's default browser, backgrounded and detached
 *  so the CLI never waits on (or gets tied to the lifetime of) the browser
 *  process. `start` on Windows is a shell built-in, not an executable, hence
 *  routing it through `cmd /c` — the empty string after `start` is its own
 *  window-title argument, otherwise a URL containing spaces would be
 *  misparsed as the title. */
function platformOpenCommand(url: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** The real `LoginDeps` used by the CLI binary: network `fetch`, real time
 *  and sleep, `console.log`, and a best-effort browser launch. A machine
 *  with no GUI browser (a server, a container) must still complete login —
 *  it just never gets an automatic browser window — so every failure here is
 *  swallowed rather than thrown. */
export function defaultLoginDeps(): LoginDeps {
  return {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
    openBrowser: async (url) => {
      try {
        const { command, args } = platformOpenCommand(url);
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.on("error", () => {
          /* no browser available on this machine — the URL is already printed */
        });
        child.unref();
      } catch {
        /* spawn threw synchronously — same fallback as the "error" event above */
      }
    },
  };
}
