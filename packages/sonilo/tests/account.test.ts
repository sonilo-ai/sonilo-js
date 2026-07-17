import { describe, expect, it } from "vitest";
import { mockClient } from "./helpers.js";

const SERVICES = {
  available_services: ["text_to_music", "video_to_music"],
  rpm_limit: 60,
  concurrency_limit: 5,
  discount_factor: "0.8000",
  max_upload_size_mb: 300,
};

const USAGE = {
  summary: {
    total_requests: 2,
    total_duration_seconds: 120.0,
    total_cost: "1.2000",
    period_start: "2026-06-08T00:00:00Z",
    period_end: "2026-07-08T00:00:00Z",
  },
  daily: [{ date: "2026-07-07", requests: 2, duration_seconds: 120.0, cost: "1.2000" }],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("account", () => {
  it("fetches services", async () => {
    const { client, calls } = mockClient(() => json(SERVICES));
    const services = await client.account.services();
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/account/services");
    expect(services.rpm_limit).toBe(60);
  });

  it("fetches usage without params", async () => {
    const { client, calls } = mockClient(() => json(USAGE));
    const usage = await client.account.usage();
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/account/usage");
    expect(usage.summary.total_requests).toBe(2);
    expect(usage.daily).toHaveLength(1);
  });

  it("passes days as a query param", async () => {
    const { client, calls } = mockClient(() => json(USAGE));
    await client.account.usage({ days: 7 });
    expect(calls[0]!.url).toBe("https://api.sonilo.com/v1/account/usage?days=7");
  });
});
