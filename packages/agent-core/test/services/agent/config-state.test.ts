import { describe, expect, it, vi } from 'vitest';
import { emptyUsage } from '@moonshot-ai/kosong';

import { ProviderManager } from '../../../src/session/provider-manager';
import { ILLMRequester } from '../../../src/services/agent';
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
    const profile = ctx.profile;

    profile.update({ modelAlias: 'kimi-code/kimi-for-coding' });

    expect(profile.getModel()).toBe('kimi-code/kimi-for-coding');
    expect(profile.data().provider?.model).toBe('kimi-for-coding');
    expect(profile.getModelCapabilities()).toMatchObject({
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
    const profile = ctx.profile;

    profile.update({ modelAlias: 'kimi-code' });

    expect(profile.getModelCapabilities()).toMatchObject({
      image_in: false,
      video_in: false,
      audio_in: false,
      max_context_tokens: 128_000,
    });
  });

  it('uses model max output size as the LLM completion cap', async () => {
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

    ctx.profile.update({
      modelAlias: 'deepseek/deepseek-v4-flash',
      systemPrompt: 'system',
      thinkingLevel: 'off',
    });
    const requester = ctx.get(ILLMRequester);
    for await (const _ of requester.request({}, new AbortController().signal)) {
      // consume to trigger generate
    }

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
    const profile = ctx.profile;

    profile.update({ modelAlias: 'kimi-code' });

    expect(profile.data().provider).toMatchObject({
      type: 'kimi',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
    expect('sessionId' in ctx.runtime).toBe(false);
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
    ctx.profile.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    expect(ctx.profile.data().thinkingLevel).toBe('high');
  });

  it('builds the provider with thinking enabled even after thinking was set off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.profile.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    const provider = ctx.profile.getProvider();
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { type?: unknown } };
    };
    expect(gen.extra_body?.thinking?.type).toBe('enabled');
  });

  it('keeps thinking off working for toggleable models', () => {
    const ctx = alwaysThinkingAgent();
    ctx.profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });

    expect(ctx.profile.data().thinkingLevel).toBe('off');
  });

  it('re-clamps when switching to an always-on model after thinking was off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });
    expect(ctx.profile.data().thinkingLevel).toBe('off');

    ctx.profile.update({ modelAlias: 'kimi-code/deep' });
    expect(ctx.profile.data().thinkingLevel).toBe('high');
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
      ctx.profile.update({ modelAlias: 'kimi-code' });

      const provider = ctx.profile.getProvider();
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
      ctx.profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

      const provider = ctx.profile.getProvider();
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
      ctx.profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });

      const provider = ctx.profile.getProvider();
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
