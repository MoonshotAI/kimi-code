/**
 * `OAuthService` (P2.7) unit tests.
 *
 * Hermetic: a mock managed auth facade is injected so we don't need a real
 * OAuth host on the network. The mock's `login()` exposes a deferred device
 * authorization + completion promise so tests can drive each transition
 * independently:
 *
 *   facadeMock.deviceCodeReady(deviceAuth)  → fires onDeviceCode → REST returns
 *   facadeMock.resolveLogin(result)         → flow → 'authenticated'
 *   facadeMock.rejectLogin(err)             → flow → 'denied' / 'expired' / 'cancelled'
 *
 * Coverage:
 *   - startLogin returns flow_id + verification URLs + status='pending'
 *   - getFlow returns the in-memory snapshot
 *   - resolveLogin → status='authenticated'
 *   - rejectLogin(DeviceCodeTimeoutError) → status='expired'
 *   - rejectLogin(OAuthError 'aborted') → status='cancelled'
 *   - rejectLogin(OAuthError 'denied') → status='denied'
 *   - rejectLogin(generic) → status='denied' with error_message preserved
 *   - cancelLogin on pending → status='cancelled', AbortController fired
 *   - cancelLogin on terminal → cancelled=false, status unchanged
 *   - startLogin while another is pending → previous flips to 'cancelled',
 *     new flow gets fresh flow_id
 *   - logout → delegates to facade.logout
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DeviceCodeTimeoutError,
  OAuthError,
  type DeviceAuthorization,
} from '@moonshot-ai/kimi-code-oauth';

import type { ServicesAuthFacade } from '../../src/services/auth/managedAuth';
import { IEnvironmentService } from '../../src/services/environment/environment';
import { OAuthService } from '../../src/services/oauth/oauthService';

interface LoginCall {
  providerName: string | undefined;
  onDeviceCode: ((auth: DeviceAuthorization) => void | Promise<void>) | undefined;
  signal: AbortSignal | undefined;
  resolve: (value: { providerName: string; ok: true }) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

interface MockFacade {
  facade: ServicesAuthFacade;
  loginCalls: LoginCall[];
  logoutCalls: Array<{ providerName: string | undefined }>;
}

function makeMockFacade(): MockFacade {
  const loginCalls: LoginCall[] = [];
  const logoutCalls: Array<{ providerName: string | undefined }> = [];

  const facade = {
    login: vi.fn((providerName: string | undefined, options: {
      onDeviceCode?: (auth: DeviceAuthorization) => void | Promise<void>;
      signal?: AbortSignal;
    }) => {
      let resolveFn!: (v: { providerName: string; ok: true }) => void;
      let rejectFn!: (r: unknown) => void;
      const promise = new Promise<{ providerName: string; ok: true }>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      loginCalls.push({
        providerName,
        onDeviceCode: options.onDeviceCode,
        signal: options.signal,
        resolve: resolveFn,
        reject: rejectFn,
        promise,
      });
      return promise;
    }),
    logout: vi.fn(async (providerName: string | undefined) => {
      logoutCalls.push({ providerName });
      return { providerName: providerName ?? 'managed:kimi-code', ok: true as const };
    }),
  } as unknown as ServicesAuthFacade;

  return { facade, loginCalls, logoutCalls };
}

function fakeDeviceAuth(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return {
    deviceCode: 'dev-code-secret',
    userCode: 'KIMI-1234',
    verificationUri: 'https://example.com/device',
    verificationUriComplete: 'https://example.com/device?user_code=KIMI-1234',
    expiresIn: 900,
    interval: 5,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  // Two ticks is enough to settle the .then / .catch chain inside
  // OAuthService.startLogin.
  await Promise.resolve();
  await Promise.resolve();
}

function makeImpl(): { impl: OAuthService; mock: MockFacade } {
  const mock = makeMockFacade();
  const env: IEnvironmentService = {
    _serviceBrand: undefined,
    homeDir: '/tmp/oauth-test',
    configPath: '/tmp/oauth-test/config.toml',
  };
  const impl = OAuthService._createForTest(env, mock.facade);
  return { impl, mock };
}

describe('OAuthService.startLogin', () => {
  it('returns flow_id + verification URLs once the facade fires onDeviceCode', async () => {
    const { impl, mock } = makeImpl();

    const startPromise = impl.startLogin();
    await flushMicrotasks();
    expect(mock.loginCalls).toHaveLength(1);

    // Fire the device-code callback from the facade side.
    const auth = fakeDeviceAuth();
    await mock.loginCalls[0]!.onDeviceCode?.(auth);

    const start = await startPromise;
    expect(start.status).toBe('pending');
    expect(start.flow_id).toMatch(/^oauth_/);
    expect(start.verification_uri).toBe(auth.verificationUri);
    expect(start.verification_uri_complete).toBe(auth.verificationUriComplete);
    expect(start.user_code).toBe(auth.userCode);
    expect(start.expires_in).toBe(900);
    expect(start.interval).toBe(5);
    expect(start.provider).toBe('managed:kimi-code');
  });

  it('falls back to 15-min expires_in when the OAuth host omits the field', async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(
      fakeDeviceAuth({ expiresIn: null }),
    );
    const start = await startPromise;
    expect(start.expires_in).toBe(15 * 60);
  });
});

describe('OAuthService.getFlow', () => {
  it('returns undefined before any flow is started', () => {
    const { impl } = makeImpl();
    expect(impl.getFlow()).toBeUndefined();
  });

  it('returns the pending snapshot after start', async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    const start = await startPromise;

    const snap = impl.getFlow();
    expect(snap).toBeDefined();
    expect(snap!.flow_id).toBe(start.flow_id);
    expect(snap!.status).toBe('pending');
    expect(snap!.resolved_at).toBeUndefined();
    expect(snap!.error_message).toBeUndefined();
  });

  it("does NOT leak device_code via the snapshot", async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;
    const snap = impl.getFlow();
    expect(JSON.stringify(snap)).not.toContain('dev-code-secret');
  });
});

describe('OAuthService — terminal transitions', () => {
  it("'authenticated' on facade.login resolve", async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;

    mock.loginCalls[0]!.resolve({ providerName: 'managed:kimi-code', ok: true });
    await flushMicrotasks();

    expect(impl.getFlow()!.status).toBe('authenticated');
    expect(impl.getFlow()!.resolved_at).toBeDefined();
  });

  it("'expired' on DeviceCodeTimeoutError", async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;

    mock.loginCalls[0]!.reject(new DeviceCodeTimeoutError('timed out'));
    await flushMicrotasks();

    expect(impl.getFlow()!.status).toBe('expired');
    expect(impl.getFlow()!.error_message).toBe('timed out');
  });

  it("'denied' on OAuthError carrying 'denied'", async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;

    mock.loginCalls[0]!.reject(new OAuthError('Authorization denied'));
    await flushMicrotasks();

    expect(impl.getFlow()!.status).toBe('denied');
  });

  it("'cancelled' on OAuthError carrying 'aborted'", async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;

    mock.loginCalls[0]!.reject(new OAuthError('Login aborted by caller'));
    await flushMicrotasks();

    expect(impl.getFlow()!.status).toBe('cancelled');
  });

  it("'denied' for generic failures, preserving error_message", async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;

    mock.loginCalls[0]!.reject(new Error('ECONNREFUSED'));
    await flushMicrotasks();

    const snap = impl.getFlow()!;
    expect(snap.status).toBe('denied');
    expect(snap.error_message).toBe('ECONNREFUSED');
  });
});

describe('OAuthService.cancelLogin', () => {
  it('cancels a pending flow and fires the AbortController', async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;

    const aborted = new Promise<boolean>((resolve) => {
      mock.loginCalls[0]!.signal!.addEventListener('abort', () => resolve(true));
    });

    const result = await impl.cancelLogin();
    expect(result).toEqual({ cancelled: true, status: 'cancelled' });
    expect(await aborted).toBe(true);
    expect(impl.getFlow()!.status).toBe('cancelled');
  });

  it('idempotently reports the current status on terminal flows', async () => {
    const { impl, mock } = makeImpl();
    const startPromise = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await startPromise;
    mock.loginCalls[0]!.resolve({ providerName: 'managed:kimi-code', ok: true });
    await flushMicrotasks();

    const result = await impl.cancelLogin();
    expect(result).toEqual({ cancelled: false, status: 'authenticated' });
  });

  it('returns cancelled=false when no flow has ever been started', async () => {
    const { impl } = makeImpl();
    const result = await impl.cancelLogin();
    expect(result).toEqual({ cancelled: false, status: 'cancelled' });
  });
});

describe('OAuthService — supersede (PLAN D6.4)', () => {
  it("flips the previous pending flow to 'cancelled' and mints a new flow_id", async () => {
    const { impl, mock } = makeImpl();

    const first = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    const firstStart = await first;

    const second = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[1]!.onDeviceCode?.(
      fakeDeviceAuth({ deviceCode: 'second-secret', userCode: 'KIMI-9999' }),
    );
    const secondStart = await second;

    expect(secondStart.flow_id).not.toBe(firstStart.flow_id);
    expect(impl.getFlow()!.flow_id).toBe(secondStart.flow_id);
    expect(impl.getFlow()!.status).toBe('pending');
    expect(mock.loginCalls[0]!.signal!.aborted).toBe(true);
  });
});

describe('OAuthService.logout', () => {
  it('delegates to facade.logout and returns logged_out=true', async () => {
    const { impl, mock } = makeImpl();
    const result = await impl.logout();
    expect(result).toEqual({ logged_out: true, provider: 'managed:kimi-code' });
    expect(mock.logoutCalls).toHaveLength(1);
  });

  it('also cancels any pending flow', async () => {
    const { impl, mock } = makeImpl();
    const start = impl.startLogin();
    await flushMicrotasks();
    await mock.loginCalls[0]!.onDeviceCode?.(fakeDeviceAuth());
    await start;

    await impl.logout();
    // After logout, the in-memory flow is in 'cancelled' terminal state
    expect(impl.getFlow()!.status).toBe('cancelled');
    expect(mock.loginCalls[0]!.signal!.aborted).toBe(true);
  });
});
