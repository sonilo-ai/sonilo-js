import { afterEach, describe, expect, it } from "vitest";
import { SoniloClient } from "../src/client.js";
import { AuthenticationError, RequestTimeoutError, SoniloError } from "../src/errors.js";
import { VERSION } from "../src/version.js";
import { mockClient, neverResolvingFetch } from "./helpers.js";

const ORIGINAL_ENV_KEY = process.env.SONILO_API_KEY;

afterEach(() => {
  if (ORIGINAL_ENV_KEY === undefined) delete process.env.SONILO_API_KEY;
  else process.env.SONILO_API_KEY = ORIGINAL_ENV_KEY;
});

describe("SoniloClient constructor", () => {
  it("throws without an API key", () => {
    delete process.env.SONILO_API_KEY;
    expect(() => new SoniloClient()).toThrow(SoniloError);
  });

  it("falls back to SONILO_API_KEY env var", () => {
    process.env.SONILO_API_KEY = "sk_env";
    expect(() => new SoniloClient()).not.toThrow();
  });

  it("strips trailing slashes from baseUrl", () => {
    const client = new SoniloClient({ apiKey: "sk", baseUrl: "https://example.com///" });
    expect(client.baseUrl).toBe("https://example.com");
  });

  it("defaults baseUrl to production", () => {
    const client = new SoniloClient({ apiKey: "sk" });
    expect(client.baseUrl).toBe("https://api.sonilo.com");
  });

  it("calls a user-supplied fetch with a safe receiver", async () => {
    const calls: unknown[] = [];
    const brandCheckedFetch = function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      calls.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    } as typeof fetch;
    const client = new SoniloClient({ apiKey: "sk", fetch: brandCheckedFetch });
    await expect(client.request("/v1/account/services")).resolves.toBeInstanceOf(Response);
    expect(calls).toHaveLength(1);
  });
});

describe("request", () => {
  it("sends auth and telemetry headers to the resolved URL", async () => {
    const { client, calls } = mockClient(() => new Response("{}", { status: 200 }));
    await client.request("/v1/account/services");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/account/services");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test_123");
    expect(headers.get("x-sonilo-client")).toBe("sdk-js");
    expect(headers.get("x-sonilo-client-version")).toBe(VERSION);
  });

  it("throws mapped errors on non-2xx", async () => {
    const { client } = mockClient(
      () =>
        new Response(JSON.stringify({ detail: "Invalid API key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.request("/v1/account/usage")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("attaches a default abort signal to every request", async () => {
    const { client, calls } = mockClient(() => new Response("{}", { status: 200 }));
    await client.request("/v1/account/services");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not overwrite a caller-supplied abort signal", async () => {
    const { client, calls } = mockClient(() => new Response("{}", { status: 200 }));
    const controller = new AbortController();
    await client.request("/v1/account/services", { signal: controller.signal });
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("rejects with RequestTimeoutError when the client's own timeout fires", async () => {
    const client = new SoniloClient({
      apiKey: "sk_test_123",
      timeout: 5,
      fetch: neverResolvingFetch(),
    });
    await expect(client.tasks.get("t1")).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("propagates a caller-supplied signal's abort without rewrapping it", async () => {
    const client = new SoniloClient({
      apiKey: "sk_test_123",
      timeout: 5,
      fetch: neverResolvingFetch(),
    });
    const controller = new AbortController();
    const promise = client.request("/v1/account/services", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });

  it("does not attach an abort signal when the caller opts out (timeout: null)", async () => {
    const { client, calls } = mockClient(() => new Response("{}", { status: 200 }));
    await client.request("/v1/account/services", {}, { timeout: null });
    expect(calls[0]!.init.signal).toBeUndefined();
  });
});
