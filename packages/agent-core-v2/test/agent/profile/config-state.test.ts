import { emptyUsage } from '@moonshot-ai/core/llm/usage';
import type { LlmRequest } from '@moonshot-ai/core/llm/request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoopRequester } from '#/agent/loop/requesterContract';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ModelRecord } from '#/llm-adapter/model/model';
import {
  configServices,
  createTestAgent,
  createMockProvider,
  InMemoryWireRecordPersistence,
  llmGenerateServices,
  modelProviderOptionServices,
  telemetryServices,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

type TestKimiConfig = ReturnType<Parameters<typeof configServices>[0]>;
type TestProtocolModelConfig = NonNullable<TestKimiConfig['models']>[string] &
  Pick<ModelRecord, 'protocol'>;
type GenerateFn = Parameters<typeof llmGenerateServices>[0];

function defaultGenerate(): GenerateFn {
  return createMockProvider(() => Promise.reject(new Error('generate should not be called')));
}

describe('ConfigState model capabilities', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let requester: LoopRequester;
  let kimiConfig: TestKimiConfig;
  let generate: GenerateFn;
  let records: TelemetryRecord[];

  beforeEach(() => {
    kimiConfig = {
      providers: {},
    };
    generate = defaultGenerate();
    records = [];
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      llmGenerateServices({
        respond: (request, signal) => generate.respond(request, signal),
        fetch: (input, init) => generate.fetch(input, init),
      }),
      telemetryServices(recordingTelemetry(records)),
    );
    profile = ctx.get(IAgentLoopService);
    requester = ctx.get(IAgentLoopService).requester;
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
          supportEfforts: ['low', 'high'],
          capabilities: ['image_in', 'video_in', 'thinking', 'tool_use'],
        },
      },
    };

    profile.update({ modelAlias: 'kimi-code/kimi-for-coding' });

    expect(profile.getModel()).toBe('kimi-code/kimi-for-coding');
    expect(ctx.modelResolver.get('kimi-code/kimi-for-coding').spec.name).toBe('kimi-for-coding');
    expect(ctx.modelResolver.get('kimi-code/kimi-for-coding').spec.maxContextSize).toBe(1_000_000);
    expect(profile.getModelCapabilities()).toMatchObject({
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
    });
  });

  it('republishes the model status slice on demand', () => {
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
          supportEfforts: ['low', 'high'],
        },
      },
    };
    profile.update({ modelAlias: 'kimi-code/kimi-for-coding' });
    const before = ctx.allEvents.filter((entry) => entry.event === 'agent.status.updated').length;

    profile.republishStatus();

    const statuses = ctx.allEvents.filter((entry) => entry.event === 'agent.status.updated');
    expect(statuses).toHaveLength(before + 1);
    expect(statuses.at(-1)?.args).toMatchObject({
      model: 'kimi-code/kimi-for-coding',
      maxContextTokens: 1_000_000,
    });
  });

  it('omits maxContextTokens when the bound model no longer resolves', () => {
    profile.update({ modelAlias: 'ghost/model' });

    const statuses = ctx.allEvents.filter((entry) => entry.event === 'agent.status.updated');
    expect(statuses.length).toBeGreaterThan(0);
    const last = statuses.at(-1)?.args as { model?: string; maxContextTokens?: number };
    expect(last.model).toBe('ghost/model');
    expect(last.maxContextTokens).toBeUndefined();
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
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
        },
      },
    };
    profile.update({ modelAlias: 'kimi-code/kimi-for-coding' });
    profile.setThinking('off');
    records.length = 0;

    profile.setThinking('low');

    expect(records).toContainEqual({
      event: 'thinking_toggle',
      properties: {
        agent_id: 'main',
        enabled: true,
        effort: 'low',
        from: 'off',
        mode: 'agent',
        model: 'kimi-code/kimi-for-coding',
        protocol: 'openai',
        provider_type: 'kimi',
      },
    });
  });

  it('writes the bound model into the ambient telemetry context', () => {
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

    expect(ctx.get(ITelemetryService).getContext()).toMatchObject({
      model: 'kimi-code/kimi-for-coding',
      provider_type: 'kimi',
      protocol: 'openai',
    });
  });

  it('keeps the alias as ambient model when the bound model does not resolve', () => {
    profile.update({ modelAlias: 'ghost/model' });

    expect(ctx.get(ITelemetryService).getContext()).toMatchObject({
      model: 'ghost/model',
    });
  });

  it('restores the ambient model after a cold resume', async () => {
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
    const resumedRecords: TelemetryRecord[] = [];
    const resumed = createTestAgent(
      { autoConfigure: false },
      configServices(() => kimiConfig),
      llmGenerateServices({
        respond: (request, signal) => generate.respond(request, signal),
        fetch: (input, init) => generate.fetch(input, init),
      }),
      telemetryServices(recordingTelemetry(resumedRecords)),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence([
          { type: 'config.update', agentId: 'main', modelAlias: 'kimi-code/kimi-for-coding' },
        ]),
      ),
    );
    try {
      await resumed.restorePersisted();

      expect(resumed.get(ITelemetryService).getContext()).toMatchObject({
        model: 'kimi-code/kimi-for-coding',
        provider_type: 'kimi',
        protocol: 'openai',
      });
    } finally {
      await resumed.dispose();
    }
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

    expect(profile.getModelCapabilities()).toBeUndefined();
  });

  it('freezes model max output size, system prompt and params across operation preparation', async () => {
    let requestMaxTokens: unknown;
    let requestSystemPrompt: unknown;
    let requestTemperature: unknown;
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
        'deepseek/deepseek-v4-mini': {
          provider: 'deepseek',
          model: 'deepseek-v4-mini',
          maxContextSize: 1_000_000,
          maxOutputSize: 128_000,
        },
      },
      modelOverrides: { temperature: 0.2 },
    };
    generate = createMockProvider(async (request, signal) => {
      const systemPrompt = request.profile?.systemPrompt ?? '';
      const options = {
        signal,
        cacheKey: request.model.cacheKey,
        sampling: request.model.sampling,
        thinking: request.model.thinking,
        maxOutputTokens: request.model.maxOutputTokens,
        maxContextSize: request.model.spec.maxContextSize,
        usedTokens: request.content.usedTokens,
      };
      requestMaxTokens = options?.maxOutputTokens;
      requestSystemPrompt = systemPrompt;
      requestTemperature = options?.sampling?.temperature;
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    });

    profile.update({
      modelAlias: 'deepseek/deepseek-v4-flash',
      systemPrompt: 'system',
      thinkingLevel: 'off',
    });
    const signal = new AbortController().signal;
    const operation = await requester.prepareOperation({
      source: () => ({ type: 'operation' }),
    }, signal);
    profile.update({
      modelAlias: 'deepseek/deepseek-v4-mini',
      systemPrompt: 'changed-system',
    });
    kimiConfig = { ...kimiConfig, modelOverrides: { temperature: 0.9 } };
    const outcome = await operation.generate(
      { content: {}, profile: {} },
      { signal },
    );
    if (outcome.type === 'failed') throw outcome.error;
    if (outcome.type === 'aborted') {
      throw outcome.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    expect(requestMaxTokens).toBe(384000);
    expect(requestSystemPrompt).toBe('system');
    expect(requestTemperature).toBe(0.2);
  });
});

describe('ConfigState prompt cache hint', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
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
    profile = ctx.get(IAgentLoopService);
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

    const model = ctx.modelResolver.get('kimi-code');
    expect(model.protocol).toBe('openai');
    expect(model.providerType).toBe('kimi');
    expect('sessionId' in ctx).toBe(false);
  });
});

describe('ConfigState thinking clamp for always-thinking models', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let requester: LoopRequester;
  let kimiConfig: TestKimiConfig;
  let capturedThinking: unknown;

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
        'kimi-code/ultra': {
          provider: 'kimi',
          model: 'kimi-ultra',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high', 'ultra'],
          defaultEffort: 'ultra',
        },
        'kimi-code/compatible': {
          provider: 'kimi',
          protocol: 'anthropic',
          model: 'compatible-model',
          maxContextSize: 128_000,
          capabilities: ['thinking', 'always_thinking'],
          supportEfforts: ['max'],
          defaultEffort: 'max',
        } as TestProtocolModelConfig,
      },
    };
    capturedThinking = undefined;
    ctx = createTestAgent(
      configServices(() => kimiConfig),
      llmGenerateServices(createMockProvider(async (request, signal) => {
        const options = {
        signal,
        cacheKey: request.model.cacheKey,
        sampling: request.model.sampling,
        thinking: request.model.thinking,
        maxOutputTokens: request.model.maxOutputTokens,
        maxContextSize: request.model.spec.maxContextSize,
        usedTokens: request.content.usedTokens,
      };
        capturedThinking = options?.thinking;
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      })),
    );
    profile = ctx.get(IAgentLoopService);
    requester = ctx.get(IAgentLoopService).requester;
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

  it('sends the clamped thinking effort in the per-turn intent after thinking was set off', async () => {
    profile.update({ modelAlias: 'kimi-code/deep', thinkingLevel: 'off' });

    await generateOperation(requester, new AbortController().signal);

    expect(capturedThinking).toMatchObject({ effort: 'high' });
  });

  it('keeps thinking off working for toggleable models', () => {
    profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });

    expect(profile.data().thinkingLevel).toBe('off');
  });

  it('resolves an explicit on request to the model default effort', () => {
    profile.update({ modelAlias: 'kimi-code/custom', thinkingLevel: 'on' });

    expect(profile.data().thinkingLevel).toBe('max');
  });

  it('re-clamps when switching to an always-on model after thinking was off', () => {
    profile.update({ modelAlias: 'kimi-code/toggle', thinkingLevel: 'off' });
    expect(profile.data().thinkingLevel).toBe('off');

    profile.update({ modelAlias: 'kimi-code/deep' });
    expect(profile.data().thinkingLevel).toBe('high');
  });

  it('falls back to the target default when a model switch carries an unsupported effort', () => {
    profile.update({ modelAlias: 'kimi-code/ultra', thinkingLevel: 'ultra' });

    profile.update({ modelAlias: 'kimi-code/custom' });

    expect(profile.data().thinkingLevel).toBe('max');
  });

  it('projects an inherited concrete effort to on when switching to a boolean model', () => {
    profile.update({ modelAlias: 'kimi-code/ultra', thinkingLevel: 'ultra' });

    profile.update({ modelAlias: 'kimi-code/toggle' });

    expect(profile.data().thinkingLevel).toBe('on');
  });

  it('rejects an unsupported effort explicitly set on the current Kimi model', () => {
    profile.update({ modelAlias: 'kimi-code/custom' });

    expect(() => {
      profile.setThinking('ultra');
    }).toThrow(
      'Thinking effort "ultra" is not supported by model "kimi-code/custom"',
    );
  });

  it.each([
    [' HIGH ', 'high'],
    ['OFF', 'off'],
  ])('normalizes runtime effort %j to %s before validation', (input, expected) => {
    profile.update({ modelAlias: 'kimi-code/ultra' });

    profile.setThinking(input);

    expect(profile.data().thinkingLevel).toBe(expected);
  });

  it('uses the model default when the runtime effort is blank', () => {
    profile.update({ modelAlias: 'kimi-code/custom', thinkingLevel: 'low' });

    profile.setThinking('   ');

    expect(profile.data().thinkingLevel).toBe('max');
  });

  it('preserves unlisted efforts with a warning for Kimi-managed Anthropic models', () => {
    profile.update({ modelAlias: 'kimi-code/compatible', thinkingLevel: 'max' });

    expect(() => {
      profile.setThinking('high');
    }).not.toThrow();
    expect(profile.data().thinkingLevel).toBe('high');
    expect(ctx.allEvents).toContainEqual({
      type: '[rpc]',
      event: 'warning',
      args: expect.objectContaining({
        code: 'anthropic-thinking-effort-not-listed',
        message:
          'Thinking effort "high" is not listed for model "compatible-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
      }),
    });
  });

  it('clamps off to the model default for always-on models, on any transport', () => {
    profile.update({ modelAlias: 'kimi-code/compatible', thinkingLevel: 'max' });

    expect(() => {
      profile.setThinking('off');
    }).not.toThrow();
    expect(profile.data().thinkingLevel).toBe('max');
  });
});

describe('ConfigState.provider applies global KIMI_MODEL_* request config', () => {
  let ctx: TestAgentContext | undefined;
  let profile: IAgentLoopService;
  let requester: LoopRequester;
  let kimiConfig: TestKimiConfig;
  let capturedProvider: unknown;
  let capturedRequest: LlmRequest | undefined;

  beforeEach(() => {
    kimiConfig = {
      providers: { kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' } },
      models: {
        'kimi-code': {
          provider: 'kimi',
          model: 'kimi-code',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
        },
        'kimi-code-anthropic': {
          provider: 'kimi',
          protocol: 'anthropic',
          model: 'kimi-code-anthropic',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
        } as TestProtocolModelConfig,
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
      llmGenerateServices(createMockProvider(async (request, signal) => {
        const provider = { name: request.model.spec.provider, modelName: request.model.spec.name };
        capturedProvider = provider;
        capturedRequest = request;
        return {
          id: 'response-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      })),
    );
    profile = ctx.get(IAgentLoopService);
    requester = ctx.get(IAgentLoopService).requester;
  }

  it('injects KIMI_MODEL_TEMPERATURE into the per-turn sampling intent (the compaction request also uses)', async () => {
    vi.stubEnv('KIMI_MODEL_TEMPERATURE', '0.3');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code' });
    await generateOperation(requester, new AbortController().signal);

    expect(capturedRequest?.model.sampling).toMatchObject({
      temperature: 0.3,
    });
  });

  it('injects KIMI_MODEL_THINKING_KEEP into the per-turn thinking intent when thinking is on (so compaction keeps it)', async () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    await generateOperation(requester, new AbortController().signal);

    expect(capturedRequest?.model.thinking).toMatchObject({ effort: 'on', keep: 'all' });
  });

  it('does NOT inject thinking.keep into the per-turn intent when thinking is off', async () => {
    vi.stubEnv('KIMI_MODEL_THINKING_KEEP', 'all');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });
    await generateOperation(requester, new AbortController().signal);

    expect(capturedRequest?.model.thinking?.effort).toBe('off');
    expect(capturedRequest?.model.thinking?.keep).toBeUndefined();
  });

  it('injects forced effort through the Anthropic protocol for a Kimi provider', async () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    createAgentWithEnv();

    profile.update({ modelAlias: 'kimi-code-anthropic', thinkingLevel: 'high' });
    expect(profile.data().thinkingLevel).toBe('high');
    expect(profile.resolveModelContext().thinkingLevel).toBe('max');
    const statusEvent = ctx?.allEvents.findLast(
      (event) =>
        event.event === 'agent.status.updated' &&
        (event.args as { thinkingEffort?: unknown } | undefined)?.thinkingEffort !== undefined,
    );
    expect(statusEvent?.args).toMatchObject({
      model: 'kimi-code-anthropic',
      thinkingEffort: 'max',
    });

    await generateOperation(requester, new AbortController().signal);

    expect(capturedProvider).toMatchObject({ name: 'anthropic' });
    expect(capturedRequest?.model.thinking?.effort).toBe('max');
  });
});

async function generateOperation(requester: LoopRequester, signal: AbortSignal): Promise<void> {
  const operation = await requester.prepareOperation({
    source: () => ({ type: 'operation' }),
  }, signal);
  const outcome = await operation.with({ policy: { retry: { maxAttemptsPerStep: 1 } } }).generate(
    { content: {}, profile: {} },
    { signal },
  );
  if (outcome.type === 'failed') throw outcome.error;
  if (outcome.type === 'aborted') {
    throw outcome.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
}
