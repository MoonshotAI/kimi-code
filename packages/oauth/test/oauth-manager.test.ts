/**
 * OAuthManager tests — exercise ensureFresh / login / logout against a fake
 * storage and injected transport mocks. No network, no file locks.
 *
 * We inject `refreshTokenImpl`, `pollDeviceImpl`, `requestDeviceImpl`, `now`,
 * and `sleep` for determinism. The storage is an in-memory implementation.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceCodeTimeoutError, OAuthUnauthorizedError } from '../src/errors';
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
    expiresAt: 2_000_000_000, // far future
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

// ── ensureFresh ───────────────────────────────────────────────────────

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
    // expires in 200s, threshold = max(300, 3600*0.5) = 1800. 200 < 1800 → refresh
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
    // The non-force caller arrives first while the stored token is still
    // fresh enough to short-circuit (no refresh would fire). A later
    // force=true caller must NOT receive that cached short-circuit —
    // forced rotation has its own semantics (e.g. recovery after a 401
    // upstream) that the non-force coalesce path cannot satisfy.
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
    // Non-force saw the still-fresh cached token; force=true got the
    // refresh it actually asked for.
    expect(nonForceResult).toBe('at-1');
    expect(forcedResult).toBe('forced-1');
  });

  it('lets a non-force caller piggyback a force=true in-flight refresh', async () => {
    // The reverse direction is always safe: a non-force caller is happy
    // with anything the in-flight call returns, so we MUST coalesce
    // rather than spawn a second refresh round-trip.
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
    // While a non-force call is in flight, several force=true callers
    // may arrive. They cannot piggyback the non-force result, but they
    // SHOULD share a single forced refresh among themselves once the
    // non-force call settles — otherwise N concurrent 401 recoveries
    // would each burn a separate OAuth round-trip.
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
    // Edge case: the non-force in-flight call rejects (e.g. transient
    // network error). A queued force caller must still get its forced
    // refresh — the failure of the unrelated non-force call must not
    // bleed into the force caller's outcome.
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
    // Keep the file (so a peer can observe "previously logged in, now
    // rejected") but blank out access_token and refresh_token so neither
    // this process nor a fresh one will try to reuse the rejected token.
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
    // Simulate: our refresh attempt fails 401 because rt-old was rotated by
    // another process; the new token is already in storage.
    let refreshAttempts = 0;
    const refreshImpl = vi.fn().mockImplementation(async (_cfg, rt: string) => {
      refreshAttempts += 1;
      if (rt === 'rt-old') {
        // Race: while we were calling refresh, another process rotated.
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
    // Should NOT throw — should re-read the rotated token and return it
    const access = await mgr.ensureFresh();
    expect(access).toBe('at-rotated');
    // File should still have the rotated token
    expect((await storage.load('kimi-code'))?.accessToken).toBe('at-rotated');
    expect(refreshAttempts).toBe(1);
  });

  // ── force=true propagates errors (no silent swallow) ──────────────────

  it('force=true surfaces OAuthUnauthorizedError to the caller', async () => {
    // `force=true` must not paper over a genuinely revoked refresh_token.
    // Caller drives /login to recover; ensureFresh throws so the error
    // is observable.
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
    // Tombstone on disk so a fresh process won't retry the dead refresh_token.
    const retained = await storage.load('kimi-code');
    expect(retained).toBeDefined();
    expect(retained?.accessToken).toBe('');
    expect(retained?.refreshToken).toBe('');
  });

  it('force=true surfaces network errors without swallowing', async () => {
    // A transport error inside force=true must reach the caller —
    // the caller owns the try/catch policy, not ensureFresh.
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
    // Network error is NOT a revocation signal — storage must stay intact.
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
    const refreshImpl = vi.fn(); // should NOT be called — latest is fresh
    const mgr = new OAuthManager({ config, storage, now, refreshTokenImpl: refreshImpl });

    // Second load call returns an externally-rotated token that's fresh.
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
    // Tombstoned on disk — fresh processes load this and see "rejected".
    const persistedAfter401 = await storage.load('kimi-code');
    expect(persistedAfter401).toBeDefined();
    expect(persistedAfter401?.accessToken).toBe('');
    expect(persistedAfter401?.refreshToken).toBe('');
    expect(await mgr.hasToken()).toBe(false);
    expect(await mgr.getCachedAccessToken()).toBeUndefined();

    currentNow += 10_000;
    await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthUnauthorizedError);
    // The tombstone short-circuits before refreshImpl can be called again.
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
    // After a refresh_token rejection we keep the file (so concurrent peers
    // can observe the state and so we don't lose diagnostic info), but the
    // persisted token MUST itself indicate "not usable" — otherwise a fresh
    // process with an empty in-memory suppression cache would happily try
    // to refresh the dead token again and burn an OAuth server round-trip
    // every time. Tombstone = empty access_token + empty refresh_token.
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

// ── login ─────────────────────────────────────────────────────────────

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
    // sleep mock also advances `currentNow` to simulate wall clock
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
      deviceCodeTimeoutMs: 10_000, // 10s for test
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

// ── logout & hasToken ─────────────────────────────────────────────────

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

// ── slow_down RFC 8628 §3.5 ────────────────────────────────────────────

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
        interval: 5, // baseline
      }),
      pollDeviceImpl: pollImpl,
      sleep,
    });
    await mgr.login();
    // After 1st pending → sleep 5s. After slow_down #2 → +5 = 10s.
    // After slow_down #3 → +5 = 15s. Then success (no sleep).
    expect(sleepCalls).toEqual([5000, 10_000, 15_000]);
  });
});

// ── FileTokenStorage integration ───────────────────────────────────────

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

    // New manager instance reads from same storage (simulates restart)
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
