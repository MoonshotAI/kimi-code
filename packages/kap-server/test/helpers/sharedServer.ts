import { inject } from 'vitest';

export interface SharedServerContext {
  readonly base: string;
  readonly token: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    readonly sharedServer: SharedServerContext;
  }
}

export function sharedServer(): SharedServerContext {
  return inject('sharedServer');
}

export function sharedAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, authorization: `Bearer ${sharedServer().token}` };
}

interface SharedFetchOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export async function sharedAuthedFetch(path: string, init: SharedFetchOptions = {}): Promise<Response> {
  return fetch(`${sharedServer().base}${path}`, {
    ...init,
    headers: sharedAuthHeaders(init.headers),
  } as never);
}
