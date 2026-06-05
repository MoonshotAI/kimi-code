import { describe, expect, it } from 'vitest';

import type { KimiConfig } from '../../src/config';
import { ErrorCodes, KimiError } from '../../src/errors';
import { ProviderManager } from '../../src/session/provider-manager';
import { resolveThinkingLevel } from '../../src/agent/config/thinking';

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

  it('does not apply kimiRequestHeaders to non-Kimi providers', () => {
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
    });
    expect('defaultHeaders' in resolved.provider).toBe(false);
    expect('generationKwargs' in resolved.provider).toBe(false);
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

  it('does not add generation kwargs to non-Kimi providers', () => {
    const manager = new ProviderManager({
      promptCacheKey: 'session-test',
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
    });
    const resolved = manager.resolveProviderConfig('gpt-alias');

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-runtime',
    });
    expect('generationKwargs' in resolved.provider).toBe(false);
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

describe('resolveThinkingLevel', () => {
  it('normalizes requested thinking into a concrete effort', () => {
    expect(
      resolveThinkingLevel('on', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('medium');
    expect(
      resolveThinkingLevel('off', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('low', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('low');
    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('   ', {
        defaultThinking: false,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('off');

    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('medium');
    expect(
      resolveThinkingLevel('   ', {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'auto' },
      }),
    ).toBe('medium');

    expect(
      resolveThinkingLevel('on', {
        defaultThinking: true,
        thinking: { mode: 'auto' },
      }),
    ).toBe('high');
    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: true,
        thinking: { mode: 'auto' },
      }),
    ).toBe('high');

    expect(
      resolveThinkingLevel(undefined, {
        thinking: { mode: 'off' },
      }),
    ).toBe('off');

    expect(
      resolveThinkingLevel(undefined, {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'off' },
      }),
    ).toBe('off');
    expect(
      resolveThinkingLevel('   ', {
        defaultThinking: true,
        thinking: { effort: 'medium', mode: 'off' },
      }),
    ).toBe('off');

    expect(resolveThinkingLevel(undefined, {})).toBe('high');
  });
});
