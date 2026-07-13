import type { RunningServer } from '../../src/start';

type HeaderMap = Record<string, string>;

interface FetchOptions {
  readonly method?: string;
  readonly headers?: HeaderMap;
  readonly body?: string;
}

export function bearerToken(server: RunningServer): string {
  return server.authTokenService.getToken();
}

export function authHeaders(server: RunningServer, extra: HeaderMap = {}): HeaderMap {
  return {
    ...extra,
    authorization: `Bearer ${bearerToken(server)}`,
  };
}

export async function authedFetch(
  server: RunningServer,
  base: string,
  path: string,
  init: FetchOptions = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: authHeaders(server, init.headers),
  } as never);
}
