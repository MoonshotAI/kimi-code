
import type {
  OAuthLoginFlowCallbacks,
  OAuthLoginStartResult,
} from '@moonshot-ai/app-client/composables';
import {
  KIMI_CODE_FLOW_CONFIG,
  pollDeviceToken,
  type DeviceAuthorization,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth/device';

const GLOBAL_OAUTH_HOST = 'https://auth.kimi.ai';
const MAINLAND_CN_OAUTH_HOST = 'https://auth.kimi.com';

export function oauthHostForHostname(hostname: string): string {
  return hostname === 'kimi.ai' || hostname.endsWith('.kimi.ai')
    ? GLOBAL_OAUTH_HOST
    : MAINLAND_CN_OAUTH_HOST;
}

function flowConfig(): typeof KIMI_CODE_FLOW_CONFIG {
  return { ...KIMI_CODE_FLOW_CONFIG, oauthHost: oauthHostForHostname(location.hostname) };
}

const DEVICE_ID_STORAGE_KEY = 'kimi-code-auth-login.device-id';
const APP_VERSION = '0.0.0';
const DEFAULT_EXPIRES_IN = 1800;
const SLOW_DOWN_EXTRA_MS = 5000;
const DEVICE_AUTHORIZATION_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

function deviceHeaders(): Record<string, string> {
  return {
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': APP_VERSION,
    'X-Msh-Device-Id': deviceId(),
  };
}

export type AuthStartErrorKind =
  | 'offline'
  | 'connection'
  | 'timeout'
  | 'rate-limited'
  | 'service-unavailable'
  | 'request-rejected'
  | 'invalid-response'
  | 'unknown';

export interface AuthStartError {
  readonly kind: AuthStartErrorKind;
  readonly code: string;
  readonly occurredAt: string;
  readonly oauthHost: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly description?: string;
}

class DeviceAuthorizationRequestError extends Error {
  constructor(readonly diagnostic: AuthStartError, options?: ErrorOptions) {
    super(diagnostic.description ?? diagnostic.code, options);
    this.name = 'DeviceAuthorizationRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function errorDescription(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = errorDescription(item);
      if (message) return message;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ['error_description', 'message', 'detail']) {
    const message = nonEmptyString(value[key]);
    if (message) return message;
  }
  if (typeof value['error'] === 'string') return nonEmptyString(value['error']);
  if (isRecord(value['error'])) {
    for (const key of ['message', 'error_description', 'detail', 'code', 'type']) {
      const message = nonEmptyString(value['error'][key]);
      if (message) return message;
    }
  }
  if (Array.isArray(value['errors'])) return errorDescription(value['errors']);
  return undefined;
}

function startErrorCode(kind: AuthStartErrorKind, status?: number): string {
  if (status !== undefined) return `AUTH_START_HTTP_${status}`;
  const suffix: Record<AuthStartErrorKind, string> = {
    offline: 'OFFLINE',
    connection: 'CONNECTION',
    timeout: 'TIMEOUT',
    'rate-limited': 'RATE_LIMITED',
    'service-unavailable': 'SERVICE_UNAVAILABLE',
    'request-rejected': 'REQUEST_REJECTED',
    'invalid-response': 'INVALID_RESPONSE',
    unknown: 'UNKNOWN',
  };
  return `AUTH_START_${suffix[kind]}`;
}

function createStartError(
  kind: AuthStartErrorKind,
  oauthHost: string,
  options: {
    status?: number;
    requestId?: string;
    description?: string;
  } = {},
): AuthStartError {
  return {
    kind,
    code: startErrorCode(kind, options.status),
    occurredAt: new Date().toISOString(),
    oauthHost: new URL(oauthHost).host,
    status: options.status,
    requestId: options.requestId,
    description: options.description,
  };
}

function isTimeoutError(error: unknown): boolean {
  let current = error;
  while (current instanceof Error) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return true;
    current = current.cause;
  }
  return false;
}

function connectionStartError(error: unknown, oauthHost: string): DeviceAuthorizationRequestError {
  const kind: AuthStartErrorKind = isTimeoutError(error)
    ? 'timeout'
    : typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'offline'
      : 'connection';
  return new DeviceAuthorizationRequestError(
    createStartError(kind, oauthHost, {
      description: error instanceof Error ? error.message : String(error),
    }),
    { cause: error },
  );
}

async function requestDeviceAuthorization(
  config: typeof KIMI_CODE_FLOW_CONFIG,
): Promise<DeviceAuthorization> {
  let response: Response;
  try {
    response = await fetch(`${config.oauthHost.replace(/\/$/, '')}/api/oauth/device_authorization`, {
      method: 'POST',
      headers: {
        ...deviceHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ client_id: config.clientId }).toString(),
      signal: AbortSignal.timeout(DEVICE_AUTHORIZATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw connectionStartError(error, config.oauthHost);
  }

  let data: unknown = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  const requestId = response.headers.get('x-request-id')
    ?? (isRecord(data) ? nonEmptyString(data['request_id']) : undefined);
  const description = errorDescription(data);

  if (response.status !== 200) {
    const kind: AuthStartErrorKind = response.status === 429
      ? 'rate-limited'
      : response.status >= 500
        ? 'service-unavailable'
        : response.status >= 400
          ? 'request-rejected'
          : 'unknown';
    throw new DeviceAuthorizationRequestError(createStartError(kind, config.oauthHost, {
      status: response.status,
      requestId,
      description: description ?? `Device authorization failed (HTTP ${response.status})`,
    }));
  }

  const invalidResponse = (): DeviceAuthorizationRequestError => new DeviceAuthorizationRequestError(
    createStartError('invalid-response', config.oauthHost, {
      requestId,
      description: 'Device authorization response is missing required fields',
    }),
  );
  if (!isRecord(data)) throw invalidResponse();

  const userCode = data['user_code'];
  const deviceCode = data['device_code'];
  const verificationUriComplete = data['verification_uri_complete'];
  if (
    typeof userCode !== 'string' || userCode.length === 0
    || typeof deviceCode !== 'string' || deviceCode.length === 0
    || typeof verificationUriComplete !== 'string' || verificationUriComplete.length === 0
  ) {
    throw invalidResponse();
  }

  return {
    userCode,
    deviceCode,
    verificationUri: typeof data['verification_uri'] === 'string' ? data['verification_uri'] : '',
    verificationUriComplete,
    expiresIn: data['expires_in'] !== undefined ? Number(data['expires_in']) : null,
    interval: Number(data['interval'] ?? 5),
  };
}

export interface AuthLoginFlowOptions {
  readonly onToken?: (token: TokenInfo) => void;
}

export interface AuthLoginFlow {
  readonly callbacks: OAuthLoginFlowCallbacks;
  readonly authenticatedToken: () => TokenInfo | null;
  readonly startError: () => AuthStartError | null;
}

export function createAuthLoginFlow(options?: AuthLoginFlowOptions): AuthLoginFlow {
  let deviceCode: string | null = null;
  let token: TokenInfo | null = null;
  let startError: AuthStartError | null = null;

  async function onStartOAuthLogin(): Promise<OAuthLoginStartResult | null> {
    startError = null;
    let auth;
    try {
      auth = await requestDeviceAuthorization(flowConfig());
    } catch (error) {
      startError = error instanceof DeviceAuthorizationRequestError
        ? error.diagnostic
        : createStartError('unknown', flowConfig().oauthHost, {
            description: error instanceof Error ? error.message : String(error),
          });
      console.error('Remote Control device authorization failed', error);
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
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null> {
    if (!deviceCode) return null;
    let result;
    try {
      result = await pollDeviceToken(flowConfig(), deviceCode, {
        deviceHeaders: deviceHeaders(),
      });
    } catch {
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
        return { flowId, status: 'denied', resolvedAt };
    }
  }

  async function onCancelOAuthLogin(): Promise<void> {
    deviceCode = null;
  }

  return {
    callbacks: { onStartOAuthLogin, onPollOAuthLogin, onCancelOAuthLogin },
    authenticatedToken: () => token,
    startError: () => startError,
  };
}
