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

/** Raised by tasks.wait()/generate() when an SFX task reaches `failed`. */
export class TaskFailedError extends SoniloError {
  readonly code?: string;
  readonly taskId: string;
  readonly refunded?: boolean;

  constructor(
    message: string,
    opts: { code?: string; taskId: string; refunded?: boolean },
  ) {
    super(message);
    this.code = opts.code;
    this.taskId = opts.taskId;
    this.refunded = opts.refunded;
  }
}

/** Poll deadline passed. The task may still finish server-side — resume with
 * tasks.wait(taskId) or tasks.get(taskId). */
export class TaskTimeoutError extends SoniloError {
  readonly taskId: string;

  constructor(message: string, taskId: string) {
    super(message);
    this.taskId = taskId;
  }
}

/** Raised when a one-shot request or download is aborted by its own timeout
 * signal (as opposed to a caller-supplied AbortSignal, which propagates
 * untouched). */
export class RequestTimeoutError extends SoniloError {}

/**
 * True if `err` is the rejection produced when an `AbortSignal.timeout()`
 * we created fires. Used to distinguish "our" timeout aborts (which should be
 * rethrown as `RequestTimeoutError`) from a caller-supplied signal's abort
 * (which must propagate untouched).
 */
export function isTimeoutSignalError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export async function errorFromResponse(res: Response): Promise<APIError> {
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  const rawDetail = (body as { detail?: unknown } | undefined)?.detail;
  const isAbsent = rawDetail === undefined || rawDetail === null || rawDetail === "";
  let detail: string;
  if (isAbsent) {
    detail = res.statusText || "request failed";
  } else if (typeof rawDetail === "string") {
    detail = rawDetail;
  } else {
    try {
      detail = JSON.stringify(rawDetail);
    } catch {
      detail = res.statusText || "request failed";
    }
  }
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
