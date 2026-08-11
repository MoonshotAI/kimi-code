// app-core api/config — pure URL builders shared by the REST + WS transports.
//
// Origin resolution (window/import.meta.env/storage) and client-identity
// derivation are consumer concerns and live in the consumer app; this module only turns
// an already-resolved origin into REST / WS URLs. The real server serves
// everything (incl. healthz + ws) under the /api/v1 prefix — except the v2
// session-list query, which lives under /api/v2 (pass basePath).

export function buildRestUrl(origin: string, path: string, basePath = '/api/v1'): string {
  return `${origin}${basePath}${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildWsUrl(origin: string, clientId: string): string {
  const url = new URL(`${origin}/api/v1/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);
  return url.toString();
}
