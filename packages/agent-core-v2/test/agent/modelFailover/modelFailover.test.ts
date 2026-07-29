/**
 * Scenario: a subagent recovers model-generation failures through an ordered,
 * bounded fallback route.
 * Responsibilities: eligibility, retry handoff, atomic model/effort rebinding,
 * same-driver replay, audit events, persistence, and Agent-scope isolation.
 * Wiring: the real Agent loop/profile/requester/wire services with only the
 * external model generation boundary stubbed.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/modelFailover/modelFailover.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  ChatProviderError,
  createAbortError,
} from '#/kosong/contract/errors';
import { emptyUsage } from '#/kosong/contract/usage';
import type { ExecutableTool } from '#/tool/toolContract';

import {
  InMemoryWireRecordPersistence,
  agentService,
  createTestAgent,
  llmGenerateServices,
  logServices,
  permissionModeServices,
  type TestAgentContext,
  type TestAgentOptions,
  type WireRecordPersistence,
} from '../../harness';

type GenerateFn = Parameters<typeof llmGenerateServices>[0];

interface FallbackBinding {
  readonly model: string;
  readonly effort?: string;
}

interface TestLogger {
  info(message: string, payload?: unknown): void;
  warn(message: string, payload?: unknown): void;
  error(message: string, payload?: unknown): void;
  debug(message: string, payload?: unknown): void;
  child(): TestLogger;
}

interface RigOptions {
  readonly agentId?: string;
  readonly enabled?: boolean;
  readonly includeRoute?: boolean;
  readonly fallbacks?: readonly FallbackBinding[];
  readonly triggers?: readonly ('retry_exhausted' | 'quota_exhausted')[];
  readonly maxSwitchesPerTurn?: number;
  readonly maxRetriesPerStep?: number;
  readonly fallbackOneEfforts?: readonly string[];
  readonly persistence?: WireRecordPersistence;
  readonly autoConfigure?: boolean;
  readonly logger?: TestLogger;
  readonly yolo?: boolean;
}

const contexts = new Set<TestAgentContext>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const context of [...contexts]) {
    try {
      await context.expectResumeMatches();
    } finally {
      await context.dispose();
      contexts.delete(context);
    }
  }
});

describe('subagent model failover (failure eligibility and bounded recovery)', () => {
  it('keeps the initial model when generation succeeds, no fallback is observed', async () => {
    const calls: string[] = [];
    const context = createRig(async (chat) => {
      calls.push(chat.modelName);
      return successfulResponse('initial success');
    });

    const result = await runTurn(context, 1);

    expect(result).toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(calls).toEqual(['mock-model']);
    expect(context.get(IAgentProfileService).data()).toMatchObject({
      modelAlias: 'mock-model',
      thinkingLevel: 'off',
    });
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it.each([
    {
      condition: 'the experimental flag is disabled',
      options: { enabled: false },
    },
    {
      condition: 'the fallback route is absent',
      options: { includeRoute: false },
    },
  ])('keeps the original failure when $condition, no model switch occurs', async ({ options }) => {
    const calls: string[] = [];
    const context = createRig(async (chat) => {
      calls.push(chat.modelName);
      throw new APIConnectionError('primary unavailable');
    }, options);

    const result = await runTurn(context, 1);

    expect(result.type).toBe('failed');
    expect(calls).toEqual(expect.arrayContaining(['mock-model']));
    expect(calls).not.toContain('fallback-one-upstream');
    expect(context.get(IAgentProfileService).getModel()).toBe('mock-model');
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it('does not apply a subagent fallback route to the main agent', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        throw new APIConnectionError('primary unavailable');
      },
      { agentId: 'main' },
    );

    const result = await runTurn(context, 1);

    expect(result.type).toBe('failed');
    expect(calls).toEqual(['mock-model']);
    expect(context.get(IAgentProfileService).getModel()).toBe('mock-model');
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it('uses the original model retry budget when a retry succeeds, no fallback is observed', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        if (calls.length === 1) {
          throw new APIProviderRateLimitError('try again', null, 0);
        }
        return successfulResponse('same-model recovery');
      },
      { maxRetriesPerStep: 2 },
    );

    const result = await runTurn(context, 1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toEqual(['mock-model', 'mock-model']);
    expect(rpcEvents(context, 'turn.step.retrying')).toHaveLength(1);
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it('switches after the original retry budget is exhausted, the same turn completes', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        if (chat.modelName === 'mock-model') {
          throw new APIProviderRateLimitError('still throttled', null, 0);
        }
        return successfulResponse('fallback recovery');
      },
      { maxRetriesPerStep: 2 },
    );

    const result = await runTurn(context, 1);
    await context.wire.flush();

    expect(result).toEqual({ type: 'completed', steps: 3, truncated: false });
    expect(calls).toEqual(['mock-model', 'mock-model', 'fallback-one-upstream']);
    expect(context.get(IAgentProfileService).data()).toMatchObject({
      modelAlias: 'fallback-one',
      thinkingLevel: 'high',
    });
    const persistedBindings = ['config.update', 'profile.bind']
      .flatMap((event) => wireEvents(context, event))
      .filter((entry) => (entry.args as { modelAlias?: string }).modelAlias === 'fallback-one');
    expect(persistedBindings).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          modelAlias: 'fallback-one',
          thinkingEffort: 'high',
        }),
      }),
    ]);
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          turnId: 1,
          fromModel: 'mock-model',
          toModel: 'fallback-one',
          fromProvider: 'test-provider',
          toProvider: 'fallback-provider',
          fromEffort: 'off',
          toEffort: 'high',
          reason: 'retry_exhausted',
          switchIndex: 1,
          maxSwitches: 1,
        }),
      }),
    ]);
    expect(wireEvents(context, 'model.failover')).toHaveLength(1);
    expect(context.contextData().history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'fallback recovery' }],
      }),
    ]);
  });

  it('switches immediately when provider quota is exhausted, no same-model retry is observed', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        if (chat.modelName === 'mock-model') {
          throw new APIProviderQuotaExhaustedError('quota exhausted');
        }
        return successfulResponse('quota fallback');
      },
      { maxRetriesPerStep: 10 },
    );

    const result = await runTurn(context, 1);

    expect(result).toEqual({ type: 'completed', steps: 2, truncated: false });
    expect(calls).toEqual(['mock-model', 'fallback-one-upstream']);
    expect(rpcEvents(context, 'turn.step.retrying')).toEqual([]);
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          reason: 'quota_exhausted',
          switchIndex: 1,
        }),
      }),
    ]);
  });

  it('advances through the ordered route when the first fallback fails, the second fallback completes', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        if (chat.modelName !== 'fallback-two-upstream') {
          throw new APIConnectionError(`${chat.modelName} unavailable`);
        }
        return successfulResponse('second fallback recovery');
      },
      {
        fallbacks: [
          { model: 'fallback-one', effort: 'high' },
          { model: 'fallback-two', effort: 'low' },
        ],
        maxSwitchesPerTurn: 2,
      },
    );

    const result = await runTurn(context, 1);

    expect(result).toEqual({ type: 'completed', steps: 3, truncated: false });
    expect(calls).toEqual(['mock-model', 'fallback-one-upstream', 'fallback-two-upstream']);
    expect(
      rpcEvents(context, 'turn.step.failover').map(
        (entry) => (entry.args as { toModel: string }).toModel,
      ),
    ).toEqual(['fallback-one', 'fallback-two']);
    expect(context.get(IAgentProfileService).data()).toMatchObject({
      modelAlias: 'fallback-two',
      thinkingLevel: 'low',
    });
  });

  it('stops at the per-turn switch limit when the fallback fails, the turn remains failed', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        throw new APIConnectionError(`${chat.modelName} unavailable`);
      },
      {
        fallbacks: [
          { model: 'fallback-one', effort: 'high' },
          { model: 'fallback-two', effort: 'low' },
        ],
        maxSwitchesPerTurn: 1,
      },
    );

    const result = await runTurn(context, 1);

    expect(result.type).toBe('failed');
    expect(calls).toEqual(['mock-model', 'fallback-one-upstream']);
    expect(rpcEvents(context, 'turn.step.failover')).toHaveLength(1);
    expect(context.get(IAgentProfileService).getModel()).toBe('fallback-one');
  });

  it('honors the configured trigger allowlist when retry exhaustion is excluded, no switch occurs', async () => {
    const calls: string[] = [];
    const context = createRig(
      async (chat) => {
        calls.push(chat.modelName);
        throw new APIConnectionError('primary unavailable');
      },
      { triggers: ['quota_exhausted'] },
    );

    const result = await runTurn(context, 1);

    expect(result.type).toBe('failed');
    expect(calls).toEqual(['mock-model']);
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it.each([
    {
      condition: 'the context window overflows',
      error: new APIContextOverflowError(400, 'context length exceeded'),
    },
    {
      condition: 'provider authentication fails',
      error: new APIStatusError(401, 'unauthorized'),
    },
    {
      condition: 'the provider rejects content',
      error: new APIEmptyResponseError('content filtered', { finishReason: 'filtered' }),
    },
    {
      condition: 'the provider rejects the request as unsafe',
      error: new APIStatusError(400, 'safety policy rejected the request'),
    },
    {
      condition: 'a non-provider operation fails',
      error: new Error('tool execution failed'),
    },
    {
      condition: 'a provider error has no safe structured classification',
      error: new ChatProviderError('unclassified provider failure'),
    },
  ])('leaves the active binding unchanged when $condition, no switch occurs', async ({ error }) => {
    const calls: string[] = [];
    const context = createRig(async (chat) => {
      calls.push(chat.modelName);
      throw error;
    });

    const result = await runTurn(context, 1);

    expect(result.type).toBe('failed');
    expect(calls).toEqual(expect.arrayContaining(['mock-model']));
    expect(calls).not.toContain('fallback-one-upstream');
    expect(context.get(IAgentProfileService).getModel()).toBe('mock-model');
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it('leaves the active binding unchanged when generation is cancelled, no switch occurs', async () => {
    const calls: string[] = [];
    const context = createRig(async (chat) => {
      calls.push(chat.modelName);
      throw createAbortError();
    });

    const result = await runTurn(context, 1);

    expect(result.type).toBe('cancelled');
    expect(calls).toEqual(['mock-model']);
    expect(context.get(IAgentProfileService).getModel()).toBe('mock-model');
    expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
  });

  it.each([
    {
      condition: 'the model alias is unknown',
      fallbacks: [{ model: 'missing-model', effort: 'high' }],
      fallbackOneEfforts: ['high'],
      warningCode: 'model-failover-invalid-model',
    },
    {
      condition: 'the effort is not declared by the model',
      fallbacks: [{ model: 'fallback-one', effort: 'high' }],
      fallbackOneEfforts: ['low'],
      warningCode: 'model-failover-invalid-effort',
    },
  ])(
    'fails closed when $condition, a runtime warning is recorded',
    async ({ fallbacks, fallbackOneEfforts, warningCode }) => {
      const warnings: Array<{ message: string; payload?: unknown }> = [];
      const logger = captureLogger(warnings);
      const context = createRig(
        async () => {
          throw new APIConnectionError('primary unavailable');
        },
        {
          fallbacks,
          fallbackOneEfforts,
          logger,
        },
      );

      const result = await runTurn(context, 1);

      expect(result.type).toBe('failed');
      expect(context.get(IAgentProfileService).getModel()).toBe('mock-model');
      expect(rpcEvents(context, 'turn.step.failover')).toEqual([]);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          payload: { code: warningCode },
        }),
      );
    },
  );

  it.each([
    {
      condition: 'the model alias is unknown',
      fallbacks: [{ model: 'missing-model', effort: 'high' }],
      fallbackOneEfforts: ['high'],
      warningCode: 'model-failover-invalid-model',
    },
    {
      condition: 'the effort is not declared by the model',
      fallbacks: [{ model: 'fallback-one', effort: 'high' }],
      fallbackOneEfforts: ['low'],
      warningCode: 'model-failover-invalid-effort',
    },
  ])(
    'emits a startup warning when $condition',
    ({ fallbacks, fallbackOneEfforts, warningCode }) => {
      const warnings: Array<{ message: string; payload?: unknown }> = [];
      createRig(async () => successfulResponse('unused'), {
        agentId: 'main',
        fallbacks,
        fallbackOneEfforts,
        logger: captureLogger(warnings),
      });

      expect(warnings).toContainEqual(
        expect.objectContaining({
          payload: { code: warningCode },
        }),
      );
    },
  );

  it('restores the switched binding after restart, the next turn starts on the fallback', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const firstCalls: string[] = [];
    const first = createRig(
      async (chat) => {
        firstCalls.push(chat.modelName);
        if (chat.modelName === 'mock-model') {
          throw new APIConnectionError('primary unavailable');
        }
        return successfulResponse('first turn recovered');
      },
      { persistence },
    );

    expect(await runTurn(first, 1)).toMatchObject({ type: 'completed' });
    expect(firstCalls).toEqual(['mock-model', 'fallback-one-upstream']);
    await first.wire.flush();
    await first.dispose();
    contexts.delete(first);

    const resumedCalls: string[] = [];
    const resumed = createRig(
      async (chat) => {
        resumedCalls.push(chat.modelName);
        return successfulResponse('resumed on fallback');
      },
      { persistence, autoConfigure: false },
    );
    await resumed.restorePersisted();

    expect(resumed.get(IAgentProfileService).getModel()).toBe('fallback-one');
    expect(await runTurn(resumed, 2)).toMatchObject({ type: 'completed' });
    expect(resumedCalls).toEqual(['fallback-one-upstream']);
  });

  it('keeps a failing subagent switch isolated from a peer, the peer retains its original model', async () => {
    const failing = createRig(
      async (chat) => {
        if (chat.modelName === 'mock-model') {
          throw new APIConnectionError('primary unavailable');
        }
        return successfulResponse('failing agent recovered');
      },
      { agentId: 'subagent-a' },
    );
    const peerCalls: string[] = [];
    const peer = createRig(
      async (chat) => {
        peerCalls.push(chat.modelName);
        return successfulResponse('peer success');
      },
      { agentId: 'subagent-b' },
    );

    expect(await runTurn(failing, 1)).toMatchObject({ type: 'completed' });
    expect(await runTurn(peer, 1)).toMatchObject({ type: 'completed' });

    expect(failing.get(IAgentProfileService).getModel()).toBe('fallback-one');
    expect(peer.get(IAgentProfileService).getModel()).toBe('mock-model');
    expect(peerCalls).toEqual(['mock-model']);
    expect(rpcEvents(peer, 'turn.step.failover')).toEqual([]);
  });

  it('drops abandoned streamed text when fallback succeeds, only the final result is committed', async () => {
    const context = createRig(async (chat, _system, _tools, _messages, callbacks) => {
      if (chat.modelName === 'mock-model') {
        await callbacks?.onMessagePart?.({ type: 'text', text: 'abandoned partial' });
        throw new APIConnectionError('stream disconnected');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'final answer' });
      return successfulResponse('final answer');
    });

    const result = await runTurn(context, 1);

    expect(result).toMatchObject({ type: 'completed' });
    expect(context.contextData().history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
      }),
    ]);
    expect(JSON.stringify(context.contextData().history)).not.toContain('abandoned partial');
  });

  it('replays the failed driver without duplicating fallback tool results or assistant content', async () => {
    let fallbackRequests = 0;
    let toolExecutions = 0;
    const context = createRig(
      async (chat) => {
        if (chat.modelName === 'mock-model') {
          throw new APIConnectionError('primary unavailable');
        }
        fallbackRequests += 1;
        if (fallbackRequests === 1) {
          return {
            id: 'response-tool-call',
            message: {
              role: 'assistant' as const,
              content: [{ type: 'text' as const, text: 'checking once' }],
              toolCalls: [
                {
                  type: 'function' as const,
                  id: 'call_lookup',
                  name: 'Lookup',
                  arguments: '{}',
                },
              ],
            },
            usage: emptyUsage(),
            finishReason: 'tool_calls' as const,
            rawFinishReason: 'tool_calls',
          };
        }
        return successfulResponse('tool result consumed once');
      },
      { yolo: true },
    );
    const tool: ExecutableTool = {
      name: 'Lookup',
      description: 'Return a deterministic lookup result.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => {
          toolExecutions += 1;
          return { output: 'lookup-result' };
        },
      }),
    };
    context.get(IAgentProfileService).update({
      profileName: 'agent',
      activeToolNames: ['Lookup'],
    });
    context.get(IAgentToolRegistryService).register(tool);

    expect(await runTurn(context, 1)).toMatchObject({ type: 'completed' });

    const history = context.contextData().history;
    expect(toolExecutions).toBe(1);
    expect(
      history.filter(
        (message) => message.role === 'tool' && message.toolCallId === 'call_lookup',
      ),
    ).toHaveLength(1);
    expect(
      history.filter(
        (message) =>
          message.role === 'assistant' &&
          message.toolCalls.some((call) => call.id === 'call_lookup'),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(history).match(/tool result consumed once/g)).toHaveLength(1);
  });
});

function createRig(generate: GenerateFn, options: RigOptions = {}): TestAgentContext {
  const agentId = options.agentId ?? 'subagent-1';
  const initialConfig: TestAgentOptions['initialConfig'] = {
    experimental: { 'model-failover': options.enabled ?? true },
    loopControl: { maxRetriesPerStep: options.maxRetriesPerStep ?? 1 },
    providers: {
      'fallback-provider': {
        type: 'openai',
        apiKey: 'YOUR_API_KEY',
        baseUrl: 'https://api.example.test/v1',
      },
    },
    models: {
      'fallback-one': {
        provider: 'fallback-provider',
        model: 'fallback-one-upstream',
        maxContextSize: 1_000_000,
        capabilities: ['thinking', 'tool_use'],
        supportEfforts: options.fallbackOneEfforts ?? ['high'],
        defaultEffort: 'high',
      },
      'fallback-two': {
        provider: 'fallback-provider',
        model: 'fallback-two-upstream',
        maxContextSize: 1_000_000,
        capabilities: ['thinking', 'tool_use'],
        supportEfforts: ['low'],
        defaultEffort: 'low',
      },
    },
    subagentFailover:
      options.includeRoute === false
        ? undefined
        : {
            fallbacks: options.fallbacks ?? [{ model: 'fallback-one', effort: 'high' }],
            on: options.triggers,
            maxSwitchesPerTurn: options.maxSwitchesPerTurn,
          },
  };

  const overrides = [
    llmGenerateServices(generate),
    agentService(IAgentScopeContext, {
      _serviceBrand: undefined,
      agentId,
      scope: (subKey?: string) =>
        subKey === undefined || subKey === ''
          ? `test/agents/${agentId}`
          : `test/agents/${agentId}/${subKey}`,
    }),
  ];
  if (options.logger !== undefined) overrides.push(logServices(options.logger));
  if (options.yolo === true) overrides.push(permissionModeServices('yolo'));
  const context = createTestAgent(...overrides, {
    initialConfig,
    persistence: options.persistence,
    autoConfigure: options.autoConfigure,
  });
  contexts.add(context);
  return context;
}

async function runTurn(context: TestAgentContext, turnId: number) {
  context.get(IEventBus).publish({
    type: 'turn.started',
    turnId,
    origin: { kind: 'user' },
  });
  const loop = context.get(IAgentLoopService);
  loop.enqueue(new ContinuationStepRequest());
  return loop.run({ turnId });
}

function successfulResponse(text: string) {
  return {
    id: `response-${text}`,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      toolCalls: [],
    },
    usage: emptyUsage(),
    finishReason: 'completed' as const,
    rawFinishReason: 'stop',
  };
}

function rpcEvents(context: TestAgentContext, name: string) {
  return context.allEvents.filter((entry) => entry.type === '[rpc]' && entry.event === name);
}

function wireEvents(context: TestAgentContext, name: string) {
  return context.allEvents.filter((entry) => entry.type === '[wire]' && entry.event === name);
}

function captureLogger(warnings: Array<{ message: string; payload?: unknown }>) {
  const logger = {
    info: () => {},
    warn: (message: string, payload?: unknown) => {
      warnings.push({ message, payload });
    },
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}
