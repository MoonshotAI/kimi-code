import { emptyUsage } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ILLMRequester } from '#/llmRequester';
import { IProfileService } from '#/profile';
import {
  configServices,
  createTestAgent,
  llmGenerateServices,
  modelProviderOptionServices,
  type TestAgentContext,
} from '../harness';

type TestKimiConfig = ReturnType<Parameters<typeof configServices>[0]>;
type GenerateFn = Parameters<typeof llmGenerateServices>[0];

function defaultGenerate(): ReturnType<GenerateFn> {
  throw new Error('generate should not be called');
}

describe('ConfigState model capabilities', () => {
  let ctx: TestAgentContext;
  let profile: IProfileService;
  let requester: ILLMRequester;
  let kimiConfig: TestKimiConfig;
  let generate: GenerateFn;

  beforeEach(() => {
    kimiConfig = {
      providers: {},
    };
    generate = defaultGenerate;
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      llmGenerateServices((...args) => generate(...args)),
    );
    profile = ctx.get(IProfileService);
    requester = ctx.get(ILLMRequester);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('computes provider and model capabilities from config metadata', () => {
    kimiConfig = {
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
    };

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
    kimiConfig = {
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
    };

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
    kimiConfig = {
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
          maxOutputSize: 384_000,
        },
      },
    };
    generate = async (provider) => {
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
    };

    profile.update({
      modelAlias: 'deepseek/deepseek-v4-flash',
      systemPrompt: 'system',
      thinkingLevel: 'off',
    });
    for await (const _ of requester.request({}, new AbortController().signal)) {
      // consume to trigger generate
    }

    expect(requestMaxTokens).toBe(384000);
  });
});

describe('ConfigState prompt cache hint', () => {
  let ctx: TestAgentContext;
  let profile: IProfileService;
  let kimiConfig: TestKimiConfig;

  beforeEach(() => {
    kimiConfig = {
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
    };
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      modelProviderOptionServices({ promptCacheKey: 'session-test' }),
    );
    profile = ctx.get(IProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('uses session id as a provider prompt cache hint without storing it on Agent', () => {
    profile.update({ modelAlias: 'kimi-code' });

    expect(profile.data().provider).toMatchObject({
      type: 'kimi',
      generationKwargs: {
        prompt_cache_key: 'session-test',
      },
    });
    expect('sessionId' in ctx).toBe(false);
  });
});

describe('ConfigState thinking clamp for always-thinking models', () => {
  let ctx: TestAgentContext;
  let profile: IProfileService;
  let kimiConfig: TestKimiConfig;

  beforeEach(() => {
    kimiConfig = {
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
    ctx = createTestAgent(configServices(() => kimiConfig));
    profile = ctx.get(IProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('clamps thinkingLevel off to the configured effort', () => {
    profile.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    expect(profile.data().thinkingLevel).toBe('high');
  });

  it('builds the provider with thinking enabled even after thinking was set off', () => {
    profile.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    const provider = profile.getProvider();
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { type?: unknown } };
    };
    expect(gen.extra_body?.thinking?.type).toBe('enabled');
  });

  it('keeps thinking off working for toggleable models', () => {
    profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });

    expect(profile.data().thinkingLevel).toBe('off');
  });

  it('re-clamps when switching to an always-on model after thinking was off', () => {
    profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });
    expect(profile.data().thinkingLevel).toBe('off');

    profile.update({ modelAlias: 'kimi-code/deep' });
    expect(profile.data().thinkingLevel).toBe('high');
  });
});

describe('ConfigState.provider applies global KIMI_MODEL_* request config', () => {
  let ctx: TestAgentContext | undefined;
  let profile: IProfileService;
  let kimiConfig: TestKimiConfig;

  beforeEach(() => {
    kimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key' } },
      models: {
        'kimi-code': { provider: 'kimi', model: 'kimi-code', maxContextSize: 128_000 },
      },
    };
  });

  afterEach(async () => {
    try {
      await ctx?.expectResumeMatches();
    } finally {
      await ctx?.dispose();
      ctx = undefined;
      vi.unstubAllEnvs();
    }
  });

  function createAgentWithEnv(): void {
    ctx = createTestAgent(configServices(() => kimiConfig));
    profile = ctx.get(IProfileService);
  }

  it('injects KIMI_MODEL_TEMPERATURE into config.provider (the provider compaction also uses)', () => {
    vi.stubEnv('KIMI_MODEL_TEMPERATURE', '0.3');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code' });

    const provider = profile.getProvider();
    expect(Reflect.get(provider as object, '_generationKwargs')).toMatchObject({
      temperature: 0.3,
    });
  });

  it('injects KIMI_MODEL_THINKING_KEEP into config.provider when thinking is on (so compaction keeps it)', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    const provider = profile.getProvider();
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { keep?: unknown } };
    };
    expect(gen.extra_body?.thinking?.keep).toBe('all');
  });

  it('does NOT inject thinking.keep into config.provider when thinking is off', () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });

    const provider = profile.getProvider();
    const gen = Reflect.get(provider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { keep?: unknown } };
    };
    expect(gen.extra_body?.thinking?.keep).toBeUndefined();
  });
});
