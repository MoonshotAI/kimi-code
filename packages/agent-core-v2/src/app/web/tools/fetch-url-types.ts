/**
 * `web` domain (L4) — host-injected `UrlFetcher` contract.
 */

/**
 * How the returned content relates to the original response body.
 *
 * - `passthrough` — the body was already plain text / markdown and is
 *   returned verbatim, in full.
 * - `extracted` — the body was an HTML page; only the main article text
 *   was extracted and returned.
 */
export type UrlFetchKind = 'passthrough' | 'extracted';

export interface UrlFetchResult {
  /** The text handed to the LLM. */
  readonly content: string;
  /** Whether `content` is a verbatim passthrough or extracted main text. */
  readonly kind: UrlFetchKind;
}

export interface UrlFetcher {
  fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult>;
}

/**
 * Thrown by a `UrlFetcher` when the upstream HTTP request completed but
 * returned a non-success status. The tool branches on this to surface
 * `Status: N` in the error message; non-HTTP failures (DNS, timeout,
 * connection reset, …) keep flowing through as plain `Error`.
 */
export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
