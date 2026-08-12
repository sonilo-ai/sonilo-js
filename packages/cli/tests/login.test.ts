import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCredential, writeCredential, type StoredCredential } from "../src/credentials.js";
import {
  pollForToken,
  runLogin,
  startDevice,
  type DeviceStart,
  type LoginDeps,
} from "../src/login.js";

const BASE = "https://api.sonilo.com";
const STAGING = "https://api.staging.sonilo.com";

function deps(responses: Array<{ status: number; body: unknown }>): {
  d: LoginDeps;
  sleeps: number[];
  urls: string[];
} {
  const sleeps: number[] = [];
  const urls: string[] = [];
  let i = 0;
  const d: LoginDeps = {
    fetch: (async (url: string) => {
      urls.push(String(url));
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 0,
    openBrowser: async () => {},
    log: () => {},
  };
  return { d, sleeps, urls };
}

const START: DeviceStart = {
  device_code: "dev-1",
  user_code: "K7QM-3FDX",
  verification_uri: "https://platform.sonilo.com/dashboard/cli-auth",
  verification_uri_complete:
    "https://platform.sonilo.com/dashboard/cli-auth?code=K7QM-3FDX",
  expires_in: 600,
  interval: 5,
};

describe("startDevice", () => {
  it("posts the client metadata and returns the codes", async () => {
    const { d, urls } = deps([{ status: 200, body: START }]);
    const out = await startDevice(BASE, d, {
      hostname: "spencer-mbp",
      os: "darwin",
      version: "0.12.0",
    });
    expect(urls[0]).toBe(`${BASE}/cli/auth/device/start`);
    expect(out.user_code).toBe("K7QM-3FDX");
  });

  it("explains a 429 instead of leaking the error code", async () => {
    const { d } = deps([{ status: 429, body: { error: "too_many_requests" } }]);
    await expect(
      startDevice(BASE, d, { hostname: "h", os: "darwin", version: "0.12.0" }),
    ).rejects.toThrow(/too many sign-in attempts/i);
  });
});

describe("pollForToken", () => {
  it("waits one interval between polls and returns the key", async () => {
    const { d, sleeps } = deps([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          api_key: "sk-new",
          key_id: "key-1",
          account_id: "acct-1",
          account_name: "Acme",
          expires_at: "2026-11-09T04:12:00Z",
        },
      },
    ]);
    const token = await pollForToken(BASE, START, d);
    expect(token.api_key).toBe("sk-new");
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("backs off permanently by a second after slow_down", async () => {
    const { d, sleeps } = deps([
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          api_key: "sk-new",
          key_id: "k",
          account_id: "a",
          account_name: null,
          expires_at: "2026-11-09T04:12:00Z",
        },
      },
    ]);
    await pollForToken(BASE, START, d);
    expect(sleeps).toEqual([6000, 6000]);
  });

  it("reports a denied approval in plain words", async () => {
    const { d } = deps([{ status: 400, body: { error: "access_denied" } }]);
    await expect(pollForToken(BASE, START, d)).rejects.toThrow(/denied/i);
  });

  it("reports an expired code and says to run login again", async () => {
    const { d } = deps([{ status: 400, body: { error: "expired_token" } }]);
    await expect(pollForToken(BASE, START, d)).rejects.toThrow(/expired.*sonilo login/is);
  });

  it("stops once the code's own lifetime has passed", async () => {
    const { d, sleeps } = deps([{ status: 400, body: { error: "authorization_pending" } }]);
    let t = 0;
    d.now = () => (t += 400_000); // two ticks blow past expires_in
    await expect(pollForToken(BASE, START, d)).rejects.toThrow(/expired/i);
    expect(sleeps.length).toBeLessThan(5);
  });
});

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sonilo-login-")), "credentials.json");
}

function sample(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    api_key: "sk-old",
    key_id: "key-0",
    account_id: "acct-0",
    account_name: "Acme",
    expires_at: "2026-09-01T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    created_by: "sonilo-cli/0.10.0",
    ...overrides,
  };
}

const TOKEN = {
  api_key: "sk-new",
  key_id: "key-1",
  account_id: "acct-1",
  account_name: "Acme",
  expires_at: "2026-11-09T04:12:00Z",
};

/** Records every fetch call (method/url/headers) and routes it to a canned
 *  response by path, so a single mock can serve the whole login flow: device
 *  start, the (single, immediately-successful) token poll, and the DELETE of
 *  a superseded key. */
function runDeps(tokenBody: unknown = TOKEN): {
  d: LoginDeps;
  calls: Array<{ method: string; url: string; headers: Record<string, string> }>;
  logs: string[];
  browserUrls: string[];
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const browserUrls: string[] = [];
  const d: LoginDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key] = value;
      }
      calls.push({ method, url: String(url), headers });
      if (String(url).endsWith("/cli/auth/device/start")) {
        return new Response(JSON.stringify(START), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/cli/auth/device/token")) {
        return new Response(JSON.stringify(tokenBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/v1/account/keys/self")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch call: ${method} ${String(url)}`);
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => 0,
    openBrowser: async (url: string) => void browserUrls.push(url),
    log: (line: string) => void logs.push(line),
  };
  return { d, calls, logs, browserUrls };
}

describe("runLogin", () => {
  it("writes the credential for the default base and prints the account and expiry", async () => {
    const path = tmpFile();
    const { d, logs } = runDeps();

    await runLogin([], d, path);

    expect(readCredential(BASE, path)?.api_key).toBe("sk-new");
    expect(logs.some((line) => line.includes("Signed in as Acme"))).toBe(true);
    expect(logs.some((line) => line.includes("2026-11-09"))).toBe(true);
  });

  it("refuses to re-authenticate over an existing credential without --force", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, calls, logs } = runDeps();

    await runLogin([], d, path);

    expect(logs).toEqual([
      `Already signed in as Acme (cli: ${hostname()}, expires 2026-09-01). Re-authenticate with --force.`,
    ]);
    expect(calls).toEqual([]);
    expect(readCredential(BASE, path)?.api_key).toBe("sk-old");
  });

  it("--force replaces the credential and revokes the previous key", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, calls } = runDeps();

    await runLogin(["--force"], d, path);

    expect(readCredential(BASE, path)?.api_key).toBe("sk-new");
    const revoke = calls.find((call) => call.url === `${BASE}/v1/account/keys/self`);
    expect(revoke?.method).toBe("DELETE");
    expect(revoke?.headers["authorization"]).toBe("Bearer sk-old");
  });

  it("--no-browser skips opening a browser but still prints the verification URL", async () => {
    const path = tmpFile();
    const { d, logs, browserUrls } = runDeps();

    await runLogin(["--no-browser"], d, path);

    expect(browserUrls).toEqual([]);
    expect(logs.some((line) => line.includes(START.verification_uri_complete))).toBe(true);
  });

  it("--api-base writes under that base and leaves the production credential untouched", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ api_key: "sk-prod" }), path);
    const { d } = runDeps({ ...TOKEN, api_key: "sk-staging" });

    await runLogin(["--api-base", STAGING], d, path);

    expect(readCredential(STAGING, path)?.api_key).toBe("sk-staging");
    expect(readCredential(BASE, path)?.api_key).toBe("sk-prod");
  });
});
