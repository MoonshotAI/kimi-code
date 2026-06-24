import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InstantiationService,
  type IEnvironmentService,
} from '@moonshot-ai/agent-core';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAuthTokenService,
  IAuthTokenService,
} from '#/services/auth/authTokenService';
import { resolvePasswordHash } from '#/services/auth/password';
import { createTokenStore, type TokenStore } from '#/services/auth/tokenStore';
import type { FastifyLike } from '#/services/gateway/restGateway';
import { createServerServiceCollection } from '#/services/serviceCollection';

function tmpEnv(): { dir: string; env: IEnvironmentService } {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-auth-token-test-'));
  return {
    dir,
    env: {
      _serviceBrand: undefined,
      homeDir: dir,
      configPath: join(dir, 'config.toml'),
    },
  };
}

/** Minimal Fastify shape — `FastifyRestGateway` only stores it at construction. */
function appStub(): FastifyLike {
  return {
    server: {} as unknown as HttpServer,
    listen: async () => 'http://127.0.0.1:0',
    close: async () => {},
  };
}

describe('createAuthTokenService', () => {
  let homeDir: string;
  let store: TokenStore;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-auth-token-store-'));
    store = await createTokenStore(homeDir);
  });

  afterEach(async () => {
    await store.dispose();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('getToken() returns the tokenStore token', () => {
    const svc = createAuthTokenService({ tokenStore: store, passwordHash: undefined });
    expect(svc.getToken()).toBe(store.getToken());
  });

  it('isValid accepts the token', async () => {
    const svc = createAuthTokenService({ tokenStore: store, passwordHash: undefined });
    expect(await svc.isValid(store.getToken())).toBe(true);
  });

  it('isValid accepts the password when a hash is configured', async () => {
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct horse battery staple',
    });
    const svc = createAuthTokenService({ tokenStore: store, passwordHash });
    expect(await svc.isValid('correct horse battery staple')).toBe(true);
  });

  it('isValid rejects a wrong candidate', async () => {
    const passwordHash = await resolvePasswordHash({
      KIMI_CODE_PASSWORD: 'correct horse battery staple',
    });
    const svc = createAuthTokenService({ tokenStore: store, passwordHash });
    expect(await svc.isValid('wrong')).toBe(false);
  });

  it('isValid accepts only the token when passwordHash is undefined', async () => {
    const svc = createAuthTokenService({ tokenStore: store, passwordHash: undefined });
    expect(await svc.isValid(store.getToken())).toBe(true);
    expect(await svc.isValid('any-password')).toBe(false);
  });
});

describe('IAuthTokenService via serviceCollection override', () => {
  let env: IEnvironmentService;
  let dir: string;
  let ix: InstantiationService;

  const fixed: IAuthTokenService = {
    _serviceBrand: undefined,
    getToken: () => 'fixed-token',
    isValid: async (candidate) => candidate === 'fixed-token',
  };

  beforeEach(() => {
    ({ env, dir } = tmpEnv());
    const collection = createServerServiceCollection({
      server: {
        host: '127.0.0.1',
        port: 0,
        serviceOverrides: [[IAuthTokenService, fixed] as const],
      },
      app: appStub(),
      pinoLogger: pino({ level: 'silent' }),
      envService: env,
    });
    ix = new InstantiationService(collection);
  });

  afterEach(() => {
    ix.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retrieves the injected impl and validates its own token', async () => {
    const resolved = ix.invokeFunction((a) => a.get(IAuthTokenService));
    expect(resolved).toBe(fixed);
    expect(await resolved.isValid(resolved.getToken())).toBe(true);
    expect(await resolved.isValid('nope')).toBe(false);
  });
});
