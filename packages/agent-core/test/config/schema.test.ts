import { describe, expect, it } from 'vitest';

import { ProviderConfigSchema } from '../../src/config/schema';

describe('ProviderConfigSchema — free_models_only', () => {
  it('accepts free_models_only: true', () => {
    const parsed = ProviderConfigSchema.parse({
      type: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or',
      free_models_only: true,
    });
    expect(parsed.free_models_only).toBe(true);
  });

  it('accepts free_models_only: false', () => {
    const parsed = ProviderConfigSchema.parse({
      type: 'openai',
      apiKey: 'sk-or',
      free_models_only: false,
    });
    expect(parsed.free_models_only).toBe(false);
  });

  it('accepts an absent free_models_only (undefined, no default)', () => {
    const parsed = ProviderConfigSchema.parse({ type: 'openai', apiKey: 'sk-or' });
    expect(parsed.free_models_only).toBeUndefined();
  });

  it('rejects a non-boolean free_models_only (string)', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        type: 'openai',
        apiKey: 'sk-or',
        free_models_only: 'yes',
      }),
    ).toThrow();
  });

  it('rejects a non-boolean free_models_only (number)', () => {
    expect(() =>
      ProviderConfigSchema.parse({
        type: 'openai',
        apiKey: 'sk-or',
        free_models_only: 1,
      }),
    ).toThrow();
  });

  it('coexists with proxyUrl at the same level', () => {
    const parsed = ProviderConfigSchema.parse({
      type: 'openai',
      apiKey: 'sk-or',
      proxyUrl: 'http://localhost:8080',
      free_models_only: true,
    });
    expect(parsed.proxyUrl).toBe('http://localhost:8080');
    expect(parsed.free_models_only).toBe(true);
  });
});
