import { describe, expect, it } from 'vitest';

import { ConfigErrors } from '#/app/config/errors';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import type { ProviderConfig } from '#/kosong/provider/provider';
import type { ModelRecord } from '#/kosong/model/model';
import {
  deriveProviderId,
  effectiveModelConfig,
  resolveModelAuthMaterial,
} from '#/kosong/model/modelAuth';

function authMaterial(args: {
  model: ModelRecord;
  provider?: ProviderConfig;
}): ReturnType<typeof resolveModelAuthMaterial> {
  return resolveModelAuthMaterial({
    modelId: 'm1',
    model: args.model,
    provider: args.provider,
    providerName: 'p1',
  });
}

describe('resolveModelAuthMaterial', () => {
  it('prefers the model inline credentials over everything else', () => {
    expect(
      authMaterial({
        model: { model: 'm', apiKey: 'model-key' },
        provider: { type: 'openai', apiKey: 'provider-key' },
      }),
    ).toEqual({ apiKey: 'model-key' });
    expect(
      authMaterial({
        model: { model: 'm', oauth: { storage: 'file', key: 'k' }, providerId: 'p1' },
        provider: { type: 'openai', apiKey: 'provider-key' },
      }),
    ).toEqual({ oauth: { storage: 'file', key: 'k' }, oauthProviderKey: 'p1' });
  });

  it('rejects apiKey+oauth on the same level as config.invalid', () => {
    expect(() =>
      authMaterial({ model: { model: 'm', apiKey: 'k', oauth: { storage: 'file', key: 'k' } } }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
    expect(() =>
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKey: 'k', oauth: { storage: 'file', key: 'k' } },
      }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
  });

  it('reads env-bag credentials through the vendor endpoint declarations', () => {
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'kimi', env: { KIMI_API_KEY: 'kimi-env-key' } },
      }),
    ).toEqual({ apiKey: 'kimi-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'anthropic', env: { ANTHROPIC_API_KEY: 'anthropic-env-key' } },
      }),
    ).toEqual({ apiKey: 'anthropic-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', env: { OPENAI_API_KEY: 'openai-env-key' } },
      }),
    ).toEqual({ apiKey: 'openai-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'google-genai', env: { GOOGLE_API_KEY: 'google-env-key' } },
      }),
    ).toEqual({ apiKey: 'google-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: {
          type: 'google-genai',
          env: { VERTEXAI_API_KEY: 'vertex-env-key', GOOGLE_API_KEY: 'google-env-key' },
        },
      }),
    ).toEqual({ apiKey: 'vertex-env-key' });
  });

  it('returns empty material when nothing is configured', () => {
    expect(authMaterial({ model: { model: 'm' }, provider: { type: 'openai' } })).toEqual({});
    expect(authMaterial({ model: { model: 'm' } })).toEqual({});
  });
});

describe('effectiveModelConfig', () => {
  it('applies overrides over the base record', () => {
    const effective = effectiveModelConfig({
      model: 'm',
      maxOutputSize: 8192,
      overrides: { maxOutputSize: 4096, displayName: 'M' },
    });
    expect(effective.maxOutputSize).toBe(4096);
    expect(effective.displayName).toBe('M');
  });

  it('drops a defaultEffort the override effort list does not contain', () => {
    const effective = effectiveModelConfig({
      model: 'm',
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { supportEfforts: ['low'] },
    });
    expect(effective.supportEfforts).toEqual(['low']);
    expect(effective.defaultEffort).toBeUndefined();
  });

  it('infers the Anthropic profile for non-trait-driven vendors only', () => {
    const record: ModelRecord = { model: 'claude-sonnet-4-5', protocol: 'anthropic' };
    const inferred = effectiveModelConfig(record, 'anthropic');
    expect(inferred.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(inferred.defaultEffort).toBe('high');
    expect(inferred.capabilities).toContain('thinking');

    const kimiRouted = effectiveModelConfig({ model: 'kimi-k2', protocol: 'anthropic' }, 'kimi');
    expect(kimiRouted.supportEfforts).toBeUndefined();
    expect(kimiRouted.capabilities).toBeUndefined();
  });
});

describe('deriveProviderId', () => {
  it('keys flat providers by the baseUrl origin', () => {
    expect(deriveProviderId('https://api.example.test/v1')).toBe('api.example.test');
    expect(deriveProviderId('not-a-url')).toBe('not-a-url');
  });
});
