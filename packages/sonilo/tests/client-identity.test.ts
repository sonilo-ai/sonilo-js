import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SoniloClient, DEFAULT_CLIENT_NAME } from "../src/client.js";
import { VERSION } from "../src/version.js";

function capture() {
  let seen: Headers | undefined;
  const fetch = (async (_u: string, init: RequestInit) => {
    seen = new Headers(init.headers);
    return new Response(JSON.stringify({ available_services: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, headers: () => seen! };
}

describe("client identity", () => {
  it("defaults to sdk-js and the SDK version", async () => {
    const c = capture();
    await new SoniloClient({ apiKey: "sk-test", fetch: c.fetch }).account.services();
    expect(c.headers().get("x-sonilo-client")).toBe("sdk-js");
    expect(c.headers().get("x-sonilo-client-version")).toBe(VERSION);
    expect(DEFAULT_CLIENT_NAME).toBe("sdk-js");
  });

  it("lets a wrapper override name and version", async () => {
    const c = capture();
    await new SoniloClient({
      apiKey: "sk-test", fetch: c.fetch,
      clientName: "cli-js", clientVersion: "1.2.3",
    }).account.services();
    expect(c.headers().get("x-sonilo-client")).toBe("cli-js");
    expect(c.headers().get("x-sonilo-client-version")).toBe("1.2.3");
  });

  it("treats the two overrides independently", async () => {
    const c = capture();
    await new SoniloClient({
      apiKey: "sk-test", fetch: c.fetch, clientName: "videokit-js",
    }).account.services();
    expect(c.headers().get("x-sonilo-client")).toBe("videokit-js");
    expect(c.headers().get("x-sonilo-client-version")).toBe(VERSION);
  });

  // The pre-existing header test compares the header to VERSION, so it stays
  // green even when VERSION drifts from the published package version — which
  // is exactly what happened at 0.5.0 (version.ts was left at 0.4.0, and every
  // request under-reported the SDK version). Compare against package.json, the
  // thing changesets actually bumps.
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
