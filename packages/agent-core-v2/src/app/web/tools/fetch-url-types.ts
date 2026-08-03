/**
 * `web` domain — host-injected `UrlFetcher` contract.
 */

import { Error2 } from '#/_base/errors/errors';

import { WebErrors } from '../errors';

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
  readonly content: string;
  readonly kind: UrlFetchKind;
}

export interface UrlFetcher {
  fetch(
    url: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<UrlFetchResult>;
}

export class HttpFetchError extends Error2 {
  override readonly name = 'HttpFetchError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(WebErrors.codes.WEB_FETCH_FAILED, message, { details: { status } });
    this.status = status;
  }
}
