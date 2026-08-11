// apps/web src/api/config.ts — reads Vite env + window, resolves the server
// origin, and derives the stable client identity for the DaemonKimiWebApi.
//
// Pure URL builders (buildRestUrl / buildWsUrl) live in @moonshot-ai/app-core;
// this module keeps only the consumer-runtime concerns (window / import.meta.env
// / storage) that the package deliberately does not own.

import { safeGetString, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

const CLIENT_ID_KEY = STORAGE_KEYS.clientId;
const WEB_CLIENT_NAME = 'kimi-code-web';
const WEB_CLIENT_UI_MODE = 'web';

export interface KimiApiConfig {
  serverHttpUrl: string;
  clientId: string;
  clientName: string;
  clientVersion: string;
  clientUiMode: string;
}

export function readKimiApiConfig(): KimiApiConfig {
  return {
    serverHttpUrl: resolveServerOrigin(),
    clientId: getClientId(),
    clientName: WEB_CLIENT_NAME,
    clientVersion: readClientVersion(),
    clientUiMode: WEB_CLIENT_UI_MODE,
  };
}

// Default to SAME-ORIGIN so we never depend on CORS:
//  - dev: the SPA is served by Vite; the Vite dev proxy forwards /v1, /healthz
//    and /v1/ws to the server (see vite.config.ts), so the browser only ever
//    talks to its own origin.
//  - prod: `kimi web` serves this built SPA from the server itself, so the
//    server's origin already is the API origin.
// Set VITE_KIMI_SERVER_HTTP_URL to connect directly to an absolute server
// origin instead (that path does require the server to send CORS headers).
function defaultServerOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:58627';
}

/**
 * Resolve the server origin, with the desktop app taking precedence: when the
 * desktop loads the renderer via `app://renderer/index.html?kimi_origin=<enc>`,
 * that injected origin is the in-process server the renderer must talk to
 * (cross-origin from `app://`, so CORS/WS behaviour is verified in Task 2.5).
 * Falls back to the explicit env, then same-origin, then the loopback default.
 *
 * `URLSearchParams.get` already percent-decodes the value, so pass it straight
 * to `normalizeServerOrigin` — do NOT `decodeURIComponent` again (double-decode).
 */
function resolveServerOrigin(): string {
  const injected = injectedServerOrigin();
  if (injected) {
    return normalizeServerOrigin(injected);
  }
  return normalizeServerOrigin(import.meta.env.VITE_KIMI_SERVER_HTTP_URL);
}

// The SPA router drops the launch query string after boot, so `kimi_origin`
// would vanish from window.location on any full page reload (HMR-triggered or
// manual) — the renderer then falls back to same-origin, which for the desktop
// is the static app://renderer / Vite dev origin, not the API server, and the
// app stalls on the connecting splash. Persist the injected origin in
// sessionStorage (same pattern as lib/desktopFlag.ts); the main process
// re-injects it via the URL on every fresh launch, overwriting the stored copy.
const INJECTED_ORIGIN_KEY = 'kimi-desktop-server-origin';

function injectedServerOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const fromQuery = new URLSearchParams(window.location.search).get('kimi_origin');
  try {
    if (fromQuery) {
      window.sessionStorage.setItem(INJECTED_ORIGIN_KEY, fromQuery);
      return fromQuery;
    }
    return window.sessionStorage.getItem(INJECTED_ORIGIN_KEY) ?? undefined;
  } catch {
    // sessionStorage unavailable (stubbed window in tests, private mode) —
    // the live query value still works for this boot.
    return fromQuery ?? undefined;
  }
}

export function normalizeServerOrigin(value: string | undefined): string {
  const raw = value && value.trim() ? value : defaultServerOrigin();
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/** Strip the scheme for a compact display origin: `http://127.0.0.1:58627` → `127.0.0.1:58627`. */
function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Address of the REAL server the client is connected to, shown in the status bar.
 * Always the actual server — never the dev-proxy URL — since that's the thing
 * worth knowing at a glance. Cases:
 *  - VITE_KIMI_SERVER_HTTP_URL set → that absolute server origin (direct mode).
 *  - dev (same-origin proxy) → the proxy's upstream target (the real server).
 *  - prod (server serves the SPA) → the page origin (it IS the server).
 */
export function serverEndpointLabel(): string {
  const direct = import.meta.env.VITE_KIMI_SERVER_HTTP_URL;
  if (direct && direct.trim()) return shortOrigin(normalizeServerOrigin(direct));

  const proxy =
    typeof __KIMI_DEV_PROXY_TARGET__ !== 'undefined' ? __KIMI_DEV_PROXY_TARGET__ : '';
  if (import.meta.env.DEV && proxy) return shortOrigin(proxy);

  if (typeof window !== 'undefined') {
    const injected = injectedServerOrigin();
    if (injected) return shortOrigin(normalizeServerOrigin(injected));
  }
  const origin =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return shortOrigin(origin);
}

function getClientId(): string {
  const stored = safeGetString(CLIENT_ID_KEY);
  if (stored) return stored;
  const generated = `web_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  safeSetString(CLIENT_ID_KEY, generated);
  return generated;
}

function readClientVersion(): string {
  return typeof __KIMI_CLIENT_VERSION__ === 'string' && __KIMI_CLIENT_VERSION__.trim()
    ? __KIMI_CLIENT_VERSION__
    : '0.0.0-dev';
}
