import { describe, expect, it } from 'vitest';
import { emptyUsage } from '@moonshot-ai/kosong';

import { KIMI_NOW_PLACEHOLDER } from '../../src/profile';
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

describe('ConfigState systemPrompt KIMI_NOW placeholder', () => {
  function makeAgent(): ReturnType<typeof testAgent> {
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

  it('substitutes the KIMI_NOW placeholder with the current ISO timestamp on read', () => {
    const ctx = makeAgent();
    ctx.agent.config.update({
      systemPrompt: `Hello at ${KIMI_NOW_PLACEHOLDER} world`,
    });

    const before = Date.now();
    const out = ctx.agent.config.systemPrompt;
    const after = Date.now();

    expect(out).not.toContain(KIMI_NOW_PLACEHOLDER);
    const match = /Hello at (.+) world/.exec(out);
    expect(match).not.toBeNull();
    const substitutedIso = match![1]!;
    const substitutedMs = Date.parse(substitutedIso);
    expect(Number.isFinite(substitutedMs)).toBe(true);
    // Allow a 1s window for the wall clock to drift between sampling.
    expect(substitutedMs).toBeGreaterThanOrEqual(before - 1000);
    expect(substitutedMs).toBeLessThanOrEqual(after + 1000);
  });

  it('returns a fresh timestamp on each read (lazy, not cached)', async () => {
    const ctx = makeAgent();
    ctx.agent.config.update({
      systemPrompt: `now=${KIMI_NOW_PLACEHOLDER}`,
    });
    const first = ctx.agent.config.systemPrompt;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = ctx.agent.config.systemPrompt;

    // Both reads should produce a valid ISO timestamp, and the second
    // must be strictly after the first (proves the getter is live).
    const firstIso = /now=(.+)/.exec(first)![1]!;
    const secondIso = /now=(.+)/.exec(second)![1]!;
    expect(Date.parse(secondIso)).toBeGreaterThan(Date.parse(firstIso));
  });

  it('passes through systemPrompts that do not contain the placeholder unchanged', () => {
    const ctx = makeAgent();
    ctx.agent.config.update({
      systemPrompt: 'Static prompt at 2026-05-08T00:00:00Z',
    });

    expect(ctx.agent.config.systemPrompt).toBe('Static prompt at 2026-05-08T00:00:00Z');
  });

  it('substitutes every occurrence (multiple placeholders within one prompt)', () => {
    const ctx = makeAgent();
    ctx.agent.config.update({
      systemPrompt: `a=${KIMI_NOW_PLACEHOLDER} b=${KIMI_NOW_PLACEHOLDER}`,
    });

    const out = ctx.agent.config.systemPrompt;
    expect(out).not.toContain(KIMI_NOW_PLACEHOLDER);
    const match = /a=(.+) b=(.+)/.exec(out);
    expect(match).not.toBeNull();
    // Both substitutions share the same Date instance, so they match exactly.
    expect(match![1]).toBe(match![2]);
  });
});
