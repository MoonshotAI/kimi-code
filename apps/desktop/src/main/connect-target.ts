// Pure resolution of where the renderer should connect: an external server
// from KIMI_SERVER_URL, or the embedded server started by the main process.
// No electron / kap-server / fs imports so vitest can load this directly.

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

// Same normalization as the web app's `normalizeServerOrigin`
// (apps/web/src/api/config.ts), duplicated so the desktop main process does
// not import from the web app.
function normalizeServerOrigin(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
