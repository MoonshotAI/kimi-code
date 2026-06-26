import { describe, expect, it } from 'vitest';

import { ErrorCodes, KimiError } from '#/errors';
import { validateConfig, type KimiConfig } from '#/config/schema';
import { ProviderManager } from '#/session/provider-manager';

function makeConfig(overrides: Partial<KimiConfig> = {}): KimiConfig {
  return validateConfig({
    defaultProvider: 'kimi',
    defaultModel: 'k1',
    providers: {
      kimi: { type: 'kimi', apiKey: 'sk-test' },
    },
    models: {
      k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
    },
    ...overrides,
  });
}

describe('ProviderManager', () => {
  it('resolves a configured model to its provider', () => {
    const pm = new ProviderManager({ config: makeConfig() });
    const resolved = pm.resolveProviderConfig('k1');
    expect(resolved.providerName).toBe('kimi');
    expect(resolved.provider).toMatchObject({ model: 'kimi-model' });
    expect(resolved.modelCapabilities).toBeDefined();
  });

  it('exposes defaultModel from config', () => {
    const pm = new ProviderManager({ config: makeConfig() });
    expect(pm.defaultModel).toBe('k1');
  });

  it('accepts a config thunk', () => {
    const cfg = makeConfig();
    const pm = new ProviderManager({ config: () => cfg });
    expect(pm.defaultModel).toBe('k1');
  });

  it('throws CONFIG_INVALID for an unknown model', () => {
    const pm = new ProviderManager({ config: makeConfig() });
    expect(() => pm.resolveProviderConfig('does-not-exist')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<KimiError>),
    );
  });

  it('throws CONFIG_INVALID when model has no provider and no defaultProvider', () => {
    const cfg = makeConfig({ defaultProvider: undefined });
    // Patch in a model without a provider after validation (schema allows it).
    (cfg.models as Record<string, unknown>)['orphan'] = {
      model: 'm',
      maxContextSize: 1000,
    };
    const pm = new ProviderManager({ config: cfg });
    expect(() => pm.resolveProviderConfig('orphan')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<KimiError>),
    );
  });

  it('throws CONFIG_INVALID when provider is not configured', () => {
    const cfg = makeConfig();
    (cfg.models as Record<string, unknown>)['ghost'] = {
      provider: 'missing',
      model: 'm',
      maxContextSize: 1000,
    };
    const pm = new ProviderManager({ config: cfg });
    expect(() => pm.resolveProviderConfig('ghost')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<KimiError>),
    );
  });
});
