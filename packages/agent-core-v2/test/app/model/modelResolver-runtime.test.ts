import { describe, expect, it } from 'vitest';

import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IModelResolver } from '#/app/model/modelResolver';
import { createAppScope } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import '#/index';

function stubConfig(sections: Record<string, unknown>): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    get: <T>(domain: string) => sections[domain] as T,
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({ ...sections }),
    set: () => Promise.resolve(),
    replace: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    diagnostics: () => [],
  } as unknown as IConfigService;
}

function stubOAuth(): IOAuthService {
  return {
    _serviceBrand: undefined,
    startLogin: () => Promise.reject(new Error('not implemented')),
    getFlow: () => undefined,
    cancelLogin: () => Promise.reject(new Error('not implemented')),
    logout: () => Promise.reject(new Error('not implemented')),
    status: () => Promise.resolve({ loggedIn: false }),
    refreshOAuthProviderModels: () => Promise.reject(new Error('not implemented')),
    resolveTokenProvider: () => undefined,
    getCachedAccessToken: () => Promise.resolve(undefined),
  };
}

function baseSections(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1' },
    },
    models: {
      k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
    },
    ...overrides,
  };
}

function createResolver(sections: Record<string, unknown>): IModelResolver {
  const scope = createAppScope({
    extra: [
      [IConfigService, stubConfig(sections)],
      [IOAuthService, stubOAuth()],
    ],
  });
  return scope.accessor.get(IModelResolver);
}

describe('ModelResolver', () => {
  it('resolves a configured model to its provider', () => {
    const resolver = createResolver(baseSections());
    const resolved = resolver.resolve('k1');
    expect(resolved.providerName).toBe('kimi');
    expect(resolved.name).toBe('kimi-model');
    expect(resolved.protocol).toBe('kimi');
    expect(resolved.capabilities).toBeDefined();
  });

  it('reads providers and models from the config service', () => {
    const resolver = createResolver(baseSections());
    expect(resolver.resolve('k1').providerName).toBe('kimi');
  });

  it('throws CONFIG_INVALID for an unknown model', () => {
    const resolver = createResolver(baseSections());
    expect(() => resolver.resolve('does-not-exist')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<Error2>),
    );
  });

  it('falls back to defaultProvider when a model has no provider', () => {
    const resolver = createResolver(
      baseSections({
        defaultProvider: 'kimi',
        models: {
          k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
          inherited: { model: 'm', maxContextSize: 1000 },
        },
      }),
    );
    expect(resolver.resolve('inherited').providerName).toBe('kimi');
  });

  it('throws CONFIG_INVALID when model has no provider and no defaultProvider', () => {
    const resolver = createResolver(
      baseSections({
        defaultProvider: undefined,
        models: {
          k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
          orphan: { model: 'm', maxContextSize: 1000 },
        },
      }),
    );
    expect(() => resolver.resolve('orphan')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<Error2>),
    );
  });

  it('throws CONFIG_INVALID when provider is not configured', () => {
    const resolver = createResolver(
      baseSections({
        models: {
          k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
          ghost: { provider: 'missing', model: 'm', maxContextSize: 1000 },
        },
      }),
    );
    expect(() => resolver.resolve('ghost')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<Error2>),
    );
  });
});
