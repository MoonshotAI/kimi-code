// apps/kimi-web/src/api/config.ts
// Reads Vite env, builds REST/WS URLs, manages stable clientId.

const CLIENT_ID_KEY = 'kimi-web.client-id';

export interface KimiApiConfig {
  daemonHttpUrl: string;
  clientId: string;
}

export function readKimiApiConfig(): KimiApiConfig {
  return {
    daemonHttpUrl: normalizeDaemonOrigin(import.meta.env.VITE_KIMI_DAEMON_HTTP_URL),
    clientId: getClientId(),
  };
}

// Default to SAME-ORIGIN so we never depend on CORS:
//  - dev: the SPA is served by Vite; the Vite dev proxy forwards /v1, /healthz
//    and /v1/ws to the daemon (see vite.config.ts), so the browser only ever
//    talks to its own origin.
//  - prod: `kimi web` serves this built SPA from the daemon itself, so the
//    daemon's origin already is the API origin.
// Set VITE_KIMI_DAEMON_HTTP_URL to connect directly to an absolute daemon
// origin instead (that path does require the daemon to send CORS headers).
function defaultDaemonOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:7878';
}

export function normalizeDaemonOrigin(value: string | undefined): string {
  const raw = value && value.trim() ? value : defaultDaemonOrigin();
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** Strip the scheme for a compact display origin: `http://127.0.0.1:7878` → `127.0.0.1:7878`. */
function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Address of the REAL daemon the client is connected to, shown in the status bar.
 * Always the actual daemon — never the dev-proxy URL — since that's the thing
 * worth knowing at a glance. Cases:
 *  - VITE_KIMI_DAEMON_HTTP_URL set → that absolute daemon origin (direct mode).
 *  - dev (same-origin proxy) → the proxy's upstream target (the real daemon).
 *  - prod (daemon serves the SPA) → the page origin (it IS the daemon).
 */
export function daemonEndpointLabel(): string {
  const direct = import.meta.env.VITE_KIMI_DAEMON_HTTP_URL;
  if (direct && direct.trim()) return shortOrigin(normalizeDaemonOrigin(direct));

  const proxy =
    typeof __KIMI_DEV_PROXY_TARGET__ !== 'undefined' ? __KIMI_DEV_PROXY_TARGET__ : '';
  if (import.meta.env.DEV && proxy) return shortOrigin(proxy);

  const origin =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return shortOrigin(origin);
}

// The real daemon serves everything (incl. healthz + ws) under the /api/v1 prefix.
export function buildRestUrl(origin: string, path: string): string {
  return `${origin}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildWsUrl(origin: string, clientId: string): string {
  const url = new URL(`${origin}/api/v1/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);
  return url.toString();
}

function getClientId(): string {
  const stored = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const generated = `web_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  globalThis.localStorage?.setItem(CLIENT_ID_KEY, generated);
  return generated;
}
