import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCredential, writeCredential, type StoredCredential } from "../src/credentials.js";
import {
  pollForToken,
  runLogin,
  runLogout,
  runWhoami,
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

  it("passes a request timeout on the device-start call", async () => {
    let capturedSignal: AbortSignal | undefined;
    const d: LoginDeps = {
      fetch: (async (_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify(START), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      openBrowser: async () => {},
      log: () => {},
    };

    await startDevice(BASE, d, { hostname: "h", os: "darwin", version: "0.12.0" });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
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

  // buildClient's "your sonilo login expired — run sonilo login again"
  // message must actually be actionable: without this, the "already signed
  // in" guard below would refuse to do anything (it only checked existence,
  // not expiry), and the user's only way out would be --force.
  it("treats an expired stored credential as not-signed-in and logs in fresh without --force", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ expires_at: "2020-01-01T00:00:00Z" }), path);
    const { d, calls, logs } = runDeps();

    await runLogin([], d, path);

    expect(calls.some((call) => call.url === `${BASE}/cli/auth/device/start`)).toBe(true);
    expect(readCredential(BASE, path)?.api_key).toBe("sk-new");
    expect(logs.some((line) => line.includes("Already signed in"))).toBe(false);
    // The superseded (expired) key is still revoked, best-effort.
    const revoke = calls.find((call) => call.url === `${BASE}/v1/account/keys/self`);
    expect(revoke?.headers["authorization"]).toBe("Bearer sk-old");
  });

  it("normalizes a trailing slash on --api-base so it shares the store key with the bare base", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ api_key: "sk-prod" }), path);
    const { d } = runDeps({ ...TOKEN, api_key: "sk-new-trailing" });

    await runLogin(["--api-base", `${BASE}/`, "--force"], d, path);

    // Written under the normalized (no trailing slash) key, so reading it
    // back under the bare BASE finds the new credential, not a second entry.
    expect(readCredential(BASE, path)?.api_key).toBe("sk-new-trailing");
  });

  it("passes a request timeout on the revoke call, and treats a timeout the same as any other revoke failure", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, logs } = runDeps();
    let revokeSignal: AbortSignal | undefined;
    const timingOut: LoginDeps = {
      ...d,
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/v1/account/keys/self")) {
          revokeSignal = init?.signal ?? undefined;
          throw new DOMException("The operation was aborted.", "TimeoutError");
        }
        return d.fetch(url as unknown as URL, init);
      }) as unknown as typeof fetch,
    };

    await runLogin(["--force"], timingOut, path);

    expect(revokeSignal).toBeInstanceOf(AbortSignal);
    expect(logs.some((line) => line.includes("Note: could not revoke the previous key"))).toBe(
      true,
    );
    // A revoke timeout is not a login failure — the new credential is kept.
    expect(readCredential(BASE, path)?.api_key).toBe("sk-new");
  });
});

/** Records every fetch call made by `runLogout` and routes every one of them
 *  to a single canned status — logout only ever makes at most one call (the
 *  revoke DELETE), so unlike `runDeps` there is no need to branch on path. */
function logoutDeps(status = 200): {
  d: LoginDeps;
  calls: Array<{ method: string; url: string; headers: Record<string, string> }>;
  logs: string[];
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const logs: string[] = [];
  const d: LoginDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key] = value;
      }
      calls.push({ method, url: String(url), headers });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
    sleep: async () => {},
    now: () => 0,
    openBrowser: async () => {},
    log: (line: string) => void logs.push(line),
  };
  return { d, calls, logs };
}

describe("runLogout", () => {
  it("revokes the stored key, then removes the local credential", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, calls } = logoutDeps(200);

    await runLogout([], d, path);

    expect(calls).toEqual([
      {
        method: "DELETE",
        url: `${BASE}/v1/account/keys/self`,
        headers: { authorization: "Bearer sk-old" },
      },
    ]);
    expect(readCredential(BASE, path)).toBeNull();
  });

  it("--local-only removes the local entry and sends no request", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, calls } = logoutDeps(200);

    await runLogout(["--local-only"], d, path);

    expect(calls).toEqual([]);
    expect(readCredential(BASE, path)).toBeNull();
  });

  it("when the revoke call fails, warns the key may still be active and keeps the local credential", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, logs } = logoutDeps(500);

    await runLogout([], d, path);

    expect(logs.some((line) => line.includes("may still be active"))).toBe(true);
    expect(logs.some((line) => line.includes("/dashboard/api-keys"))).toBe(true);
    expect(readCredential(BASE, path)).toEqual(sample());
  });

  it("with no stored credential, prints Not signed in and sends no request", async () => {
    const path = tmpFile();
    const { d, calls, logs } = logoutDeps(200);

    await runLogout([], d, path);

    expect(logs).toEqual(["Not signed in."]);
    expect(calls).toEqual([]);
  });

  it("normalizes a trailing slash on --api-base so it reads the same stored credential as the bare base", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const { d, calls } = logoutDeps(200);

    await runLogout(["--api-base", `${BASE}/`], d, path);

    expect(calls[0]?.url).toBe(`${BASE}/v1/account/keys/self`);
    expect(readCredential(BASE, path)).toBeNull();
  });

  it("passes a request timeout on the revoke call, and treats a timeout like the existing revoke-failure path", async () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    let revokeSignal: AbortSignal | undefined;
    const timingOut: LoginDeps = {
      fetch: (async (_url: string, init?: RequestInit) => {
        revokeSignal = init?.signal ?? undefined;
        throw new DOMException("The operation was aborted.", "TimeoutError");
      }) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      openBrowser: async () => {},
      log: () => {},
    };
    const logs: string[] = [];
    timingOut.log = (line) => void logs.push(line);

    await runLogout([], timingOut, path);

    expect(revokeSignal).toBeInstanceOf(AbortSignal);
    expect(logs.some((line) => line.includes("may still be active"))).toBe(true);
    expect(readCredential(BASE, path)).toEqual(sample());
  });
});

describe("runWhoami", () => {
  it("with only a credential file, prints the account, key prefix, expiry, and source", () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ api_key: "sk-abcdefghijklmnop" }), path);
    const logs: string[] = [];

    runWhoami([], {} as NodeJS.ProcessEnv, (line) => logs.push(line), path);

    const out = logs.join("\n");
    expect(out).toContain("Acme");
    expect(out).toContain("sk-abcde"); // api_key.slice(0, 8)
    expect(out).not.toContain("sk-abcdefghijklmnop"); // never the whole key
    expect(out).toContain("2026-09-01");
    expect(out).toContain("source: credential file");
  });

  it("with SONILO_API_KEY set and a credential file present, says the stored credential is ignored", () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    const logs: string[] = [];

    runWhoami(
      [],
      { SONILO_API_KEY: "sk-env-key" } as unknown as NodeJS.ProcessEnv,
      (line) => logs.push(line),
      path,
    );

    expect(logs.join("\n")).toContain(
      "source: SONILO_API_KEY (the stored credential is being ignored)",
    );
  });

  it("with neither an env key nor a credential file, says not signed in and does not throw", () => {
    const path = tmpFile();
    const logs: string[] = [];

    expect(() =>
      runWhoami([], {} as NodeJS.ProcessEnv, (line) => logs.push(line), path),
    ).not.toThrow();

    expect(logs).toEqual(["Not signed in. Run sonilo login."]);
  });

  // The return value is what cli.ts turns into the process exit code. Scripts
  // and agents branch on `sonilo whoami` to choose between using the CLI and
  // running setup; while this always reported success, every one of them took
  // the signed-in branch with no credential on disk.
  it("reports not-signed-in to the caller, so whoami can exit non-zero", () => {
    const path = tmpFile();

    expect(runWhoami([], {} as NodeJS.ProcessEnv, () => {}, path)).toBe(false);
  });

  it("reports signed in for a stored credential, and for SONILO_API_KEY", () => {
    const path = tmpFile();
    writeCredential(BASE, sample(), path);
    expect(runWhoami([], {} as NodeJS.ProcessEnv, () => {}, path)).toBe(true);

    expect(
      runWhoami(
        [],
        { SONILO_API_KEY: "sk-env-key" } as unknown as NodeJS.ProcessEnv,
        () => {},
        tmpFile(),
      ),
    ).toBe(true);
  });

  // An expired credential names a real account and `sonilo login` fixes it.
  // Calling that "not signed in" would route callers to first-time setup.
  it("still reports signed in when the stored credential has expired", () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ expires_at: "2020-01-01T00:00:00Z" }), path);

    expect(runWhoami([], {} as NodeJS.ProcessEnv, () => {}, path)).toBe(true);
  });

  // The API sends `account_name: " "` for an account with no display name, and
  // `??` let that single space through as the label — printing `account: ` with
  // nothing after it, which reads exactly like a credential that never loaded.
  it("falls back to the account id when the account name is blank", () => {
    for (const blank of [" ", "", "   ", null]) {
      const path = tmpFile();
      writeCredential(BASE, sample({ account_name: blank }), path);
      const logs: string[] = [];

      runWhoami([], {} as NodeJS.ProcessEnv, (line) => logs.push(line), path);

      expect(logs.join("\n")).toContain("account: acct-0");
    }
  });

  it("marks an expired stored credential as expired beside the date", () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ expires_at: "2020-01-01T00:00:00Z" }), path);
    const logs: string[] = [];

    runWhoami([], {} as NodeJS.ProcessEnv, (line) => logs.push(line), path);

    const dateLine = logs.find((line) => line.includes("2020-01-01"));
    expect(dateLine).toBeDefined();
    expect(dateLine).toContain("expired");
  });

  // Truthiness, matching buildClient's `apiKeyFlag ?? process.env.SONILO_API_KEY`
  // then `if (!apiKey)`: an exported-but-empty SONILO_API_KEY must not claim
  // to be the active source, since buildClient would fall through it.
  it("does not treat an empty SONILO_API_KEY as the active source", () => {
    const path = tmpFile();
    writeCredential(BASE, sample({ api_key: "sk-abcdefghijklmnop" }), path);
    const logs: string[] = [];

    runWhoami(
      [],
      { SONILO_API_KEY: "" } as unknown as NodeJS.ProcessEnv,
      (line) => logs.push(line),
      path,
    );

    const out = logs.join("\n");
    expect(out).not.toContain("SONILO_API_KEY");
    expect(out).toContain("source: credential file");
  });

  it("with SONILO_API_KEY set and no credential file entry, reports the source without the ignored-credential suffix", () => {
    const path = tmpFile();
    const logs: string[] = [];

    runWhoami(
      [],
      { SONILO_API_KEY: "sk-env-key" } as unknown as NodeJS.ProcessEnv,
      (line) => logs.push(line),
      path,
    );

    expect(logs).toEqual(["source: SONILO_API_KEY"]);
  });
});
