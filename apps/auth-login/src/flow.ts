// Adapts the shared useOAuthLoginFlow state machine to direct browser-side
// device-flow calls against the OAuth host (the desktop/web apps inject daemon
// callbacks instead). The OAuth host allows cross-origin POSTs, so the page
// talks to it straight from the browser.

import type {
  OAuthLoginFlowCallbacks,
  OAuthLoginStartResult,
} from '@moonshot-ai/app-client/composables';
import {
  KIMI_CODE_FLOW_CONFIG,
  pollDeviceToken,
  requestDeviceAuthorization,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth/device';

const DEVICE_ID_STORAGE_KEY = 'kimi-code-auth-login.device-id';
const APP_VERSION = '0.0.0';
/** Fallback when the OAuth host omits expires_in (it currently sends 1800). */
const DEFAULT_EXPIRES_IN = 1800;
/** Extra delay folded into a poll callback after a `slow_down` response
    (RFC 8628 §3.5 asks for +5s). The shared state machine schedules polls at a
    fixed interval, so the backoff is absorbed here by returning later. */
const SLOW_DOWN_EXTRA_MS = 5000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** crypto.randomUUID is secure-context-only, and this page may well be served
    over plain http (LAN IP, plain-http tunnel) — fall back to getRandomValues
    (available in every context), then Math.random. The id feeds an auxiliary
    header, not a secret, so the weakest fallback is still acceptable. */
function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let memoryDeviceId: string | null = null;

/** Stable per-browser id, the equivalent of the CLI's `<home>/device_id`.
    Falls back to a per-page random id when storage is unavailable (private
    mode, blocked origin) — the header is auxiliary and must not block sign-in. */
function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored) return stored;
    const id = randomId();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    return id;
  } catch {
    memoryDeviceId ??= randomId();
    return memoryDeviceId;
  }
}

/** X-Msh-* identity reported to the OAuth host: the platform value reuses the
    CLI's by decision, and the User-Agent stays the browser's own — it cannot
    be overridden from JS. */
function deviceHeaders(): Record<string, string> {
  return {
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': APP_VERSION,
    'X-Msh-Device-Id': deviceId(),
  };
}

export interface AuthLoginFlowOptions {
  /** Called the instant a poll returns the token — before the state machine's
      success dwell — so the cookie can be persisted even if the user closes
      the tab while the success state is showing. */
  readonly onToken?: (token: TokenInfo) => void;
}

export interface AuthLoginFlow {
  readonly callbacks: OAuthLoginFlowCallbacks;
  /** Token captured by the latest successful poll. */
  readonly authenticatedToken: () => TokenInfo | null;
}

export function createAuthLoginFlow(options?: AuthLoginFlowOptions): AuthLoginFlow {
  let deviceCode: string | null = null;
  let token: TokenInfo | null = null;

  async function onStartOAuthLogin(): Promise<OAuthLoginStartResult | null> {
    let auth;
    try {
      auth = await requestDeviceAuthorization(KIMI_CODE_FLOW_CONFIG, {
        deviceHeaders: deviceHeaders(),
      });
    } catch {
      // Start failure → the state machine shows the error step.
      return null;
    }
    deviceCode = auth.deviceCode;
    token = null;
    const expiresIn = auth.expiresIn ?? DEFAULT_EXPIRES_IN;
    return {
      flowId: auth.deviceCode,
      provider: KIMI_CODE_FLOW_CONFIG.name,
      status: 'pending',
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      userCode: auth.userCode,
      expiresIn,
      interval: auth.interval,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async function onPollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null> {
    if (!deviceCode) return null;
    let result;
    try {
      result = await pollDeviceToken(KIMI_CODE_FLOW_CONFIG, deviceCode, {
        deviceHeaders: deviceHeaders(),
      });
    } catch {
      // Transport/unknown failure reads as a blip; the state machine retries
      // and turns three in a row into the error step.
      return null;
    }
    const flowId = deviceCode;
    const resolvedAt = new Date().toISOString();
    switch (result.kind) {
      case 'success':
        token = result.token;
        options?.onToken?.(result.token);
        return { flowId, status: 'authenticated', resolvedAt };
      case 'pending':
        if (result.errorCode === 'slow_down') await sleep(SLOW_DOWN_EXTRA_MS);
        return { flowId, status: 'pending' };
      case 'expired':
        return { flowId, status: 'expired', resolvedAt };
      case 'denied':
        return { flowId, status: 'cancelled', resolvedAt };
    }
  }

  async function onCancelOAuthLogin(): Promise<void> {
    deviceCode = null;
  }

  return {
    callbacks: { onStartOAuthLogin, onPollOAuthLogin, onCancelOAuthLogin },
    authenticatedToken: () => token,
  };
}
