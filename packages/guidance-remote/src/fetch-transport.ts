import type { HttpTransport } from './index.js';

/**
 * REACT-NATIVE-SAFE TRANSPORT.
 *
 * Standard `fetch` and `AbortController` only — both present in the RN runtime.
 * No Node APIs, and no vendor knowledge: this carries MACROS session requests
 * to the MACROS backend and nothing else.
 */
export const FETCH_TRANSPORT_VERSION = 'tablet-fetch-transport@1.0.0';

export interface FetchLike {
  (input: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

/**
 * Build the transport.
 *
 * `fetchImpl` is injected so tests exercise abort behaviour deterministically;
 * production passes the platform `fetch`.
 */
export function createFetchTransport(fetchImpl: FetchLike): HttpTransport {
  return {
    async send(request) {
      /**
       * The timeout must CANCEL the request, not merely stop waiting for it.
       * Returning a fallback after 2.5s while the underlying call runs on is
       * not a boundary — it is a leak, and on the paid path it is a bill.
       */
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, request.timeoutMs);
      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          signal: controller.signal,
        });
        return { status: response.status, body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
