import type { SoniloClient } from "../client.js";
import { SoniloError, TaskFailedError, TaskTimeoutError } from "../errors.js";
import type { SfxResult, WaitOptions } from "../types.js";

export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_WAIT_TIMEOUT_MS = 600_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A negative delay is clamped to 0 by setTimeout, which would turn the poll
 * loop into a busy loop hammering the API until the deadline. */
function validateWaitArgs(pollInterval: number, timeout: number): void {
  if (pollInterval < 0) {
    throw new SoniloError(`pollInterval must be >= 0, got ${pollInterval}`);
  }
  if (timeout < 0) {
    throw new SoniloError(`timeout must be >= 0, got ${timeout}`);
  }
}

export class Tasks {
  constructor(private readonly client: SoniloClient) {}

  /** Fetch current task state. Never throws on a failed status. */
  async get(taskId: string): Promise<SfxResult> {
    const res = await this.client.request(`/v1/tasks/${encodeURIComponent(taskId)}`);
    return (await res.json()) as SfxResult;
  }

  /** Poll until the task is terminal; throw on failure or deadline. */
  async wait(taskId: string, opts: WaitOptions = {}): Promise<SfxResult> {
    const pollInterval = opts.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = opts.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    validateWaitArgs(pollInterval, timeout);
    const deadline = performance.now() + timeout;
    for (;;) {
      const result = await this.get(taskId);
      if (result.status === "succeeded") return result;
      if (result.status === "failed") {
        const message = result.error?.message || "Generation failed";
        throw new TaskFailedError(`Task ${taskId} failed: ${message}`, {
          code: result.error?.code,
          taskId,
          refunded: result.refunded,
        });
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new TaskTimeoutError(
          `Task ${taskId} still processing after ${timeout}ms; ` +
            "it may finish later — resume with tasks.wait or tasks.get",
          taskId,
        );
      }
      await sleep(Math.min(pollInterval, remaining));
    }
  }
}
