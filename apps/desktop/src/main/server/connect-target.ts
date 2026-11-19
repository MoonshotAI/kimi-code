
export type ConnectTarget =
  | { external: true; origin: string; token: string | undefined }
  | { external: false };

export function resolveConnectTarget(
  serverUrl: string | undefined,
  readToken: () => string | undefined,
): ConnectTarget {
  if (serverUrl === undefined || serverUrl.trim() === '') {
    return { external: false };
  }
  return { external: true, origin: normalizeServerOrigin(serverUrl), token: readToken() };
}

function normalizeServerOrigin(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
