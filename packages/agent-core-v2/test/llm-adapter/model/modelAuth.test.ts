import { describe, expect, it, vi } from 'vitest';

import { ConfigErrors } from '#/app/config/errors';
import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import type { ModelRecord } from '#/llm-adapter/model/model';
import {
  deriveProviderId,
  effectiveModelConfig,
  resolveEndpointBaseUrl,
  resolveModelAuthMaterial,
  resolveModelForReady,
  resolveModelProtocol,
} from '#/llm-adapter/model/model-auth';

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

  it('returns the declared variable name for provider api_key_env without reading the value', () => {
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKeyEnv: 'ACME_API_KEY' },
      }),
    ).toEqual({ apiKeyEnv: 'ACME_API_KEY' });
  });

  it('prefers provider api_key_env over the env sub-table conventional names', () => {
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'kimi', apiKeyEnv: 'ACME_API_KEY', env: { KIMI_API_KEY: 'sub-table-key' } },
      }),
    ).toEqual({ apiKeyEnv: 'ACME_API_KEY' });
  });

  it('rejects apiKey+apiKeyEnv and apiKeyEnv+oauth on a provider as config.invalid', () => {
    expect(() =>
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKey: 'k', apiKeyEnv: 'ACME_API_KEY' },
      }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
    expect(() =>
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKeyEnv: 'ACME_API_KEY', oauth: { storage: 'file', key: 'k' } },
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

  it('prefers an explicit credential over bedrock ambient auth', () => {
    expect(
      authMaterial({
        model: { model: 'anthropic.claude-sonnet-4-6' },
        provider: { type: 'bedrock', apiKey: 'static-key' },
      }),
    ).toEqual({ apiKey: 'static-key' });
    expect(
      authMaterial({
        model: { model: 'anthropic.claude-sonnet-4-6' },
        provider: { type: 'bedrock', env: { AWS_BEARER_TOKEN_BEDROCK: 'env-token' } },
      }),
    ).toEqual({ apiKey: 'env-token' });
  });

  it('falls back to bedrock ambient auth carrying the env-bag region and profile', () => {
    expect(
      authMaterial({
        model: { model: 'anthropic.claude-sonnet-4-6' },
        provider: {
          type: 'bedrock',
          env: { AWS_REGION: 'eu-west-1', AWS_PROFILE: 'bedrock-dev' },
        },
      }),
    ).toEqual({ aws: { region: 'eu-west-1', profile: 'bedrock-dev' } });
  });

  it('reads the ambient AWS region and profile from process.env for bedrock providers', () => {
    vi.stubEnv('AWS_REGION', 'ap-southeast-2');
    vi.stubEnv('AWS_PROFILE', 'ambient-profile');
    try {
      expect(
        authMaterial({
          model: { model: 'anthropic.claude-sonnet-4-6' },
          provider: { type: 'bedrock' },
        }),
      ).toEqual({ aws: { region: 'ap-southeast-2', profile: 'ambient-profile' } });
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('matches bedrock inference-profile model ids against the Anthropic profile', () => {
    const inferred = effectiveModelConfig(
      { model: 'global.anthropic.claude-sonnet-4-6', protocol: 'anthropic' },
      'bedrock',
    );
    expect(inferred.supportEfforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(inferred.capabilities).toContain('thinking');
  });
});

describe('resolveModelProtocol', () => {
  it('infers the bedrock wire protocol from the model id prefix', () => {
    const provider: ProviderConfig = { type: 'bedrock' };
    expect(
      resolveModelProtocol({ model: 'global.anthropic.claude-sonnet-4-6' }, provider),
    ).toBe('anthropic');
    expect(resolveModelProtocol({ model: 'openai.gpt-oss-120b-1:0' }, provider)).toBe('openai');
    expect(resolveModelProtocol({ model: 'global.openai.gpt-6-astra' }, provider)).toBe(
      'openai_responses',
    );
    expect(resolveModelProtocol({ model: 'global.moonshotai.kimi-k3' }, provider)).toBe('openai');
  });

  it('lets an explicit model protocol win over bedrock inference', () => {
    const provider: ProviderConfig = { type: 'bedrock' };
    expect(
      resolveModelProtocol(
        { model: 'anthropic.claude-sonnet-4-6', protocol: 'openai_responses' },
        provider,
      ),
    ).toBe('openai_responses');
  });

  it('falls back to the bedrock base protocol for unrecognized model families', () => {
    const provider: ProviderConfig = { type: 'bedrock' };
    expect(resolveModelProtocol({ model: 'meta.llama3-3-70b-instruct-v1:0' }, provider)).toBe(
      'openai',
    );
  });
});

describe('resolveEndpointBaseUrl', () => {
  it('derives the bedrock-runtime base url from the env-bag region when nothing is set', () => {
    vi.stubEnv('AWS_REGION', 'us-west-2');
    try {
      expect(
        resolveEndpointBaseUrl(
          { model: 'global.anthropic.claude-sonnet-4-6' },
          { type: 'bedrock', env: { AWS_REGION: 'eu-west-1' } },
        ),
      ).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('derives the openai bedrock-runtime base url for openai models', () => {
    vi.stubEnv('AWS_REGION', 'us-east-1');
    try {
      expect(
        resolveEndpointBaseUrl({ model: 'openai.gpt-oss-120b-1:0' }, { type: 'bedrock' }),
      ).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('prefers explicit bedrock base urls and env declarations over region derivation', () => {
    expect(
      resolveEndpointBaseUrl(
        { model: 'anthropic.claude-sonnet-4-6' },
        { type: 'bedrock', baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic' },
      ),
    ).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic');
    expect(
      resolveEndpointBaseUrl(
        { model: 'anthropic.claude-sonnet-4-6' },
        {
          type: 'bedrock',
          env: {
            AWS_BEDROCK_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic',
            AWS_REGION: 'eu-west-1',
          },
        },
      ),
    ).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/anthropic');
  });

  it('rejects a bedrock provider when no region is resolvable from env', () => {
    vi.stubEnv('AWS_REGION', '');
    vi.stubEnv('AWS_DEFAULT_REGION', '');
    try {
      expect(() =>
        resolveEndpointBaseUrl({ model: 'anthropic.claude-sonnet-4-6' }, { type: 'bedrock' }),
      ).toThrow(/could not resolve an AWS region/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a bedrock provider whose region would come only from an AWS_PROFILE config file', () => {
    vi.stubEnv('AWS_REGION', '');
    vi.stubEnv('AWS_DEFAULT_REGION', '');
    try {
      expect(() =>
        resolveEndpointBaseUrl(
          { model: 'global.openai.gpt-6-astra' },
          { type: 'bedrock', env: { AWS_PROFILE: 'my-sso-profile' } },
        ),
      ).toThrow(/could not resolve an AWS region/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('points the region error at the actual provider table, not [providers.bedrock]', () => {
    vi.stubEnv('AWS_REGION', '');
    vi.stubEnv('AWS_DEFAULT_REGION', '');
    try {
      expect(() =>
        resolveEndpointBaseUrl(
          { model: 'anthropic.claude-sonnet-4-6' },
          { type: 'bedrock' },
          'aws-prod',
        ),
      ).toThrow(/\[providers\.aws-prod\.env\]/);
      expect(() =>
        resolveEndpointBaseUrl({ model: 'anthropic.claude-sonnet-4-6' }, { type: 'bedrock' }),
      ).toThrow(/\[providers\.bedrock\.env\]/);
    } finally {
      vi.unstubAllEnvs();
    }
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
