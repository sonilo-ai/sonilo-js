import { describe, expect, it, vi } from "vitest";
import { pollForToken, startDevice, type DeviceStart, type LoginDeps } from "../src/login.js";

const BASE = "https://api.sonilo.com";

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
