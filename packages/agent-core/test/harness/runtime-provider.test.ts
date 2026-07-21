import { describe, expect, it } from 'vitest';

import type { KimiConfig, ModelAlias } from '../../src/config';
import { ErrorCodes, KimiError } from '../../src/errors';
import { ProviderManager } from '../../src/session/provider-manager';
import { resolveThinkingEffort } from '../../src/agent/config/thinking';

// Thin wrapper that adapts the legacy `resolveRuntimeProvider(input)` shape to
// the current ProviderManager API. Kept local so the existing test bodies do
// not need to change.
function resolveRuntimeProvider(input: {
  readonly config: KimiConfig;
  readonly model?: string;
  readonly kimiRequestHeaders?: Record<string, string>;
  readonly promptCacheKey?: string;
}): ReturnType<ProviderManager['resolveProviderConfig']> {
  const manager = new ProviderManager({
    config: input.config,
    kimiRequestHeaders: input.kimiRequestHeaders,
    promptCacheKey: input.promptCacheKey,
  });
  const model = input.model ?? input.config.defaultModel;
  if (model === undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      'No model is selected. Set default_model in config.toml or pass a configured model alias.',
    );
  }
  return manager.resolveProviderConfig(model);
}

const BASE_CONFIG: KimiConfig = {
  defaultModel: 'kimi-code/kimi-for-coding',
  providers: {
    'managed:kimi-code': {
      type: 'kimi',
      apiKey: 'test-key',
      baseUrl: 'https://api.example/v1',
    },
  },
  models: {
    'kimi-code/kimi-for-coding': {
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
      maxContextSize: 1_000_000,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
    },
  },
};

const TEST_KIMI_HEADERS = {
  'User-Agent': 'kimi-code-cli/0.0.0-test',
  'X-Msh-Platform': 'kimi_code_cli',
  'X-Msh-Version': '0.0.0-test',
};

describe('resolveRuntimeProvider model metadata', () => {
  it('uses config model metadata as the source of truth', () => {
    const resolved = resolveRuntimeProvider({
      config: BASE_CONFIG,
    });

    expect(resolved.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
    expect(resolved.provider.model).toBe('kimi-for-coding');
  });

  it('resolves requested aliases to the configured provider and provider model', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
            baseUrl: 'https://openai.example/v1',
          },
        },
        models: {
          ...BASE_CONFIG.models!,
          'gpt-alias': {
            provider: 'openai',
            model: 'gpt-runtime',
            maxContextSize: 200000,
            capabilities: ['tool_use'],
          },
        },
      },
      model: 'gpt-alias',
    });

    expect(resolved.providerName).toBe('openai');
    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-runtime',
      apiKey: 'sk-openai',
      baseUrl: 'https://openai.example/v1',
    });
    expect(resolved.modelCapabilities).toMatchObject({
      tool_use: true,
      max_context_tokens: 200000,
    });
  });

  it('uses config Kimi capabilities without requiring an api key during OAuth setup', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            apiKey: '',
            baseUrl: 'https://api.example/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
      },
    });

    expect(resolved.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('does not infer Kimi capabilities from the provider model name', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        models: {
          'kimi-code/kimi-for-coding': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            maxContextSize: 1_000_000,
          },
        },
      },
    });

    expect(resolved.modelCapabilities).toMatchObject({
      image_in: false,
      video_in: false,
      thinking: false,
      tool_use: false,
      max_context_tokens: 1_000_000,
    });
  });

  it('rejects provider model names that are not configured aliases', () => {
    expect(() =>
      resolveRuntimeProvider({
        config: BASE_CONFIG,
        model: 'kimi-for-coding',
      }),
    ).toThrow(/not configured in config.toml/);
  });

  it('throws when no model is selected', () => {
    expect(() =>
      resolveRuntimeProvider({
        config: {
          providers: {},
        },
      }),
    ).toThrow(/No model is selected/);
  });

  it('throws when the selected model is not configured as an alias', () => {
    expect(() =>
      resolveRuntimeProvider({
        config: BASE_CONFIG,
        model: 'kimi-code',
      }),
    ).toThrow(KimiError);
  });

  it('allows vertexai providers without an apiKey', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          vertex: {
            type: 'vertexai',
          },
        },
        models: {
          gemini: {
            provider: 'vertex',
            model: 'gemini-1.5-pro',
            maxContextSize: 1_000_000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({ type: 'vertexai' });
  });

  it('throws when the selected model alias has no maxContextSize', () => {
    const config = {
      ...BASE_CONFIG,
      models: {
        broken: {
          provider: 'managed:kimi-code',
          model: 'kimi-for-coding',
          capabilities: ['thinking'],
        },
      },
    } as unknown as KimiConfig;

    expect(() =>
      resolveRuntimeProvider({
        config,
        model: 'broken',
      }),
    ).toThrow(/max_context_size/);
  });
});

describe('resolveRuntimeProvider maxOutputSize forwarding', () => {
  it('returns alias.maxOutputSize for request completion budgeting', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
            baseUrl: 'https://openai.example/v1',
          },
        },
        models: {
          ...BASE_CONFIG.models!,
          'deepseek-alias': {
            provider: 'openai',
            model: 'deepseek-v4-flash',
            maxContextSize: 1_000_000,
            maxOutputSize: 384000,
          },
        },
      },
      model: 'deepseek-alias',
    });

    expect(resolved.maxOutputSize).toBe(384000);
  });

  it('forwards alias.maxOutputSize to the anthropic provider config as defaultMaxTokens', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'opus-alias': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
            maxOutputSize: 24000,
          },
        },
      },
      model: 'opus-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'claude-opus-4-7',
      defaultMaxTokens: 24000,
    });
  });

  it('omits defaultMaxTokens when alias.maxOutputSize is unset', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'opus-alias': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
          },
        },
      },
      model: 'opus-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'claude-opus-4-7',
    });
    expect('defaultMaxTokens' in resolved.provider).toBe(false);
  });

  it('forwards alias.adaptiveThinking to the anthropic provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'okapi-alias': {
            provider: 'anthropic',
            model: 'coding-model-okapi-0527-vibe',
            maxContextSize: 200000,
            adaptiveThinking: true,
          },
        },
      },
      model: 'okapi-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'coding-model-okapi-0527-vibe',
      adaptiveThinking: true,
    });
  });

  it('forwards alias.supportEfforts to the anthropic provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'compatible-alias': {
            provider: 'anthropic',
            model: 'compatible-model',
            maxContextSize: 200000,
            supportEfforts: ['low', 'high', 'max'],
          },
        },
      },
      model: 'compatible-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'compatible-model',
      supportEfforts: ['low', 'high', 'max'],
    });
  });

  it('forwards alias.betaApi to the anthropic provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'kimi-alias': {
            provider: 'anthropic',
            model: 'kimi-for-coding',
            maxContextSize: 200000,
            protocol: 'anthropic',
            betaApi: true,
          },
        },
      },
      model: 'kimi-alias',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'kimi-for-coding',
      betaApi: true,
    });
  });

  it('omits adaptiveThinking when alias.adaptiveThinking is unset', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          ...BASE_CONFIG.providers,
          anthropic: { type: 'anthropic', apiKey: 'sk-anthropic' },
        },
        models: {
          ...BASE_CONFIG.models!,
          'opus-alias': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            maxContextSize: 200000,
          },
        },
      },
      model: 'opus-alias',
    });

    expect('adaptiveThinking' in resolved.provider).toBe(false);
  });
});

describe('resolveRuntimeProvider Kimi request headers', () => {
  it('does not set defaultHeaders when no kimiRequestHeaders or customHeaders exist', () => {
    const resolved = resolveRuntimeProvider({ config: BASE_CONFIG });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      model: 'kimi-for-coding',
    });
    expect('defaultHeaders' in resolved.provider).toBe(false);
  });

  it('uses only customHeaders when kimiRequestHeaders are missing', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            apiKey: 'test-key',
            baseUrl: 'https://api.example/v1',
            customHeaders: {
              'User-Agent': 'Custom/1',
            },
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      defaultHeaders: {
        'User-Agent': 'Custom/1',
      },
    });
  });

  it('passes kimiRequestHeaders through to Kimi provider defaultHeaders', () => {
    const resolved = resolveRuntimeProvider({
      config: BASE_CONFIG,
      kimiRequestHeaders: TEST_KIMI_HEADERS,
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      defaultHeaders: TEST_KIMI_HEADERS,
    });
  });

  it('passes the prompt cache key to Kimi generation kwargs', () => {
    const resolved = resolveRuntimeProvider({
      config: BASE_CONFIG,
      promptCacheKey: 'session-test',
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
  });

  it('lets provider customHeaders override kimiRequestHeaders', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            apiKey: 'test-key',
            baseUrl: 'https://api.example/v1',
            customHeaders: {
              'User-Agent': 'Custom/1',
              'X-Msh-Version': 'override-version',
            },
          },
        },
      },
      kimiRequestHeaders: TEST_KIMI_HEADERS,
    });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      defaultHeaders: {
        'User-Agent': 'Custom/1',
        'X-Msh-Platform': 'kimi_code_cli',
        'X-Msh-Version': 'override-version',
      },
    });
  });

  it('applies only the User-Agent from kimiRequestHeaders to non-Kimi providers', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gpt-alias',
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
          },
        },
        models: {
          'gpt-alias': {
            provider: 'openai',
            model: 'gpt-runtime',
            maxContextSize: 200000,
          },
        },
      },
      kimiRequestHeaders: TEST_KIMI_HEADERS,
      promptCacheKey: 'session-test',
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-runtime',
      apiKey: 'sk-openai',
      defaultHeaders: {
        'User-Agent': TEST_KIMI_HEADERS['User-Agent'],
      },
    });
    // Device identity headers (`X-Msh-*`) stay Kimi-only — they must not leak
    // to third-party providers.
    const headers = (resolved.provider as { defaultHeaders?: Record<string, string> })
      .defaultHeaders;
    expect(headers).toBeDefined();
    expect('X-Msh-Platform' in headers!).toBe(false);
  });
});

describe('resolveRuntimeProvider customHeaders propagation', () => {
  it('forwards customHeaders to an anthropic provider', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude-alias',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
            customHeaders: { 'X-Custom': 'value' },
          },
        },
        models: {
          'claude-alias': { provider: 'anthropic', model: 'claude-runtime', maxContextSize: 200000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      defaultHeaders: { 'X-Custom': 'value' },
    });
  });

  it('passes the prompt cache key to Anthropic metadata.user_id', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude-alias',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
          },
        },
        models: {
          'claude-alias': { provider: 'anthropic', model: 'claude-runtime', maxContextSize: 200000 },
        },
      },
      promptCacheKey: 'session-test',
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      metadata: { user_id: 'session-test' },
    });
  });

  it('omits Anthropic metadata when no prompt cache key is set', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude-alias',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
          },
        },
        models: {
          'claude-alias': { provider: 'anthropic', model: 'claude-runtime', maxContextSize: 200000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({ type: 'anthropic' });
    expect('metadata' in resolved.provider).toBe(false);
  });

  it('forwards customHeaders to an openai provider', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gpt-alias',
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-openai',
            customHeaders: { 'X-Custom': 'value' },
          },
        },
        models: {
          'gpt-alias': { provider: 'openai', model: 'gpt-runtime', maxContextSize: 200000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      defaultHeaders: { 'X-Custom': 'value' },
    });
  });

  it('forwards customHeaders to an openai_responses provider', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'resp-alias',
        providers: {
          openai_responses: {
            type: 'openai_responses',
            apiKey: 'sk-openai',
            customHeaders: { 'X-Custom': 'value' },
          },
        },
        models: {
          'resp-alias': {
            provider: 'openai_responses',
            model: 'gpt-runtime',
            maxContextSize: 200000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai_responses',
      defaultHeaders: { 'X-Custom': 'value' },
    });
  });

  it('keeps customHeaders isolated between resolved provider instances', () => {
    const config: KimiConfig = {
      defaultModel: 'gpt-alias',
      providers: {
        openai: {
          type: 'openai',
          apiKey: 'sk-openai',
          customHeaders: { 'X-Custom': 'original' },
        },
      },
      models: {
        'gpt-alias': { provider: 'openai', model: 'gpt-runtime', maxContextSize: 200000 },
      },
    };

    const first = resolveRuntimeProvider({ config });
    const second = resolveRuntimeProvider({ config });
    const firstHeaders = (first.provider as { defaultHeaders?: Record<string, string> })
      .defaultHeaders;
    expect(firstHeaders).toEqual({ 'X-Custom': 'original' });

    firstHeaders!['X-Custom'] = 'mutated';

    expect(
      (second.provider as { defaultHeaders?: Record<string, string> }).defaultHeaders,
    ).toEqual({ 'X-Custom': 'original' });
    expect(config.providers['openai']?.customHeaders).toEqual({ 'X-Custom': 'original' });
  });
});

describe('ProviderManager prompt cache key', () => {
  it('applies a prompt cache key to Kimi providers', () => {
    const manager = new ProviderManager({
      config: BASE_CONFIG,
      promptCacheKey: 'session-test',
    });
    const resolved = manager.resolveProviderConfig('kimi-code/kimi-for-coding');

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
  });

  it('applies a prompt cache key to OpenAI providers (chat completions + responses)', () => {
    for (const type of ['openai', 'openai_responses'] as const) {
      const manager = new ProviderManager({
        promptCacheKey: 'session-test',
        config: {
          defaultModel: 'gpt-alias',
          providers: {
            openai: {
              type,
              apiKey: 'sk-openai',
            },
          },
          models: {
            'gpt-alias': {
              provider: 'openai',
              model: 'gpt-runtime',
              maxContextSize: 200000,
            },
          },
        },
      });
      const resolved = manager.resolveProviderConfig('gpt-alias');

      // Same session-affinity intent as the Kimi branch above: every request
      // of the session routes through the same provider-side prompt cache.
      expect(resolved.provider).toMatchObject({
        type,
        model: 'gpt-runtime',
        generationKwargs: {
          prompt_cache_key: 'session-test',
        },
      });
    }
  });

  it('reads the current config when constructed with a function', () => {
    let sharedConfig: KimiConfig = { providers: {} };
    const manager = new ProviderManager({
      config: () => sharedConfig,
      promptCacheKey: 'session-test',
    });

    sharedConfig = BASE_CONFIG;

    const resolved = manager.resolveProviderConfig('kimi-code/kimi-for-coding');
    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
  });
});

describe('ProviderManager OAuth auth', () => {
  function oauthConfig(): KimiConfig {
    return {
      ...BASE_CONFIG,
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          apiKey: '',
          baseUrl: 'https://api.example/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
    };
  }

  it('preserves non-Kimi token fetch failures instead of guessing their category', async () => {
    const tokenError = new Error('token storage permission denied');
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          throw tokenError;
        },
      }),
    });

    const resolveAuth = manager.resolveAuth('kimi-code/kimi-for-coding');
    expect(resolveAuth).toBeDefined();

    await expect(resolveAuth!(async () => 'ok')).rejects.toBe(tokenError);
  });

  it('keeps explicit login-required token failures as login-required errors', async () => {
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          throw new KimiError(ErrorCodes.AUTH_LOGIN_REQUIRED, 'not logged in');
        },
      }),
    });

    const resolveAuth = manager.resolveAuth('kimi-code/kimi-for-coding');
    expect(resolveAuth).toBeDefined();

    await expect(resolveAuth!(async () => 'ok')).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });
});

describe('resolveThinkingEffort', () => {
  const booleanModel: ModelAlias = {
    provider: 'p',
    model: 'm',
    maxContextSize: 1,
    capabilities: ['thinking'],
  };
  const effortModel: ModelAlias = {
    provider: 'p',
    model: 'm',
    maxContextSize: 1,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'medium', 'high'],
  };
  const alwaysThinkingModel: ModelAlias = {
    provider: 'p',
    model: 'm',
    maxContextSize: 1,
    capabilities: ['thinking', 'always_thinking'],
  };

  it('returns the requested effort verbatim when one is provided', () => {
    expect(resolveThinkingEffort('on', { effort: 'medium' }, booleanModel)).toBe('on');
    expect(resolveThinkingEffort('off', { effort: 'medium' }, booleanModel)).toBe('off');
    expect(resolveThinkingEffort('low', { effort: 'medium' }, booleanModel)).toBe('low');
    // No normalization: empty / whitespace strings are returned as-is.
    expect(resolveThinkingEffort('', { enabled: false, effort: 'medium' }, booleanModel)).toBe('');
    expect(resolveThinkingEffort('   ', { enabled: false, effort: 'medium' }, booleanModel)).toBe(
      '   ',
    );
  });

  it('treats config.enabled=false as off when no effort is requested', () => {
    expect(
      resolveThinkingEffort(undefined, { enabled: false, effort: 'medium' }, booleanModel),
    ).toBe('off');
    expect(resolveThinkingEffort(undefined, { enabled: false }, booleanModel)).toBe('off');
  });

  it('uses config.effort as the default effort when enabled', () => {
    expect(resolveThinkingEffort(undefined, { effort: 'medium' }, booleanModel)).toBe('medium');
    expect(resolveThinkingEffort(undefined, { enabled: true, effort: 'medium' }, booleanModel)).toBe(
      'medium',
    );
  });

  it('falls back to the model default effort when no effort is set', () => {
    // boolean thinking model -> 'on'
    expect(resolveThinkingEffort(undefined, {}, booleanModel)).toBe('on');
    // effort-capable model -> middle supportEfforts entry
    expect(resolveThinkingEffort(undefined, {}, effortModel)).toBe('medium');
    // no / non-thinking model -> 'off'
    expect(resolveThinkingEffort(undefined, {}, undefined)).toBe('off');
  });

  it('forces always-thinking models back on even when off is requested', () => {
    expect(resolveThinkingEffort('off', { enabled: false }, alwaysThinkingModel, true)).toBe('on');
    expect(resolveThinkingEffort(undefined, { enabled: false }, alwaysThinkingModel, true)).toBe(
      'on',
    );
  });
});

describe('google base URL forwarding', () => {
  it('forwards base_url to the google-genai provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          gemini: {
            type: 'google-genai',
            apiKey: 'g-key',
            baseUrl: 'https://qianxun.example/v1beta',
          },
        },
        models: {
          gemini: { provider: 'gemini', model: 'gemini-2.5-pro', maxContextSize: 1_000_000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'google-genai',
      model: 'gemini-2.5-pro',
      baseUrl: 'https://qianxun.example/v1beta',
    });
  });

  it('reads GOOGLE_GEMINI_BASE_URL from provider env as a fallback', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          gemini: {
            type: 'google-genai',
            apiKey: 'g-key',
            env: { GOOGLE_GEMINI_BASE_URL: 'https://env.example/v1beta' },
          },
        },
        models: {
          gemini: { provider: 'gemini', model: 'gemini-2.5-pro', maxContextSize: 1_000_000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'google-genai',
      baseUrl: 'https://env.example/v1beta',
    });
  });

  it('forwards a custom proxy base_url to the vertexai provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          vertex: {
            type: 'vertexai',
            apiKey: 'v-key',
            baseUrl: 'https://qianxun.example/vertex',
          },
        },
        models: {
          gemini: { provider: 'vertex', model: 'gemini-1.5-pro', maxContextSize: 1_000_000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'vertexai',
      model: 'gemini-1.5-pro',
      baseUrl: 'https://qianxun.example/vertex',
    });
  });

  it('forwards base_url to vertexai while still deriving location from an aiplatform host', () => {
    // Backward compatibility: an aiplatform host must keep populating `location`
    // (existing GCP behavior) while the base URL is now also forwarded so the
    // SDK targets the configured endpoint verbatim.
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          vertex: {
            type: 'vertexai',
            apiKey: 'v-key',
            baseUrl: 'https://us-central1-aiplatform.googleapis.com',
          },
        },
        models: {
          gemini: { provider: 'vertex', model: 'gemini-1.5-pro', maxContextSize: 1_000_000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'vertexai',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      location: 'us-central1',
    });
  });

  it('derives vertex location from the GOOGLE_VERTEX_BASE_URL env fallback so ADC mode is selected', () => {
    // The env fallback must behave exactly like config `base_url`: when the
    // regional endpoint is supplied via GOOGLE_VERTEX_BASE_URL (with a project
    // but no explicit GOOGLE_CLOUD_LOCATION), location derivation must still see
    // it, so the provider resolves to service-account (ADC) mode rather than
    // silently downgrading to API-key Gemini routing.
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'gemini',
        providers: {
          vertex: {
            type: 'vertexai',
            env: {
              GOOGLE_CLOUD_PROJECT: 'my-proj',
              GOOGLE_VERTEX_BASE_URL: 'https://us-central1-aiplatform.googleapis.com',
            },
          },
        },
        models: {
          gemini: { provider: 'vertex', model: 'gemini-1.5-pro', maxContextSize: 1_000_000 },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'vertexai',
      vertexai: true,
      baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      project: 'my-proj',
      location: 'us-central1',
    });
  });
});

describe('per-model protocol routing', () => {
  it('routes a protocol:anthropic model on a kimi provider through the anthropic transport with the REST base stripped of /v1', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        models: {
          'kimi-code/kimi-for-coding': {
            ...BASE_CONFIG.models!['kimi-code/kimi-for-coding']!,
            protocol: 'anthropic',
          },
        },
      },
    });

    expect(resolved.providerName).toBe('managed:kimi-code');
    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'kimi-for-coding',
      baseUrl: 'https://api.example',
    });
  });

  it('keeps a model without protocol on the provider wire type and leaves the REST base intact', () => {
    const resolved = resolveRuntimeProvider({ config: BASE_CONFIG });

    expect(resolved.provider).toMatchObject({
      type: 'kimi',
      model: 'kimi-for-coding',
      baseUrl: 'https://api.example/v1',
    });
  });

  it('does not strip the baseUrl of a provider that is itself typed anthropic', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'claude',
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'sk-anthropic',
            baseUrl: 'https://api.anthropic.example/v1',
          },
        },
        models: {
          claude: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            maxContextSize: 200_000,
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.example/v1',
    });
  });
});

describe('resolveRuntimeProvider model overrides', () => {
  it('keeps supportEfforts out of the kimi provider config', () => {
    const resolved = resolveRuntimeProvider({
      config: {
        ...BASE_CONFIG,
        models: {
          'kimi-code/kimi-for-coding': {
            ...BASE_CONFIG.models!['kimi-code/kimi-for-coding']!,
            supportEfforts: ['low', 'high', 'max'],
            overrides: { supportEfforts: ['low', 'high'] },
          },
        },
      },
    });

    expect(resolved.provider).toMatchObject({ type: 'kimi' });
    expect(resolved.provider).not.toHaveProperty('supportEfforts');
  });
});
