import { SoniloClient } from "sonilo";

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

export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
