export class SoniloError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class APIError extends SoniloError {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class AuthenticationError extends APIError {}

export class PaymentRequiredError extends APIError {}

export class BadRequestError extends APIError {
  get detail(): string | undefined {
    const body = this.body as { detail?: unknown } | undefined;
    return typeof body?.detail === "string" ? body.detail : undefined;
  }
}

export class RateLimitError extends APIError {
  readonly retryAfter?: number;

  constructor(message: string, status: number, body?: unknown, retryAfter?: number) {
    super(message, status, body);
    this.retryAfter = retryAfter;
  }
}

/** Raised by generate() when an `error` event arrives mid-stream. */
export class GenerationError extends SoniloError {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function errorFromResponse(res: Response): Promise<APIError> {
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  const detail =
    typeof (body as { detail?: unknown })?.detail === "string"
      ? (body as { detail: string }).detail
      : res.statusText || "request failed";
  const message = `HTTP ${res.status}: ${detail}`;

  switch (res.status) {
    case 401:
      return new AuthenticationError(message, res.status, body);
    case 402:
      return new PaymentRequiredError(message, res.status, body);
    case 429: {
      const ra = res.headers.get("retry-after");
      const retryAfter = ra !== null && ra !== "" && !Number.isNaN(Number(ra)) ? Number(ra) : undefined;
      return new RateLimitError(message, res.status, body, retryAfter);
    }
    case 400:
    case 413:
    case 422:
      return new BadRequestError(message, res.status, body);
    default:
      return new APIError(message, res.status, body);
  }
}
