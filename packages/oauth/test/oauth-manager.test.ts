import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DeviceCodeTimeoutError,
  OAuthAccessDeniedError,
  OAuthUnauthorizedError,
  OAuthWorkspaceSwitchError,
} from '../src/errors';
import type { DevicePollResult } from '../src/oauth';
import { OAuthManager } from '../src/oauth-manager';
import { FileTokenStorage } from '../src/storage';
import type { TokenStorage } from '../src/storage';
import type { DeviceAuthorization, OAuthFlowConfig, TokenInfo } from '../src/types';

class InMemoryStorage implements TokenStorage {
  public store = new Map<string, TokenInfo>();

  async load(name: string): Promise<TokenInfo | undefined> {
    return this.store.get(name);
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    this.store.set(name, token);
  }

  async remove(name: string): Promise<void> {
    this.store.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

const config: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost: 'https://test',
  clientId: 'test',
};

function makeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: 2_000_000_000,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

let currentNow = 1_000_000_000;
function now(): number {
  return currentNow;
}

beforeEach(() => {
  currentNow = 1_000_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuthManager.ensureFresh', () => {
  it('returns stored access_token when not close to expiry', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    const refreshImpl = vi.fn();
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
    });
    const access = await mgr.ensureFresh();
    expect(access).toBe('at-1');
    expect(refreshImpl).not.toHaveBeenCalled();
  });

  it('refreshes when within dynamic threshold', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 200 }));
    const refreshed = makeToken({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: currentNow + 3600,
    });
    const refreshImpl = vi.fn().mockResolvedValue(refreshed);
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const access = await mgr.ensureFresh();
    expect(refreshImpl).toHaveBeenCalledWith(config, 'rt-1');
    expect(access).toBe('at-new');
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-new');
  });

  it('force=true always refreshes', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    const refreshImpl = vi.fn().mockResolvedValue(makeToken({ accessToken: 'forced' }));
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const access = await mgr.ensureFresh({ force: true });
    expect(refreshImpl).toHaveBeenCalled();
    expect(access).toBe('forced');
  });

  it('force=true refreshes an unchanged freshly-issued token', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-fresh',
        refreshToken: 'rt-fresh',
        expiresAt: currentNow + 3600,
        expiresIn: 3600,
      }),
    );
    const refreshImpl = vi.fn().mockResolvedValue(
      makeToken({
        accessToken: 'forced-fresh',
        refreshToken: 'rt-forced',
        expiresAt: currentNow + 7200,
      }),
    );
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const access = await mgr.ensureFresh({ force: true });
    expect(refreshImpl).toHaveBeenCalledTimes(1);
    expect(access).toBe('forced-fresh');
  });

  it('force=true reuses a token changed by another process while waiting for the lock', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: currentNow + 100,
      }),
    );
    const refreshImpl = vi.fn();
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    const originalLoad = storage.load.bind(storage);
    let callCount = 0;
    storage.load = async (name: string) => {
      callCount += 1;
      if (callCount === 2) {
        await storage.save(
          'kimi-code',
          makeToken({
            accessToken: 'at-peer',
            refreshToken: 'rt-peer',
            expiresAt: currentNow + 3600,
          }),
        );
      }
      return originalLoad(name);
    };

    const access = await mgr.ensureFresh({ force: true });
    expect(access).toBe('at-peer');
    expect(refreshImpl).not.toHaveBeenCalled();
  });

  it('concurrent ensureFresh calls share a single refresh', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 200 }));
    let refreshCount = 0;
    const refreshImpl = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      return makeToken({ accessToken: `at-${refreshCount}` });
    });
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    const [a, b, c] = await Promise.all([mgr.ensureFresh(), mgr.ensureFresh(), mgr.ensureFresh()]);
    expect(refreshCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not let a force=true caller piggyback a non-force in-flight refresh', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    let refreshCount = 0;
    const refreshImpl = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      return makeToken({ accessToken: `forced-${refreshCount}`, refreshToken: 'rt-new' });
    });
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    const nonForce = mgr.ensureFresh();
    const forced = mgr.ensureFresh({ force: true });
    const [nonForceResult, forcedResult] = await Promise.all([nonForce, forced]);

    expect(refreshCount).toBe(1);
    expect(nonForceResult).toBe('at-1');
    expect(forcedResult).toBe('forced-1');
  });

  it('lets a non-force caller piggyback a force=true in-flight refresh', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    let refreshCount = 0;
    const refreshImpl = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      return makeToken({ accessToken: `forced-${refreshCount}` });
    });
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    const forced = mgr.ensureFresh({ force: true });
    const nonForce = mgr.ensureFresh();
    const [forcedResult, nonForceResult] = await Promise.all([forced, nonForce]);

    expect(refreshCount).toBe(1);
    expect(forcedResult).toBe('forced-1');
    expect(nonForceResult).toBe(forcedResult);
  });

  it('coalesces concurrent force=true callers onto a single refresh', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    let refreshCount = 0;
    const refreshImpl = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      return makeToken({ accessToken: `forced-${refreshCount}` });
    });
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    const [a, b, c] = await Promise.all([
      mgr.ensureFresh({ force: true }),
      mgr.ensureFresh({ force: true }),
      mgr.ensureFresh({ force: true }),
    ]);

    expect(refreshCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('coalesces multiple queued force callers behind a single non-force in-flight refresh', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    let refreshCount = 0;
    const refreshImpl = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      return makeToken({ accessToken: `forced-${refreshCount}` });
    });
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    const nonForce = mgr.ensureFresh();
    const force1 = mgr.ensureFresh({ force: true });
    const force2 = mgr.ensureFresh({ force: true });
    const [nonForceResult, force1Result, force2Result] = await Promise.all([
      nonForce,
      force1,
      force2,
    ]);

    expect(refreshCount).toBe(1);
    expect(nonForceResult).toBe('at-1');
    expect(force1Result).toBe('forced-1');
    expect(force2Result).toBe(force1Result);
  });

  it('starts a fresh forced refresh after the non-force in-flight call fails', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 200 }));
    const refreshImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockResolvedValueOnce(makeToken({ accessToken: 'forced-recovery' }));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: async () => {},
    });

    const nonForcePromise = mgr.ensureFresh().catch((error: unknown) => error);
    const forcedPromise = mgr.ensureFresh({ force: true });
    const [nonForceOutcome, forcedResult] = await Promise.all([nonForcePromise, forcedPromise]);

    expect((nonForceOutcome as Error).message).toMatch(/network unreachable/);
    expect(forcedResult).toBe('forced-recovery');
    expect(refreshImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when no stored token (caller should drive /login)', async () => {
    const storage = new InMemoryStorage();
    const mgr = new OAuthManager({ config, storage, now });
    await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    await expect(mgr.ensureFresh()).rejects.toThrow(/no token/i);
  });

  it('tombstones the stored token on OAuthUnauthorizedError (refresh_token rejected)', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-retained',
        refreshToken: 'rt-retained',
        expiresAt: currentNow + 100,
      }),
    );
    const refreshImpl = vi.fn().mockRejectedValue(new OAuthUnauthorizedError('invalid_grant'));
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });
    await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    const retained = await storage.load('kimi-code');
    expect(retained).toBeDefined();
    expect(retained?.accessToken).toBe('');
    expect(retained?.refreshToken).toBe('');
  });

  it('does NOT delete file if 401 happens after another process rotated (M5)', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: currentNow + 100,
      }),
    );
    let refreshAttempts = 0;
    const refreshImpl = vi.fn().mockImplementation(async (_cfg, rt: string) => {
      refreshAttempts += 1;
      if (rt === 'rt-old') {
        await storage.save(
          'kimi-code',
          makeToken({
            accessToken: 'at-rotated',
            refreshToken: 'rt-rotated',
            expiresAt: currentNow + 7200,
          }),
        );
        throw new OAuthUnauthorizedError('rt-old already rotated');
      }
      return makeToken({ accessToken: 'should-not-reach' });
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: async () => {},
    });
    const access = await mgr.ensureFresh();
    expect(access).toBe('at-rotated');
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-rotated');
    expect(refreshAttempts).toBe(1);
  });

  it('force=true surfaces OAuthUnauthorizedError to the caller', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({ expiresAt: currentNow + 7200, refreshToken: 'rt-revoked' }),
    );
    const refreshImpl = vi
      .fn()
      .mockRejectedValue(new OAuthUnauthorizedError('refresh_token revoked'));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: () => Promise.resolve(),
    });

    await expect(mgr.ensureFresh({ force: true })).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    const retained = await storage.load('kimi-code');
    expect(retained).toBeDefined();
    expect(retained?.accessToken).toBe('');
    expect(retained?.refreshToken).toBe('');
  });

  it('force=true surfaces network errors without swallowing', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken({ expiresAt: currentNow + 7200 }));
    const refreshImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET: network unreachable'));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: () => Promise.resolve(),
    });

    await expect(mgr.ensureFresh({ force: true })).rejects.toThrow(/ECONNRESET/);
    expect(await storage.load('kimi-code')).toBeDefined();
  });

  it('uses fresh stored token when another process already rotated', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: currentNow + 100,
      }),
    );
    const refreshImpl = vi.fn();
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    const originalLoad = storage.load.bind(storage);
    let callCount = 0;
    storage.load = async (name: string) => {
      callCount += 1;
      if (callCount === 2) {
        await storage.save(
          'kimi-code',
          makeToken({
            accessToken: 'at-rotated',
            refreshToken: 'rt-rotated',
            expiresAt: currentNow + 3600,
          }),
        );
      }
      return originalLoad(name);
    };

    const access = await mgr.ensureFresh();
    expect(access).toBe('at-rotated');
    expect(refreshImpl).not.toHaveBeenCalled();
  });
});

describe('OAuthManager.ensureFresh — rejected refresh token retention', () => {
  it('suppresses a rejected refresh_token until the on-disk token rotates', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-stale',
        refreshToken: 'rt-rejected-until-rotate',
        expiresAt: currentNow + 100,
      }),
    );
    const refreshImpl = vi.fn().mockRejectedValue(new OAuthUnauthorizedError('invalid_grant'));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: async () => {},
    });

    await expect(mgr.ensureFresh({ force: true })).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    const persistedAfter401 = await storage.load('kimi-code');
    expect(persistedAfter401).toBeDefined();
    expect(persistedAfter401?.accessToken).toBe('');
    expect(persistedAfter401?.refreshToken).toBe('');
    expect(await mgr.hasToken()).toBe(false);
    expect(await mgr.getCachedAccessToken()).toBeUndefined();

    currentNow += 10_000;
    await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    expect(refreshImpl).toHaveBeenCalledTimes(1);

    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-rotated',
        refreshToken: 'rt-rotated',
        expiresAt: currentNow + 7200,
      }),
    );

    await expect(mgr.hasToken()).resolves.toBe(true);
    await expect(mgr.getCachedAccessToken()).resolves.toBe('at-rotated');
    await expect(mgr.ensureFresh()).resolves.toBe('at-rotated');
    expect(refreshImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the stored access_token when expires_at is 0 (unknown expiry)', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-zero-expiry',
        refreshToken: 'rt-zero-expiry',
        expiresAt: 0,
      }),
    );
    const refreshImpl = vi
      .fn()
      .mockResolvedValue(makeToken({ accessToken: 'at-should-not-refresh' }));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: async () => {},
    });

    await expect(mgr.ensureFresh()).resolves.toBe('at-zero-expiry');
    expect(refreshImpl).not.toHaveBeenCalled();
  });

  it('tombstones the on-disk token after 401 so a fresh process sees logged-out', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-stale',
        refreshToken: 'rt-rejected',
        expiresAt: currentNow + 100,
      }),
    );
    const refreshImpl = vi.fn().mockRejectedValue(new OAuthUnauthorizedError('invalid_grant'));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      sleep: async () => {},
    });

    await expect(mgr.ensureFresh({ force: true })).rejects.toBeInstanceOf(OAuthUnauthorizedError);

    const persistedAfter401 = await storage.load('kimi-code');
    expect(persistedAfter401).toBeDefined();
    expect(persistedAfter401?.accessToken).toBe('');
    expect(persistedAfter401?.refreshToken).toBe('');
  });
});

describe('OAuthManager.login', () => {
  function okAuth(): DeviceAuthorization {
    return {
      userCode: 'WDJB-MJHT',
      deviceCode: 'dev123',
      verificationUri: 'https://auth/verify',
      verificationUriComplete: 'https://auth/verify?user_code=WDJB-MJHT',
      expiresIn: 600,
      interval: 5,
    };
  }

  it('drives device flow to success and persists token', async () => {
    const storage = new InMemoryStorage();
    const requestImpl = vi.fn().mockResolvedValue(okAuth());
    const pollResponses: DevicePollResult[] = [
      { kind: 'pending', errorCode: 'authorization_pending', description: '' },
      { kind: 'pending', errorCode: 'authorization_pending', description: '' },
      { kind: 'success', token: makeToken({ accessToken: 'at-login' }) },
    ];
    const pollImpl = vi.fn().mockImplementation(async () => pollResponses.shift()!);

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: requestImpl,
      pollDeviceImpl: pollImpl,
      sleep: async () => {},
    });

    const onDeviceCode = vi.fn();
    const result = await mgr.login({ onDeviceCode });
    expect(result.accessToken).toBe('at-login');
    expect(await storage.load('kimi-code')).toBeDefined();
    expect(onDeviceCode).toHaveBeenCalledTimes(1);
  });

  it('awaits async onDeviceCode before polling', async () => {
    const storage = new InMemoryStorage();
    let deviceCodeDelivered = false;
    const pollImpl = vi.fn().mockImplementation(async (): Promise<DevicePollResult> => {
      expect(deviceCodeDelivered).toBe(true);
      return { kind: 'success', token: makeToken({ accessToken: 'at-login' }) };
    });

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: vi.fn().mockResolvedValue(okAuth()),
      pollDeviceImpl: pollImpl,
      sleep: async () => {},
    });

    await mgr.login({
      onDeviceCode: async () => {
        await Promise.resolve();
        deviceCodeDelivered = true;
      },
    });

    expect(pollImpl).toHaveBeenCalledTimes(1);
  });

  it('throws DeviceCodeTimeoutError when local 15-min budget exceeds', async () => {
    const storage = new InMemoryStorage();
    const requestImpl = vi.fn().mockResolvedValue(okAuth());
    const pollImpl = vi.fn().mockResolvedValue({
      kind: 'pending' as const,
      errorCode: 'authorization_pending',
      description: '',
    });
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      currentNow += Math.ceil(ms / 1000);
    });

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: requestImpl,
      pollDeviceImpl: pollImpl,
      sleep,
      deviceCodeTimeoutMs: 10_000,
    });

    await expect(mgr.login()).rejects.toBeInstanceOf(DeviceCodeTimeoutError);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('throws on denied', async () => {
    const storage = new InMemoryStorage();
    const pollImpl = vi.fn().mockResolvedValue({
      kind: 'denied' as const,
      description: 'user rejected',
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: vi.fn().mockResolvedValue(okAuth()),
      pollDeviceImpl: pollImpl,
      sleep: async () => {},
    });
    await expect(mgr.login()).rejects.toBeInstanceOf(OAuthAccessDeniedError);
    await expect(mgr.login()).rejects.toThrow(/denied|reject/i);
  });

  it('restarts device flow when server reports expired_token', async () => {
    const storage = new InMemoryStorage();
    const requestImpl = vi.fn().mockResolvedValue(okAuth());
    const pollResponses: DevicePollResult[] = [
      { kind: 'expired' },
      { kind: 'success', token: makeToken() },
    ];
    const pollImpl = vi.fn().mockImplementation(async () => pollResponses.shift()!);
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: requestImpl,
      pollDeviceImpl: pollImpl,
      sleep: async () => {},
    });
    const token = await mgr.login();
    expect(token.accessToken).toBe('at-1');
    expect(requestImpl).toHaveBeenCalledTimes(2);
  });

  it('respects AbortSignal during polling', async () => {
    const storage = new InMemoryStorage();
    const pollImpl = vi.fn().mockResolvedValue({
      kind: 'pending' as const,
      errorCode: 'authorization_pending',
      description: '',
    });
    const ac = new AbortController();
    const sleep = vi.fn().mockImplementation(async () => {
      ac.abort();
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: vi.fn().mockResolvedValue({
        userCode: 'U',
        deviceCode: 'D',
        verificationUri: '',
        verificationUriComplete: 'https://x',
        expiresIn: 600,
        interval: 1,
      }),
      pollDeviceImpl: pollImpl,
      sleep,
    });
    await expect(mgr.login({ signal: ac.signal })).rejects.toThrow(/abort/i);
  });
});

describe('OAuthManager.logout and hasToken', () => {
  it('logout removes stored token', async () => {
    const storage = new InMemoryStorage();
    await storage.save('kimi-code', makeToken());
    const mgr = new OAuthManager({ config, storage, now });
    await mgr.logout();
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('hasToken returns true when stored, false otherwise', async () => {
    const storage = new InMemoryStorage();
    const mgr = new OAuthManager({ config, storage, now });
    expect(await mgr.hasToken()).toBe(false);
    await storage.save('kimi-code', makeToken());
    expect(await mgr.hasToken()).toBe(true);
  });

  it('treats an empty stored access_token as missing', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({ accessToken: '', refreshToken: 'rt-empty-access-token' }),
    );
    const mgr = new OAuthManager({ config, storage, now });
    expect(await mgr.getCachedAccessToken()).toBeUndefined();
    expect(await mgr.hasToken()).toBe(false);
  });
});

describe('OAuthManager.login — slow_down handling', () => {
  it('increases polling interval by 5s on slow_down (RFC 8628 §3.5)', async () => {
    const storage = new InMemoryStorage();
    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };
    let n = 0;
    const pollImpl = async (): Promise<DevicePollResult> => {
      n += 1;
      if (n === 1) return { kind: 'pending', errorCode: 'authorization_pending', description: '' };
      if (n === 2) return { kind: 'pending', errorCode: 'slow_down', description: '' };
      if (n === 3) return { kind: 'pending', errorCode: 'slow_down', description: '' };
      return { kind: 'success', token: makeToken() };
    };
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: async () => ({
        userCode: 'U',
        deviceCode: 'D',
        verificationUri: '',
        verificationUriComplete: 'https://x',
        expiresIn: 600,
        interval: 5,
      }),
      pollDeviceImpl: pollImpl,
      sleep,
    });
    await mgr.login();
    expect(sleepCalls).toEqual([5000, 10_000, 15_000]);
  });
});

describe('OAuthManager + FileTokenStorage integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kimi-oauth-mgr-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('login persists token to disk; ensureFresh reads it back', async () => {
    const storage = new FileTokenStorage(dir);
    const refreshImpl = vi.fn().mockResolvedValue(makeToken({ accessToken: 'refreshed' }));
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      requestDeviceImpl: async () => ({
        userCode: 'U',
        deviceCode: 'D',
        verificationUri: '',
        verificationUriComplete: 'https://x',
        expiresIn: 600,
        interval: 5,
      }),
      pollDeviceImpl: async (): Promise<DevicePollResult> => ({
        kind: 'success',
        token: makeToken({ accessToken: 'fresh-from-login', expiresAt: currentNow + 7200 }),
      }),
      sleep: async () => {},
      refreshTokenImpl: refreshImpl,
    });
    const token = await mgr.login();
    expect(token.accessToken).toBe('fresh-from-login');

    const mgr2 = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
    });
    const access = await mgr2.ensureFresh();
    expect(access).toBe('fresh-from-login');
    expect(refreshImpl).not.toHaveBeenCalled();
  });

  it('logout removes token file', async () => {
    const storage = new FileTokenStorage(dir);
    await storage.save('kimi-code', makeToken());
    const mgr = new OAuthManager({ config, storage, now });
    expect(await mgr.hasToken()).toBe(true);
    await mgr.logout();
    expect(await mgr.hasToken()).toBe(false);
    expect(await storage.load('kimi-code')).toBeUndefined();
  });

  it('ensureFresh refreshes and persists to disk', async () => {
    const storage = new FileTokenStorage(dir);
    await storage.save(
      'kimi-code',
      makeToken({ refreshToken: 'rt-original', expiresAt: currentNow + 100 }),
    );
    const refreshImpl = vi.fn().mockResolvedValue(
      makeToken({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: currentNow + 7200,
      }),
    );
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
    });
    await mgr.ensureFresh();
    const persisted = await storage.load('kimi-code');
    expect(persisted?.accessToken).toBe('rotated-access');
    expect(persisted?.refreshToken).toBe('rotated-refresh');
  });
});

describe('OAuthManager.switchWorkspace', () => {
  it('waits for an in-flight refresh, uses the newly rotated refresh token, and blocks subsequent ensureFresh until committed', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({ accessToken: 'at-initial', refreshToken: 'rt-initial', expiresAt: currentNow + 100 }),
    );

    let resolveRefresh!: (token: TokenInfo) => void;
    const refreshImpl = vi.fn(
      () =>
        new Promise<TokenInfo>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    let resolveSwitch!: (token: TokenInfo) => void;
    const switchImpl = vi.fn(
      () =>
        new Promise<TokenInfo>((resolve) => {
          resolveSwitch = resolve;
        }),
    );

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      refreshTokenImpl: refreshImpl,
      switchWorkspaceImpl: switchImpl,
    });

    const pRefresh = mgr.ensureFresh();
    await vi.waitFor(() => {
      expect(refreshImpl).toHaveBeenCalledTimes(1);
    });
    const pSwitch = mgr.switchWorkspace({ kind: 'business', businessId: 'biz-1' });
    const pAfterSwitch = mgr.ensureFresh();

    resolveRefresh(
      makeToken({
        accessToken: 'at-refreshed',
        refreshToken: 'rt-refreshed',
        expiresAt: currentNow + 7200,
      }),
    );
    await expect(pRefresh).resolves.toBe('at-refreshed');
    await vi.waitFor(() => {
      expect(switchImpl).toHaveBeenCalledWith(config, 'rt-refreshed', {
        kind: 'business',
        businessId: 'biz-1',
      });
    });

    resolveSwitch(
      makeToken({
        accessToken: 'at-biz-1',
        refreshToken: 'rt-biz-1',
        expiresAt: currentNow + 7200,
      }),
    );
    await expect(pSwitch).resolves.toMatchObject({ accessToken: 'at-biz-1' });
    await expect(pAfterSwitch).resolves.toBe('at-biz-1');
    expect((await storage.load('kimi-code'))?.refreshToken).toBe('rt-biz-1');
  });

  it('preserves the active token without writing a revoked tombstone when switchWorkspace fails with invalid_grant', async () => {
    const storage = new InMemoryStorage();
    const valid = makeToken({
      accessToken: 'at-still-valid',
      refreshToken: 'rt-still-valid',
      expiresAt: currentNow + 7200,
    });
    await storage.save('kimi-code', valid);

    const mgr = new OAuthManager({
      config,
      storage,
      now,
      switchWorkspaceImpl: vi
        .fn()
        .mockRejectedValue(
          new OAuthWorkspaceSwitchError('target disabled', {
            status: 400,
            oauthError: 'invalid_grant',
          }),
        ),
    });

    await expect(mgr.switchWorkspace({ kind: 'business', businessId: 'disabled-biz' })).rejects.toThrow(
      OAuthWorkspaceSwitchError,
    );
    await expect(storage.load('kimi-code')).resolves.toEqual(valid);
    await expect(mgr.ensureFresh()).resolves.toBe('at-still-valid');
  });

  it('switches from a business workspace back to personal workspace and persists the rotated token', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-biz-current',
        refreshToken: 'rt-biz-current',
        expiresAt: currentNow + 7200,
      }),
    );
    const switchImpl = vi.fn(async () =>
      makeToken({
        accessToken: 'at-personal-next',
        refreshToken: 'rt-personal-next',
        expiresAt: currentNow + 7200,
      }),
    );
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      switchWorkspaceImpl: switchImpl,
    });

    const next = await mgr.switchWorkspace({ kind: 'personal' });

    expect(switchImpl).toHaveBeenCalledWith(config, 'rt-biz-current', { kind: 'personal' });
    expect(next.accessToken).toBe('at-personal-next');
    await expect(storage.load('kimi-code')).resolves.toMatchObject({
      accessToken: 'at-personal-next',
      refreshToken: 'rt-personal-next',
    });
  });

  it('retains the rotated token in memory and marks committed=true when storage.save fails after switch', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-before',
        refreshToken: 'rt-before',
        expiresAt: currentNow + 7200,
      }),
    );
    vi.spyOn(storage, 'save').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    const switchedToken = makeToken({
      accessToken: 'at-committed',
      refreshToken: 'rt-committed',
      expiresAt: currentNow + 7200,
    });
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      switchWorkspaceImpl: vi.fn(async () => switchedToken),
    });

    const caught = await mgr
      .switchWorkspace({ kind: 'business', businessId: 'biz-1' })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(OAuthWorkspaceSwitchError);
    expect((caught as OAuthWorkspaceSwitchError).committed).toBe(true);
    expect((caught as OAuthWorkspaceSwitchError).token?.accessToken).toBe('at-committed');
    await expect(mgr.ensureFresh()).resolves.toBe('at-committed');
    await expect(mgr.getCachedAccessToken()).resolves.toBe('at-committed');
  });

  it('serializes logout behind an in-flight switchWorkspace so rotated tokens are not resurrected', async () => {
    const storage = new InMemoryStorage();
    await storage.save(
      'kimi-code',
      makeToken({
        accessToken: 'at-before',
        refreshToken: 'rt-before',
        expiresAt: currentNow + 7200,
      }),
    );

    let resolveSwitch!: (token: TokenInfo) => void;
    const switchImpl = vi.fn(
      () =>
        new Promise<TokenInfo>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    const mgr = new OAuthManager({
      config,
      storage,
      now,
      switchWorkspaceImpl: switchImpl,
    });

    const pendingSwitch = mgr.switchWorkspace({ kind: 'business', businessId: 'biz-1' });
    await vi.waitFor(() => expect(switchImpl).toHaveBeenCalledTimes(1));

    const pendingLogout = mgr.logout();

    resolveSwitch(
      makeToken({
        accessToken: 'at-rotated-during-logout',
        refreshToken: 'rt-rotated-during-logout',
        expiresAt: currentNow + 7200,
      }),
    );

    await expect(pendingSwitch).resolves.toMatchObject({ accessToken: 'at-rotated-during-logout' });
    await pendingLogout;

    await expect(storage.load('kimi-code')).resolves.toBeUndefined();
    await expect(mgr.hasToken()).resolves.toBe(false);
    await expect(mgr.getCachedAccessToken()).resolves.toBeUndefined();
  });
});
