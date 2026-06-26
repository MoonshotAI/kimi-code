import { describe, expect, it } from 'vitest';

import { ErrorCodes, KimiError } from '#/errors';
import {
  getDefaultConfig,
  KimiConfigSchema,
  ModelAliasSchema,
  ProviderConfigSchema,
  validateConfig,
} from '#/config/schema';

describe('config/schema', () => {
  describe('getDefaultConfig', () => {
    it('returns a config that parses cleanly', () => {
      const def = getDefaultConfig();
      expect(def.providers).toEqual({});
      expect(KimiConfigSchema.parse(def)).toMatchObject({ providers: {} });
    });
  });

  describe('validateConfig', () => {
    it('accepts a minimal valid config', () => {
      const cfg = validateConfig({ providers: {} });
      expect(cfg.providers).toEqual({});
    });

    it('accepts a provider with an api key', () => {
      const cfg = validateConfig({
        providers: {
          kimi: { type: 'kimi', apiKey: 'sk-test', defaultModel: 'k1' },
        },
        defaultProvider: 'kimi',
      });
      expect(cfg.providers['kimi']).toMatchObject({ type: 'kimi', defaultModel: 'k1' });
    });

    it('throws CONFIG_INVALID for an unknown provider type', () => {
      expect(() =>
        validateConfig({ providers: { bad: { type: 'not-a-provider' } } }),
      ).toThrowError(
        expect.objectContaining({
          code: ErrorCodes.CONFIG_INVALID,
        } as Partial<KimiError>),
      );
    });

    it('throws CONFIG_INVALID for a non-object root', () => {
      expect(() => validateConfig('nope')).toThrow();
    });
  });

  describe('ProviderConfigSchema', () => {
    it('requires a recognized type', () => {
      expect(() => ProviderConfigSchema.parse({ type: 'bogus' })).toThrow();
    });

    it('accepts oauth ref', () => {
      const cfg = ProviderConfigSchema.parse({
        type: 'kimi',
        oauth: { storage: 'file', key: 'default' },
      });
      expect(cfg.oauth).toEqual({ storage: 'file', key: 'default' });
    });
  });

  describe('ModelAliasSchema', () => {
    it('requires positive maxContextSize', () => {
      expect(() =>
        ModelAliasSchema.parse({ provider: 'kimi', model: 'k1', maxContextSize: 0 }),
      ).toThrow();
    });

    it('accepts a full model alias', () => {
      const m = ModelAliasSchema.parse({
        provider: 'kimi',
        model: 'k1',
        maxContextSize: 128000,
        maxOutputSize: 8192,
      });
      expect(m.maxContextSize).toBe(128000);
    });
  });
});
