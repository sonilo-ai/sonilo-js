import { SoniloClient } from "../src/client.js";

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A SoniloClient whose fetch is replaced by `handler`; records every call. */
export function mockClient(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { client: SoniloClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(url, call.init);
  }) as typeof globalThis.fetch;
  const client = new SoniloClient({ apiKey: "sk_test_123", fetch: fetchFn });
  return { client, calls };
}

/** Build an NDJSON streaming Response from event objects. */
export function ndjsonResponse(events: unknown[], chunkSize?: number): Response {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  const size = chunkSize ?? bytes.length;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

export function b64(s: string): string {
  return btoa(s);
}

/**
 * A fetch stub that never resolves on its own, but rejects with the same
 * DOMException `AbortSignal.timeout()` produces when `init.signal` fires.
 * Lets tests exercise real timeout behavior deterministically (paired with a
 * tiny client `timeout`) without ever waiting out a real multi-minute abort.
 */
export function neverResolvingFetch(): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(new DOMException("The signal has timed out", "TimeoutError"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
    });
  }) as typeof globalThis.fetch;
}
