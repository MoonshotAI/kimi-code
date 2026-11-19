
export function buildRestUrl(origin: string, path: string): string {
  return `${origin}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildWsUrl(origin: string): string {
  const url = new URL(`${origin}/api/v1/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
