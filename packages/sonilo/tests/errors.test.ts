import { describe, expect, it } from "vitest";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  GenerationError,
  PaymentRequiredError,
  RateLimitError,
  SoniloError,
  TrialExhaustedError,
  errorFromResponse,
} from "../src/errors.js";

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
  statusText?: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("errorFromResponse", () => {
  it("maps 400 to BadRequestError from the API's {code, message} envelope", async () => {
    const err = await errorFromResponse(
      jsonResponse(400, {
        code: "invalid_request",
        message: "audio_format must be one of wav, mp3, aac, flac",
      }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("audio_format must be one of");
    expect(err.code).toBe("invalid_request");
    expect((err as BadRequestError).detail).toBe("audio_format must be one of wav, mp3, aac, flac");
  });

  it("maps 401 to AuthenticationError", async () => {
    const err = await errorFromResponse(
      jsonResponse(401, { code: "unauthorized", message: "Invalid API key" }),
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("Invalid API key");
    expect(err.code).toBe("unauthorized");
  });

  it("maps 402 to PaymentRequiredError", async () => {
    const err = await errorFromResponse(
      jsonResponse(402, { code: "payment_required", message: "Insufficient balance" }),
    );
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err).not.toBeInstanceOf(TrialExhaustedError);
    expect(err.message).toContain("Insufficient balance");
  });

  it("maps a 402 carrying trial_exhausted to TrialExhaustedError", async () => {
    const err = await errorFromResponse(
      jsonResponse(402, {
        code: "trial_exhausted",
        message:
          "You've used your 2 free trial calls for text-to-music. Add a payment method to continue: https://platform.sonilo.com/dashboard/billing",
      }),
    );
    expect(err).toBeInstanceOf(TrialExhaustedError);
    expect(err.code).toBe("trial_exhausted");
    // Still a PaymentRequiredError, so callers that catch every 402 keep working.
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err.message).toContain("free trial calls for text-to-music");
  });

  it("keeps a 402 with an insufficient_balance code out of TrialExhaustedError", async () => {
    const err = await errorFromResponse(
      jsonResponse(402, {
        code: "insufficient_balance",
        message: "Insufficient balance: need 0.4320, have 0.1000",
      }),
    );
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err).not.toBeInstanceOf(TrialExhaustedError);
    expect(err.code).toBe("insufficient_balance");
  });

  it("maps 404 to APIError exposing the API's code", async () => {
    const err = await errorFromResponse(
      jsonResponse(404, { code: "not_found", message: "Task not found" }),
    );
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  it("maps 422 to BadRequestError exposing the validation errors array", async () => {
    const err = await errorFromResponse(
      jsonResponse(422, {
        code: "unprocessable_entity",
        message: "Input should be less than or equal to 180",
        errors: [{ loc: ["body", "duration"], msg: "Input should be less than or equal to 180", type: "less_than_equal" }],
      }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("Input should be less than or equal to 180");
    expect(err.errors).toHaveLength(1);
    expect((err.errors as Array<{ msg: string }>)[0]!.msg).toBe("Input should be less than or equal to 180");
  });

  it("maps 429 to RateLimitError with retryAfter from header and exposes the code", async () => {
    const err = await errorFromResponse(
      jsonResponse(
        429,
        { code: "rate_limit_exceeded", message: "Rate limit exceeded" },
        { "retry-after": "30" },
      ),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(30);
    expect(err.code).toBe("rate_limit_exceeded");
  });

  it("maps 429 without header to retryAfter undefined", async () => {
    const err = await errorFromResponse(
      jsonResponse(429, { code: "rate_limit_exceeded", message: "Rate limit exceeded" }),
    );
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  // Two limits share this status and want opposite handling — slow down, or
  // wait for a running generation to finish. The code is identical for both,
  // so the message is the only thing that tells them apart: it has to survive
  // whole, numbers and contact address included.
  it.each([
    "Rate limit exceeded: your account allows 60 requests per minute. Rejected requests count toward the limit too, so wait for the next minute window (up to 60 sec) rather than retrying right away. To raise your limit, contact info@sonilo.com.",
    "Too many concurrent generations: 5 of 5 in progress. Wait for one to finish before starting another. To raise your limit, contact info@sonilo.com.",
  ])("carries the 429 message through verbatim: %s", async (message) => {
    const err = await errorFromResponse(
      jsonResponse(429, { code: "rate_limit_exceeded", message }),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toBe(`HTTP 429: ${message}`);
  });

  it.each([400, 413, 422])("maps %i to BadRequestError exposing legacy detail", async (status) => {
    const err = await errorFromResponse(jsonResponse(status, { detail: "bad input" }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).detail).toBe("bad input");
    expect(err.message).toContain("bad input");
  });

  it("stringifies a structured (non-string) detail, e.g. FastAPI 422 validation errors", async () => {
    const err = await errorFromResponse(
      jsonResponse(422, {
        detail: [{ loc: ["body", "duration"], msg: "field required", type: "missing" }],
      }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toContain("field required");
  });

  it("falls back to statusText when neither message nor detail is present", async () => {
    const err = await errorFromResponse(jsonResponse(422, {}, undefined, "Unprocessable Entity"));
    expect(err.message).toBe("HTTP 422: Unprocessable Entity");
  });

  it("falls back to statusText when detail is null", async () => {
    const err = await errorFromResponse(
      jsonResponse(422, { detail: null }, undefined, "Unprocessable Entity"),
    );
    expect(err.message).toBe("HTTP 422: Unprocessable Entity");
    expect(err.message).not.toContain("null");
  });

  it("falls back to statusText when detail is an empty string", async () => {
    const err = await errorFromResponse(
      jsonResponse(422, { detail: "" }, undefined, "Unprocessable Entity"),
    );
    expect(err.message).toBe("HTTP 422: Unprocessable Entity");
  });

  it("keeps a non-empty string detail as-is, e.g. a 400 bad input message", async () => {
    const err = await errorFromResponse(jsonResponse(400, { detail: "bad input" }));
    expect(err.message).toContain("bad input");
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
