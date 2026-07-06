import { describe, expect, it, vi } from 'vitest';
import { emptyUsage } from '@moonshot-ai/kosong';

import { ProviderManager } from '../../src/session/provider-manager';
import type { KimiConfig } from '../../src/config';
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
      thinkingEffort: 'off',
    });
    await ctx.agent.llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    // maxOutputSize (384000) is clamped to the 128k ceiling applied to
    // non-Kimi chat-completions providers.
    expect(requestMaxTokens).toBe(131072);
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
    // The always_thinking clamp in ConfigState.update() reads the model from
    // `agent.kimiConfig.models`, so the same config must back both the
    // ProviderManager (provider resolution) and the agent's kimiConfig (the
    // clamp's model lookup).
    const config: KimiConfig = {
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
    };
    return testAgent({
      initialConfig: config,
      providerManager: new ProviderManager({ config }),
    });
  }

  it('clamps thinkingEffort off to the model default effort', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/deep', thinkingEffort: 'off' });

    // boolean always-thinking model (no supportEfforts) defaults to 'on'.
    expect(ctx.agent.config.thinkingEffort).toBe('on');
  });

  it('builds the provider with thinking enabled even after thinking was set off', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/deep', thinkingEffort: 'off' });

    const provider = ctx.agent.config.provider;
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { type?: unknown } };
    };
    expect(gen.extra_body?.thinking?.type).toBe('enabled');
  });

  it('keeps thinking off working for toggleable models', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/toggle', thinkingEffort: 'off' });

    expect(ctx.agent.config.thinkingEffort).toBe('off');
  });

  it('re-clamps a stale off when switching onto an always-thinking model', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/toggle', thinkingEffort: 'off' });
    expect(ctx.agent.config.thinkingEffort).toBe('off');

    // A bare model switch re-applies the always_thinking clamp against the new
    // model, so the previously stored 'off' is clamped back to the default.
    ctx.agent.config.update({ modelAlias: 'kimi-code/deep' });
    expect(ctx.agent.config.thinkingEffort).toBe('on');
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

  // The same config backs both the ProviderManager (provider resolution) and
  // the agent's kimiConfig (where ConfigState reads thinking.keep).
  function kimiAgentWithThinkingKeep(keep: string | undefined) {
    const config: KimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
      models: {
        'kimi-code': { provider: 'kimi', model: 'kimi-code', maxContextSize: 128_000 },
      },
      ...(keep !== undefined ? { thinking: { keep } } : {}),
    };
    return testAgent({
      initialConfig: config,
      providerManager: new ProviderManager({ config }),
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
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

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
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'off' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('injects thinking.keep="all" into config.provider by default (no env, no config)', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', '');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBe('all');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('config thinking.keep="off" disables keep by default', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', '');
    try {
      const ctx = kimiAgentWithThinkingKeep('off');
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      const gen = Reflect.get(ctx.agent.config.provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('env off-value overrides config thinking.keep="all"', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'off');
    try {
      const ctx = kimiAgentWithThinkingKeep('all');
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      const gen = Reflect.get(ctx.agent.config.provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('env="all" overrides config thinking.keep="off"', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = kimiAgentWithThinkingKeep('off');
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      const gen = Reflect.get(ctx.agent.config.provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { keep?: unknown } };
      };
      expect(gen.extra_body?.thinking?.keep).toBe('all');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('injects KIMI_MODEL_THINKING_EFFORT into config.provider when thinking is on', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { type?: string; effort?: string } };
      };
      expect(gen.extra_body?.thinking).toMatchObject({ type: 'enabled', effort: 'max' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does NOT inject KIMI_MODEL_THINKING_EFFORT into config.provider when thinking is off', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'off' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { effort?: string } };
      };
      expect(gen.extra_body?.thinking?.effort).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  function anthropicAgentWithThinkingKeep(keep: string | undefined) {
    const config: KimiConfig = {
      providers: { anthropic: { type: 'anthropic', apiKey: 'test-key' } },
      models: {
        'claude-sonnet-4-6': {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          maxContextSize: 200_000,
          capabilities: ['thinking', 'tool_use'],
        },
      },
      ...(keep !== undefined ? { thinking: { keep } } : {}),
    };
    return testAgent({
      initialConfig: config,
      providerManager: new ProviderManager({ config }),
    });
  }

  it('injects context_management clear_thinking keep into config.provider for anthropic when thinking is on', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = anthropicAgentWithThinkingKeep(undefined);
      ctx.agent.config.update({ modelAlias: 'claude-sonnet-4-6', thinkingEffort: 'high' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        contextManagement?: { edits: Array<{ type: string; keep?: string }> };
        betaFeatures?: string[];
      };
      expect(gen.contextManagement).toEqual({
        edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
      });
      expect(gen.betaFeatures).toContain('context-management-2025-06-27');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does NOT inject context_management for anthropic when thinking is off', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    try {
      const ctx = anthropicAgentWithThinkingKeep(undefined);
      ctx.agent.config.update({ modelAlias: 'claude-sonnet-4-6', thinkingEffort: 'off' });

      const gen = Reflect.get(ctx.agent.config.provider as object, '_generationKwargs') as {
        contextManagement?: unknown;
      };
      expect(gen.contextManagement).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
