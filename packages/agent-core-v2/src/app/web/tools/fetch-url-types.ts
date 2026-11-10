import { Error2 } from '#/_base/errors/errors';

import { WebErrors } from '../errors';

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
