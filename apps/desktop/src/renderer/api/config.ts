
import { safeGetString, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { DESKTOP_PRODUCT_NAME, DESKTOP_UI_MODE } from '../../shared/identity';

const CLIENT_ID_KEY = STORAGE_KEYS.clientId;
const WEB_CLIENT_NAME = 'kimi-code-web';
const WEB_CLIENT_UI_MODE = 'web';

const desktopVariant = typeof __KIMI_CODE_DESKTOP__ !== 'undefined' && __KIMI_CODE_DESKTOP__;

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
    clientName: desktopVariant ? DESKTOP_PRODUCT_NAME : WEB_CLIENT_NAME,
    clientVersion: readClientVersion(),
    clientUiMode: desktopVariant ? DESKTOP_UI_MODE : WEB_CLIENT_UI_MODE,
  };
}

function defaultServerOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:58627';
}

function resolveServerOrigin(): string {
  const injected = injectedServerOrigin();
  if (injected) {
    return normalizeServerOrigin(injected);
  }
  return normalizeServerOrigin(import.meta.env.VITE_KIMI_SERVER_HTTP_URL);
}

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

function shortOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

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
