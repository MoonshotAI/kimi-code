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

export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
