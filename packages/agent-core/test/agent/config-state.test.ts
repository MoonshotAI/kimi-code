import { describe, expect, it, vi } from 'vitest';
import { emptyUsage } from '@moonshot-ai/kosong';

import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { ProviderManager } from '../../src/session/provider-manager';
import {
  applyEnvModelConfig,
  ENV_MODEL_ALIAS_KEY,
  getDefaultConfig,
  type KimiConfig,
} from '../../src/config';
import { testAgent } from './harness';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

describe('ConfigState model capabilities', () => {
  it('updates the agent cwd without requiring the directory to exist', () => {
    const chdir = vi.fn(async () => {
      throw Object.assign(new Error('missing workspace'), { code: 'ENOENT' });
    });
    const ctx = testAgent({
      kaos: createFakeKaos({
        getcwd: () => '/workspace',
        chdir,
      }),
    });

    ctx.agent.config.update({ cwd: '/tmp/missing-workdir' });

    expect(ctx.agent.config.cwd).toBe('/tmp/missing-workdir');
    expect(ctx.agent.kaos.getcwd()).toBe('/tmp/missing-workdir');
    expect(chdir).not.toHaveBeenCalled();
  });

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

  it('warns and sends when an Anthropic effort is not listed by the model', async () => {
    let requests = 0;
    const config: KimiConfig = {
      providers: {
        compatible: {
          type: 'kimi',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.test',
        },
      },
      models: {
        compatible: {
          provider: 'compatible',
          model: 'compatible-model',
          protocol: 'anthropic',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['max'],
        },
      },
    };
    const ctx = testAgent({
      initialConfig: config,
      providerManager: new ProviderManager({ config }),
      generate: async (provider) => {
        requests += 1;
        expect(provider.thinkingEffort).toBe('high');
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
    });
    ctx.agent.config.update({
      modelAlias: 'compatible',
      systemPrompt: 'system',
    });
    ctx.agent.config.setThinkingEffort('high');

    await ctx.agent.llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(requests).toBe(1);
    expect(ctx.allEvents).toContainEqual({
      type: '[rpc]',
      event: 'warning',
      args: {
        code: 'anthropic-thinking-effort-not-listed',
        message:
          'Thinking effort "high" is not listed for model "compatible-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
      },
    });
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
        'kimi-code/ultra': {
          provider: 'kimi',
          model: 'kimi-ultra',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high', 'ultra'],
          defaultEffort: 'ultra',
        },
        'kimi-code/standard': {
          provider: 'kimi',
          model: 'kimi-standard',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'mid', 'high'],
          defaultEffort: 'mid',
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

  it('falls back to the target default when a model switch carries an unsupported effort', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/ultra', thinkingEffort: 'ultra' });

    ctx.agent.config.update({ modelAlias: 'kimi-code/standard' });

    expect(ctx.agent.config.thinkingEffort).toBe('mid');
  });

  it('projects an inherited concrete effort to on when switching to a boolean model', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/ultra', thinkingEffort: 'ultra' });

    ctx.agent.config.update({ modelAlias: 'kimi-code/toggle' });

    expect(ctx.agent.config.thinkingEffort).toBe('on');
  });

  it('rejects an unsupported effort explicitly set on the current Kimi model', () => {
    const ctx = alwaysThinkingAgent();
    ctx.agent.config.update({ modelAlias: 'kimi-code/standard' });

    expect(() => {
      ctx.agent.config.setThinkingEffort('ultra');
    }).toThrow(
      'Thinking effort "ultra" is not supported by model "kimi-code/standard"',
    );
  });
});

describe('ConfigState.provider applies global KIMI_MODEL_* request config', () => {
  function kimiAgent() {
    const config: KimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
      models: {
        'kimi-code': {
          provider: 'kimi',
          model: 'kimi-code',
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

  // The same config backs both the ProviderManager (provider resolution) and
  // the agent's kimiConfig (where ConfigState reads thinking.keep).
  function kimiAgentWithThinkingKeep(keep: string | undefined) {
    const config: KimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
      models: {
        'kimi-code': {
          provider: 'kimi',
          model: 'kimi-code',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
        },
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

  it('keeps the forced Kimi effort synchronized between state and provider', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const ctx = kimiAgent();
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      const provider = ctx.agent.config.provider;
      const gen = Reflect.get(provider as object, '_generationKwargs') as {
        extra_body?: { thinking?: { type?: string; effort?: string } };
      };
      expect(ctx.agent.config.data().thinkingEffort).toBe('max');
      expect(provider.thinkingEffort).toBe('max');
      expect(gen.extra_body?.thinking).toMatchObject({ type: 'enabled', effort: 'max' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports the forced effort for an env-synthesized boolean Kimi model', () => {
    vi.stubEnv('KIMI_MODEL_NAME', 'kimi-for-coding');
    vi.stubEnv('KIMI_MODEL_API_KEY', 'test-key');
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const config = applyEnvModelConfig(getDefaultConfig());
      const persistence = new InMemoryAgentRecordPersistence();
      const ctx = testAgent({
        initialConfig: config,
        persistence,
        providerManager: new ProviderManager({ config }),
      });

      ctx.agent.config.update({ modelAlias: ENV_MODEL_ALIAS_KEY });

      expect(ctx.agent.config.data().thinkingEffort).toBe('max');
      expect(persistence.records).toContainEqual(
        expect.objectContaining({ type: 'config.update', thinkingEffort: 'max' }),
      );
      expect(ctx.agent.config.provider.thinkingEffort).toBe('max');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('applies the Kimi force through an Anthropic protocol override', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const config: KimiConfig = {
        providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
        models: {
          'kimi-code-anthropic': {
            provider: 'kimi',
            protocol: 'anthropic',
            model: 'kimi-code',
            maxContextSize: 128_000,
            capabilities: ['thinking'],
          },
        },
      };
      const ctx = testAgent({
        initialConfig: config,
        providerManager: new ProviderManager({ config }),
      });

      ctx.agent.config.update({
        modelAlias: 'kimi-code-anthropic',
        thinkingEffort: 'high',
      });

      expect(ctx.agent.config.data().thinkingEffort).toBe('max');
      expect(ctx.agent.config.provider.thinkingEffort).toBe('max');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not carry the Kimi force into a non-Kimi model switch', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const config: KimiConfig = {
        providers: {
          kimi: { type: 'kimi', apiKey: 'test-key' },
          anthropic: { type: 'anthropic', apiKey: 'test-key' },
        },
        models: {
          'kimi-code': {
            provider: 'kimi',
            model: 'kimi-code',
            maxContextSize: 128_000,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
          },
          claude: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            maxContextSize: 200_000,
            capabilities: ['thinking'],
          },
        },
      };
      const ctx = testAgent({
        initialConfig: config,
        providerManager: new ProviderManager({ config }),
      });
      ctx.agent.config.update({ modelAlias: 'kimi-code', thinkingEffort: 'high' });

      ctx.agent.config.update({ modelAlias: 'claude' });

      expect(ctx.agent.config.data().thinkingEffort).toBe('high');
      expect(ctx.agent.config.provider.thinkingEffort).toBe('high');
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
      expect(ctx.agent.config.data().thinkingEffort).toBe('off');
      expect(provider.thinkingEffort).toBe('off');
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

describe('ConfigState.provider memo (reasoning dialect survives turns)', () => {
  function kimiAgentWithTwoModels() {
    const config: KimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
      models: {
        'kimi-code': { provider: 'kimi', model: 'kimi-code', maxContextSize: 128_000 },
        'kimi-code-2': { provider: 'kimi', model: 'kimi-code-2', maxContextSize: 128_000 },
      },
    };
    return testAgent({
      initialConfig: config,
      providerManager: new ProviderManager({ config }),
    });
  }

  it('shares the reasoning-dialect cell across repeated accesses with unchanged config', () => {
    const ctx = kimiAgentWithTwoModels();
    ctx.agent.config.update({ modelAlias: 'kimi-code' });

    const first = ctx.agent.config.provider;
    const second = ctx.agent.config.provider;

    // Each access returns a fresh morph clone, but the clones share the
    // dialect cell learned from inbound responses — without the memo, the
    // dialect detected on one turn would be lost before the next request.
    expect(first).not.toBe(second);
    expect(Reflect.get(first as object, '_reasoningKeyDialect')).toBe(
      Reflect.get(second as object, '_reasoningKeyDialect'),
    );
  });

  it('rebuilds the base provider (fresh dialect cell) when the resolved config changes', () => {
    const ctx = kimiAgentWithTwoModels();
    ctx.agent.config.update({ modelAlias: 'kimi-code' });
    const before = ctx.agent.config.provider;

    ctx.agent.config.update({ modelAlias: 'kimi-code-2' });
    const after = ctx.agent.config.provider;

    expect(Reflect.get(after as object, '_reasoningKeyDialect')).not.toBe(
      Reflect.get(before as object, '_reasoningKeyDialect'),
    );
  });
});
