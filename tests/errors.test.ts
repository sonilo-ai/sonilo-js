import { describe, expect, it } from "vitest";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  GenerationError,
  PaymentRequiredError,
  RateLimitError,
  SoniloError,
  errorFromResponse,
} from "../src/errors.js";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("errorFromResponse", () => {
  it("maps 401 to AuthenticationError", async () => {
    const err = await errorFromResponse(jsonResponse(401, { detail: "Invalid API key" }));
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("Invalid API key");
  });

  it("maps 402 to PaymentRequiredError", async () => {
    const err = await errorFromResponse(jsonResponse(402, { detail: "Insufficient balance" }));
    expect(err).toBeInstanceOf(PaymentRequiredError);
  });

  it("maps 429 to RateLimitError with retryAfter from header", async () => {
    const err = await errorFromResponse(
      jsonResponse(429, { detail: "Rate limit exceeded" }, { "retry-after": "7" }),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(7);
  });

  it("maps 429 without header to retryAfter undefined", async () => {
    const err = await errorFromResponse(jsonResponse(429, { detail: "Rate limit exceeded" }));
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  it.each([400, 413, 422])("maps %i to BadRequestError exposing detail", async (status) => {
    const err = await errorFromResponse(jsonResponse(status, { detail: "bad input" }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).detail).toBe("bad input");
  });

  it("maps other statuses to APIError and keeps non-JSON body as text", async () => {
    const err = await errorFromResponse(new Response("boom", { status: 500 }));
    expect(err).toBeInstanceOf(APIError);
    expect(err).not.toBeInstanceOf(BadRequestError);
    expect(err.status).toBe(500);
    expect(err.body).toBe("boom");
  });
});

describe("error classes", () => {
  it("all extend SoniloError and carry names", () => {
    const gen = new GenerationError("failed", "FAL_ERROR");
    expect(gen).toBeInstanceOf(SoniloError);
    expect(gen.code).toBe("FAL_ERROR");
    expect(gen.name).toBe("GenerationError");
    expect(new AuthenticationError("x", 401)).toBeInstanceOf(APIError);
  });
});
