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
  resolveModelForReady,
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

describe('resolveModelForReady', () => {
  const providers: Readonly<Record<string, ProviderConfig>> = {
    'prov-a': { type: 'openai', apiKey: 'sk-a' },
    '__kimi_env__': { type: 'kimi', baseUrl: 'https://api.example.test/coding/v1' },
  };

  it('reports no-default when the model id is missing or empty', () => {
    expect(resolveModelForReady(undefined, {}, providers)).toEqual({
      resolved: false,
      reason: 'no-default',
    });
    expect(resolveModelForReady('', {}, providers)).toEqual({
      resolved: false,
      reason: 'no-default',
    });
    expect(resolveModelForReady('   ', {}, providers)).toEqual({
      resolved: false,
      reason: 'no-default',
    });
  });

  it('reports dangling-alias when the alias is absent from the models table', () => {
    expect(resolveModelForReady('ghost', {}, providers)).toEqual({
      resolved: false,
      reason: 'dangling-alias',
    });
  });

  it('looks up the configured id as an exact key, trimming only to reject blanks', () => {
    const models = { m: { providerId: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady(' m ', models, providers)).toEqual({
      resolved: false,
      reason: 'dangling-alias',
    });
    const padded = { ' m ': { providerId: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady(' m ', padded, providers)).toEqual({ resolved: true });
  });

  it('resolves a providerId pointing at an existing provider', () => {
    const models = { m: { providerId: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers)).toEqual({ resolved: true });
  });

  it('resolves a provider field pointing at an existing provider', () => {
    const models = { m: { provider: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers)).toEqual({ resolved: true });
  });

  it('reports provider-missing when a named provider is absent from the providers table', () => {
    expect(
      resolveModelForReady('m', { m: { providerId: 'gone', model: 'gpt' } }, providers),
    ).toEqual({ resolved: false, reason: 'provider-missing' });
    expect(
      resolveModelForReady('m', { m: { provider: 'gone', model: 'gpt' } }, providers),
    ).toEqual({ resolved: false, reason: 'provider-missing' });
  });

  it('resolves a providerless flat model through its baseUrl', () => {
    const models = {
      m: {
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt',
        protocol: 'openai' as const,
        maxContextSize: 4096,
        apiKey: 'sk-x',
      },
    };
    expect(resolveModelForReady('m', models, {})).toEqual({ resolved: true });
  });

  it('resolves a model omitting provider fields through the configured defaultProvider', () => {
    const models = { m: { model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers, 'prov-a')).toEqual({ resolved: true });
  });

  it('reports provider-missing when the configured defaultProvider is absent from the providers table', () => {
    const models = { m: { model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers, 'gone')).toEqual({
      resolved: false,
      reason: 'provider-missing',
    });
  });

  it('looks up the default provider as an exact key, trimming only to reject blanks', () => {
    const models = { m: { model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers, ' prov-a ')).toEqual({
      resolved: false,
      reason: 'provider-missing',
    });
    const paddedProviders = { ' prov-a ': { type: 'openai', apiKey: 'sk-a' } };
    expect(resolveModelForReady('m', models, paddedProviders, ' prov-a ')).toEqual({
      resolved: true,
    });
    expect(resolveModelForReady('m', models, providers, '   ')).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when provider id, provider field, and baseUrl are all absent', () => {
    expect(resolveModelForReady('m', { m: { model: 'gpt' } }, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('resolves the env-overlay injected model against the env provider', () => {
    const models = {
      '__kimi_env_model__': {
        provider: '__kimi_env__',
        model: 'kimi-for-coding',
        maxContextSize: 262144,
      },
    };
    expect(resolveModelForReady('__kimi_env_model__', models, providers)).toEqual({
      resolved: true,
    });
  });

  it('reports unresolvable when the provider exists but the wire name is missing', () => {
    const models = { m: { provider: 'prov-a' } };
    expect(resolveModelForReady('m', models, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('resolves through the effective config with overrides merged', () => {
    const models = {
      m: {
        provider: 'prov-a',
        model: 'gpt',
        overrides: { maxContextSize: 4096, displayName: 'G' },
      },
    };
    expect(resolveModelForReady('m', models, providers)).toEqual({ resolved: true });
  });

  it('reports unresolvable when the provider-backed model lacks maxContextSize', () => {
    const models = { m: { provider: 'prov-a', model: 'gpt' } };
    expect(resolveModelForReady('m', models, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when maxContextSize is not positive', () => {
    const models = { m: { provider: 'prov-a', model: 'gpt', maxContextSize: 0 } };
    expect(resolveModelForReady('m', models, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when a providerless flat model lacks a protocol', () => {
    const models = {
      m: { baseUrl: 'https://api.example.test/v1', model: 'gpt', maxContextSize: 4096 },
    };
    expect(resolveModelForReady('m', models, {})).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when neither endpoint nor protocol is derivable from the provider', () => {
    const models = { m: { provider: 'prov-x', model: 'gpt', maxContextSize: 4096 } };
    const unknownVendors: Readonly<Record<string, ProviderConfig>> = {
      'prov-x': { type: 'my-vendor', apiKey: 'sk-x' },
    };
    expect(resolveModelForReady('m', models, unknownVendors)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });
});
