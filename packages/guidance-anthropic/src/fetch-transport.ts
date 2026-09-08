import type { AnthropicHttpTransport } from './index.js';

/**
 * SERVER-SIDE VENDOR TRANSPORT.
 *
 * Deliberately dumb: it moves bytes and cancels on timeout. It logs nothing —
 * not the URL, not the headers, not the body — because the headers carry the
 * API key and the body carries the request we promised to keep minimal. A
 * transport that logs is the most common way a secret escapes.
 */
export const ANTHROPIC_TRANSPORT_VERSION = 'anthropic-fetch-transport@1.0.0';

export interface ServerFetchLike {
  (input: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

export function createAnthropicFetchTransport(
  fetchImpl: ServerFetchLike,
): AnthropicHttpTransport {
  return {
    async send(request) {
      // Abort on timeout so a slow vendor call cannot continue billing after
      // the appliance has already fallen back.
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
