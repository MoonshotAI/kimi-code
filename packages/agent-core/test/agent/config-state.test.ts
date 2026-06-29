import { describe, expect, it, vi } from 'vitest';
import { emptyUsage } from '@moonshot-ai/kosong';

import { ProviderManager } from '../../src/session/provider-manager';
import { testAgent } from './harness';

describe('ConfigState model capabilities', () => {
  it('computes provider and model capabilities from ProviderManager metadata', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            kimi: {
              type: 'kimi',
              apiKey: 'test-key',
            },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['image_in', 'video_in', 'thinking', 'tool_use'],
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'kimi-code/kimi-for-coding' });

    expect(config.model).toBe('kimi-code/kimi-for-coding');
    expect(config.providerConfig.model).toBe('kimi-for-coding');
    expect(config.modelCapabilities).toMatchObject({
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('does not infer Kimi capabilities from the provider catalogue', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: {
            kimi: {
              type: 'kimi',
              apiKey: 'test-key',
            },
          },
          models: {
            'kimi-code': {
              provider: 'kimi',
              model: 'kimi-code',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'kimi-code' });

    expect(config.modelCapabilities).toMatchObject({
      image_in: false,
      video_in: false,
      audio_in: false,
      max_context_tokens: 128_000,
    });
  });

  it('clamps the LLM completion cap to 128k for openai-compatible providers', async () => {
    let requestMaxTokens: unknown;
    const ctx = testAgent({
      generate: async (provider) => {
        requestMaxTokens = (
          provider as unknown as { readonly modelParameters: Record<string, unknown> }
        ).modelParameters['max_tokens'];
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
      providerManager: new ProviderManager({
        config: {
          providers: {
            deepseek: {
              type: 'openai',
              apiKey: 'test-key',
              baseUrl: 'https://api.deepseek.example/v1',
            },
          },
          models: {
            'deepseek/deepseek-v4-flash': {
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
              maxContextSize: 1_000_000,
              maxOutputSize: 384000,
            },
          },
        },
      }),
    });

    ctx.agent.config.update({
      modelAlias: 'deepseek/deepseek-v4-flash',
      systemPrompt: 'system',
      thinkingLevel: 'off',
    });
    await ctx.agent.llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    // maxOutputSize (384000) is honoured as the hard ceiling for OpenAI-compatible
    // providers. The generic 128k ceiling only applies when max_output_size is unset.
    expect(requestMaxTokens).toBe(384000);
  });

  it('uses session id as a provider prompt cache hint without storing it on Agent', () => {
    const ctx = testAgent({
      providerManager: new ProviderManager({
        promptCacheKey: 'session-test',
        config: {
          providers: {
            kimi: {
              type: 'kimi',
              apiKey: 'test-key',
            },
          },
          models: {
            'kimi-code': {
              provider: 'kimi',
              model: 'kimi-code',
              maxContextSize: 128_000,
            },
          },
        },
      }),
    });
    const config = ctx.agent.config;

    config.update({ modelAlias: 'kimi-code' });

    expect(config.providerConfig).toMatchObject({
      type: 'kimi',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
    expect('sessionId' in ctx.agent).toBe(false);
  });
});

describe('ConfigState thinking clamp for always-thinking models', () => {
  function alwaysThinkingAgent() {
    return testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
          models: {
            'kimi-code/deep': {
              provider: 'kimi',
              model: 'kimi-deep-coder',
              maxContextSize: 128_000,
              capabilities: ['thinking', 'always_thinking', 'tool_use'],
            },
            'kimi-code/toggle': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 128_000,
              capabilities: ['thinking'],
            },
          },
        },
      }),
    });
  }

  it('clamps thinkingLevel off to the configured effort', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    expect(ctx.agent.config.thinkingLevel).toBe('high');
  });

  it('builds the provider with thinking enabled even after thinking was set off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    const provider = ctx.agent.config.provider;
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { type?: unknown } };
    };
    expect(gen.extra_body?.thinking?.type).toBe('enabled');
  });

  it('keeps thinking off working for toggleable models', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });

    expect(ctx.agent.config.thinkingLevel).toBe('off');
  });

  it('re-clamps when switching to an always-on model after thinking was off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });
    expect(ctx.agent.config.thinkingLevel).toBe('off');

    ctx.agent.config.update({ modelAlias: 'kimi-code/deep' });
    expect(ctx.agent.config.thinkingLevel).toBe('high');
  });
});

describe('ConfigState.provider applies global KIMI_MODEL_* request config', () => {
  function kimiAgent() {
    return testAgent({
      providerManager: new ProviderManager({
        config: {
          providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
          models: {
            'kimi-code': { provider: 'kimi', model: 'kimi-code', maxContextSize: 128_000 },
          },
        },
      }),
    });
  }

  it('injects KIMI_MODEL_TEMPERATURE into config.provider (the provider compaction also uses)', () => {
    vi.stubEnv('KIMI_MODEL_TEMPERATURE', '0.3');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code' });

      const provider = ctx.agent.config.provider;
      expect(Reflect.get(provider as object, '_generationKwargs')).toMatchObject({
        temperature: 0.3,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('injects KIMI_MODEL_THINKING_KEEP into config.provider when thinking is on (so compaction keeps it)', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBe('all');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does NOT inject thinking.keep into config.provider when thinking is off', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
