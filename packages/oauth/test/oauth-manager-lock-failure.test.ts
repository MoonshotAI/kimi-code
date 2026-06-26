import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthError } from '../src/errors';
import { OAuthManager } from '../src/oauth-manager';
import type { TokenStorage } from '../src/storage';
import type { OAuthFlowConfig, TokenInfo } from '../src/types';

const lockMock = vi.hoisted(() => ({
  lock: vi.fn(),
}));

vi.mock('proper-lockfile', () => ({
  default: {
    lock: lockMock.lock,
  },
}));

class InMemoryStorage implements TokenStorage {
  public token: TokenInfo | undefined;

  async load(): Promise<TokenInfo | undefined> {
    return this.token;
  }

  async save(_name: string, token: TokenInfo): Promise<void> {
    this.token = token;
  }

  async remove(): Promise<void> {
    this.token = undefined;
  }

  async list(): Promise<string[]> {
    return this.token === undefined ? [] : ['kimi-code'];
  }
}

const config: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost: 'https://unused.test',
  clientId: 'test-client-id',
};

function makeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: 1_000_000_100,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

describe('OAuthManager refresh lock failure', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `kimi-oauth-lock-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    lockMock.lock.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.skipIf(process.platform === 'win32')('fails closed instead of refreshing without a configured cross-process lock', async () => {
    const storage = new InMemoryStorage();
    storage.token = makeToken();
    lockMock.lock.mockRejectedValue(new Error('lock busy'));
    const refreshImpl = vi.fn().mockResolvedValue(makeToken({ accessToken: 'at-new' }));

    const mgr = new OAuthManager({
      config,
      storage,
      configDir: dir,
      now: () => 1_000_000_000,
      refreshTokenImpl: refreshImpl,
    });

    await expect(mgr.ensureFresh()).rejects.toBeInstanceOf(OAuthError);
    await expect(mgr.ensureFresh()).rejects.toThrow(/refresh lock/i);
    expect(refreshImpl).not.toHaveBeenCalled();
  });
});
