import { describe, expect, it } from 'vitest';
import { emptyUsage } from '@moonshot-ai/kosong';

import { ProviderManager } from '../../src/session/provider-manager';
import { testAgent } from './harness';
import type { GenerateFn } from '../../src/agent/turn/kosong-llm';

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

  it('applies model max output size to OpenAI-compatible providers', async () => {
    let generatedModelParameters: Record<string, unknown> | undefined;
    const generate: GenerateFn = async (chat) => {
      generatedModelParameters = (
        chat as { readonly modelParameters?: Record<string, unknown> }
      ).modelParameters;
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const ctx = testAgent({
      generate,
      providerManager: new ProviderManager({
        config: {
          providers: {
            openai: {
              type: 'openai',
              apiKey: 'sk-openai',
              baseUrl: 'https://openai.example/v1',
            },
          },
          models: {
            'gpt-alias': {
              provider: 'openai',
              model: 'gpt-runtime',
              maxContextSize: 1_000_000,
              maxOutputSize: 8192,
            },
          },
        },
      }),
    });

    ctx.agent.config.update({ modelAlias: 'gpt-alias' });

    await ctx.agent.llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(generatedModelParameters).toMatchObject({ max_tokens: 8192 });
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
