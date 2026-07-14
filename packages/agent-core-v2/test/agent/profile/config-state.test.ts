import { emptyUsage } from '#/app/llmProtocol/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  configServices,
  createTestAgent,
  llmGenerateServices,
  modelProviderOptionServices,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

type TestKimiConfig = ReturnType<Parameters<typeof configServices>[0]>;
type GenerateFn = Parameters<typeof llmGenerateServices>[0];

function defaultGenerate(): ReturnType<GenerateFn> {
  throw new Error('generate should not be called');
}

describe('ConfigState model capabilities', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let requester: IAgentLLMRequesterService;
  let kimiConfig: TestKimiConfig;
  let generate: GenerateFn;
  let records: TelemetryRecord[];

  beforeEach(() => {
    kimiConfig = {
      providers: {},
    };
    generate = defaultGenerate;
    records = [];
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      llmGenerateServices((...args) => generate(...args)),
      telemetryServices(recordingTelemetry(records)),
    );
    profile = ctx.get(IAgentProfileService);
    requester = ctx.get(IAgentLLMRequesterService);
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
          baseUrl: 'https://api.example.test/v1',
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
    expect(profile.resolveModel()?.name).toBe('kimi-for-coding');
    expect(profile.getModelCapabilities()).toMatchObject({
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    });
  });

  it('tracks thinking_toggle with the effort payload when effort changes', () => {
    kimiConfig = {
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.test/v1',
        },
      },
      models: {
        'kimi-code/kimi-for-coding': {
          provider: 'kimi',
          model: 'kimi-for-coding',
          maxContextSize: 1_000_000,
        },
      },
    };
    profile.update({ modelAlias: 'kimi-code/kimi-for-coding' });
    profile.setThinking('off');
    records.length = 0;

    profile.setThinking('low');

    expect(records).toContainEqual({
      event: 'thinking_toggle',
      properties: { enabled: true, effort: 'low', from: 'off' },
    });
  });

  it('does not infer Kimi capabilities from the provider catalogue', () => {
    kimiConfig = {
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.test/v1',
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
    await requester.request({}, undefined, new AbortController().signal);

    expect(requestMaxTokens).toBe(384000);
  });
});

describe('ConfigState prompt cache hint', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let kimiConfig: TestKimiConfig;

  beforeEach(() => {
    kimiConfig = {
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.test/v1',
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
    profile = ctx.get(IAgentProfileService);
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

    expect(profile.resolveModel()?.protocol).toBe('kimi');
    expect('sessionId' in ctx).toBe(false);
  });
});

describe('ConfigState thinking clamp for always-thinking models', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let requester: IAgentLLMRequesterService;
  let kimiConfig: TestKimiConfig;
  let capturedProvider: unknown;

  beforeEach(() => {
    kimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
      models: {
        'kimi-code/deep': {
          provider: 'kimi',
          model: 'kimi-deep-coder',
          maxContextSize: 128_000,
          capabilities: ['thinking', 'always_thinking', 'tool_use'],
          supportEfforts: ['low', 'high', 'max'],
        },
        'kimi-code/toggle': {
          provider: 'kimi',
          model: 'kimi-for-coding',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
        },
        'kimi-code/custom': {
          provider: 'kimi',
          model: 'kimi-custom-coder',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'medium', 'max'],
          defaultEffort: 'max',
        },
      },
    };
    capturedProvider = undefined;
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      llmGenerateServices(async (provider) => {
        capturedProvider = provider;
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );
    profile = ctx.get(IAgentProfileService);
    requester = ctx.get(IAgentLLMRequesterService);
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

  it('builds the provider with thinking enabled even after thinking was set off', async () => {
    profile.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    await requester.request({}, undefined, new AbortController().signal);

    const gen = Reflect.get(capturedProvider as object, '_generationKwargs') as {
      extra_body?: { thinking?: { type?: unknown } };
    };
    expect(gen.extra_body?.thinking?.type).toBe('enabled');
  });

  it('keeps thinking off working for toggleable models', () => {
    profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });

    expect(profile.data().thinkingLevel).toBe('off');
  });

  it('keeps an explicit on request verbatim (normalization is the UI boundary)', () => {
    profile.update({ modelAlias: 'kimi-code/custom', thinkingLevel: 'on' });

    expect(profile.data().thinkingLevel).toBe('on');
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
  let profile: IAgentProfileService;
  let requester: IAgentLLMRequesterService;
  let kimiConfig: TestKimiConfig;
  let capturedProvider: unknown;

  beforeEach(() => {
    kimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
      models: {
        'kimi-code': { provider: 'kimi', model: 'kimi-code', maxContextSize: 128_000 },
      },
    };
    capturedProvider = undefined;
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
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      llmGenerateServices(async (provider) => {
        capturedProvider = provider;
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      }),
    );
    profile = ctx.get(IAgentProfileService);
    requester = ctx.get(IAgentLLMRequesterService);
  }

  function generationKwargs(): Record<string, unknown> {
    return Reflect.get(capturedProvider as object, '_generationKwargs') as Record<string, unknown>;
  }

  it('injects KIMI_MODEL_TEMPERATURE into config.provider (the provider compaction also uses)', async () => {
    vi.stubEnv('KIMI_MODEL_TEMPERATURE', '0.3');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code' });
    await requester.request({}, undefined, new AbortController().signal);

    expect(generationKwargs()).toMatchObject({
      temperature: 0.3,
    });
  });

  it('injects KIMI_MODEL_THINKING_KEEP into config.provider when thinking is on (so compaction keeps it)', async () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    await requester.request({}, undefined, new AbortController().signal);

    const gen = generationKwargs() as {
      extra_body?: { thinking?: { keep?: unknown } };
    };
    expect(gen.extra_body?.thinking?.keep).toBe('all');
  });

  it('does NOT inject thinking.keep into config.provider when thinking is off', async () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });
    await requester.request({}, undefined, new AbortController().signal);

    const gen = generationKwargs() as {
      extra_body?: { thinking?: { keep?: unknown } };
    };
    expect(gen.extra_body?.thinking?.keep).toBeUndefined();
  });
});
