import {
  APIConnectionError,
  APIRequestTooLargeError,
  APIStatusError,
} from '#/llm-adapter/contract/errors';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import type {
  Message,
  StreamedMessagePart,
  ToolDescription as Tool,
} from '#human/llm/message';
import { emptyUsage } from '#human/llm-requester/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  LoopRequester,
  AgentLLMRequestSource,
} from '#/agent/loop/requesterContract';
import { errorFromLlmOutcome } from '#/llm-adapter/model/generate';
import type { LlmOutcome } from '#human/llm/response';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ILogger as Logger, LogPayload } from '#/_base/log/log';
import {
  configServices,
  createTestAgent,
  findGenerateCallPrefixBreak,
  llmGenerateServices,
  logServices,
  requesterFromGenerateFn,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
import { promptCacheComparisons } from '../../harness/prompt-cache-guard';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    child: () => logger,
  };
  return { logger, entries };
}

describe('LLMRequester service migration coverage', () => {
  describe('wire observability records', () => {
    let ctx: TestAgentContext;
    let llmRequester: LoopRequester;
    let shouldVerifyResume = true;

    const requestTools: readonly Tool[] = [
      {
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'DeferredLookup',
        description: 'Loaded on demand, not sent in top-level tools.',
        parameters: {
          type: 'object',
          properties: {},
        },
        deferred: true,
      },
      {
        name: 'ReadMediaFile',
        description: 'Hidden from a model without media input.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    ];

    beforeEach(() => {
      vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
      shouldVerifyResume = true;
      ctx = createTestAgent();
      llmRequester = ctx.get(IAgentLoopService).requester;
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      try {
        if (shouldVerifyResume) await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('records one tools snapshot per unique provider-visible tool table and captures each outbound call', async () => {
      ctx.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: false,
          tool_use: true,
          max_context_tokens: 128_000,
          dynamically_loaded_tools: true,
        },
      });
      ctx.mockNextResponse({ type: 'text', text: 'first response' });
      await requestCore(llmRequester, {
        messages: [userMessage('first direct request')],
        systemPrompt: 'request-specific system',
        tools: requestTools,
        source: {
          type: 'operation',
          requestKind: 'direct_test',
          logFields: { turnStep: '7.2', droppedCount: 3 },
        },
      });
      ctx.mockNextResponse({ type: 'text', text: 'second response' });
      await requestCore(llmRequester, {
        messages: [userMessage('second direct request')],
        systemPrompt: 'request-specific system',
        tools: requestTools,
        source: {
          type: 'operation',
          requestKind: 'direct_test',
          logFields: { turnStep: '7.3' },
        },
      });

      const snapshots = wireEvents(ctx, 'llm.tools_snapshot');
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.args).toMatchObject({
        hash: expect.any(String),
        tools: [
          {
            name: 'Lookup',
            description: 'Look up a short test value.',
            parameters: requestTools[0]!.parameters,
          },
        ],
      });
      expect(JSON.stringify(snapshots[0]?.args)).not.toContain('DeferredLookup');
      expect(JSON.stringify(snapshots[0]?.args)).not.toContain('ReadMediaFile');
      expect(ctx.llmCalls).toHaveLength(2);
      expect(ctx.llmCalls.map((call) => call.tools.map((tool) => tool.name))).toEqual([
        ['Lookup'],
        ['Lookup'],
      ]);
      expect(ctx.llmCalls.map((call) => call.systemPrompt)).toEqual([
        'request-specific system',
        'request-specific system',
      ]);
      expect(ctx.llmCalls.map((call) => call.history.map((message) => message.role))).toEqual([
        ['user'],
        ['user'],
      ]);
    });

    it('sends the resolved Kimi thinking keep default to the provider when thinking is enabled', async () => {
      await ctx.dispose();
      let thinking: unknown;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async (_provider, _systemPrompt, _tools, _history, _callbacks, options) => {
          thinking = options?.thinking;
          return {
            id: 'thinking-response',
            message: { role: 'assistant', content: [], toolCalls: [] },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        })),
      );
      llmRequester = ctx.get(IAgentLoopService).requester;
      ctx.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 1_000_000,
        },
      });
      ctx.get(IAgentLoopService).update({ thinkingLevel: 'high' });

      await requestCore(llmRequester);

      expect(thinking).toMatchObject({ effort: 'on', keep: 'all' });
    });

    it('sends the env-forced Kimi effort to the provider', async () => {
      await ctx.dispose();
      vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
      let thinking: unknown;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async (_provider, _systemPrompt, _tools, _history, _callbacks, options) => {
          thinking = options?.thinking;
          return {
            id: 'forced-thinking-response',
            message: { role: 'assistant', content: [], toolCalls: [] },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        })),
      );
      llmRequester = ctx.get(IAgentLoopService).requester;
      ctx.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 1_000_000,
        },
      });
      const profile = ctx.get(IAgentLoopService);
      profile.update({ thinkingLevel: 'high' });
      expect(profile.data().thinkingLevel).toBe('on');
      expect(profile.resolveModelContext().thinkingLevel).toBe('max');

      await requestCore(llmRequester);

      expect(thinking).toMatchObject({ effort: 'max' });
    });

    it('records strict projection resends as separate outbound requests', async () => {
      await ctx.dispose();
      let calls = 0;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          calls += 1;
          if (calls === 1) {
            throw new APIStatusError(400, 'tool_use ids must be unique', false);
          }
          return {
            id: 'strict-response',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'strict ok' }],
              toolCalls: [],
            },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        })),
      );
      llmRequester = ctx.get(IAgentLoopService).requester;

      await requestCore(llmRequester);

      expect(calls).toBe(2);
    });

    it('emits cache break with loop-assigned identifiers and per-agent baselines', async () => {
      shouldVerifyResume = false;
      await ctx.dispose();
      const records: TelemetryRecord[] = [];
      const cacheReads = [10000, 5000, 10000, 5000, 1000, 5000] as const;
      let calls = 0;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          const index = calls++;
          return {
            id: `response-${index + 1}`,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `response-${index + 1}` }],
              toolCalls: [],
            },
            usage: {
              inputOther: 100,
              output: 50,
              inputCacheRead: cacheReads[index]!,
              inputCacheCreation: 0,
            },
            finishReason: 'completed',
            rawFinishReason: 'stop',
            requestId: `trace-${index + 1}`,
          };
        })),
        telemetryServices(recordingTelemetry(records)),
      );

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first main turn' }] });
      await ctx.untilTurnEnd();
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second main turn' }] });
      await ctx.untilTurnEnd();
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third main turn' }] });
      await ctx.untilTurnEnd();

      const lifecycle = ctx.get(IAgentLifecycleService);
      const childContext = await lifecycle.create({
        agentId: 'agent-child',
        binding: { profile: 'coder', model: 'mock-model' },
      });
      const childLoop = lifecycle
        .handleOf(childContext.agentId)!
        .accessor.get(IAgentLoopService);
      const runChildTurn = async (text: string): Promise<void> => {
        const { id } = childLoop.submit({
          message: { role: 'user', content: [{ type: 'text', text }] },
          meta: { origin: { kind: 'user' } },
        });
        expect((await childLoop.promptHandle(id)!.completion).state).toBe('completed');
      };
      await runChildTurn('child first turn');
      await runChildTurn('child second turn');

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'fourth main turn' }] });
      await ctx.untilTurnEnd();

      const events = records.filter((record) => record.event === 'cache_break_detected');
      expect(events).toHaveLength(3);
      expect(events.map((record) => record.properties?.['agent_id'])).toEqual([
        'main',
        'agent-child',
        'main',
      ]);
      expect(events[0]?.properties).toMatchObject({
        agent_id: 'main',
        turn_id: 1,
        step_no: 1,
        trace_id: 'trace-2',
        prev_turn_id: 0,
        prev_step_no: 1,
        prev_trace_id: 'trace-1',
        prev_input_cache_read: 10000,
        curr_input_cache_read: 5000,
      });
      expect(events[1]?.properties).toMatchObject({
        agent_id: 'agent-child',
        turn_id: 4,
        step_no: 1,
        trace_id: 'trace-5',
        prev_turn_id: 3,
        prev_step_no: 1,
        prev_trace_id: 'trace-4',
        prev_input_cache_read: 5000,
        curr_input_cache_read: 1000,
      });
      expect(events[2]?.properties).toMatchObject({
        agent_id: 'main',
        turn_id: 3,
        step_no: 1,
        trace_id: 'trace-6',
        prev_turn_id: 2,
        prev_step_no: 1,
        prev_trace_id: 'trace-3',
        prev_input_cache_read: 10000,
        curr_input_cache_read: 5000,
      });
    });

  });

  describe('tool-call deltas', () => {
    let ctx: TestAgentContext;
    let profile: IAgentLoopService;

    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentLoopService);
      profile.update({ activeToolNames: ['Lookup'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('preserves indexed tool-call deltas through AgentLoopService protocol events', async () => {
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });

      ctx.mockNextProviderResponse({
        parts: [
          { type: 'tool_call_part', argumentsPart: '{"query"', index: 0 },
          {
            type: 'function',
            id: 'call_lookup',
            name: 'Lookup',
            arguments: null,
            _streamIndex: 0,
          },
          { type: 'tool_call_part', argumentsPart: ':"moon"}', index: 0 },
        ],
        finishReason: 'tool_calls',
      });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });

      await ctx.untilToolCall({
        content: 'moon-result',
        output: 'moon-result',
      });

      expect(protocolEvents(ctx, 'tool.call.delta').map((event) => event.args)).toEqual([
        { time: expect.any(Number), agentId: 'main', turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: undefined },
        { time: expect.any(Number), agentId: 'main', turnId: 0, toolCallId: 'call_lookup', argumentsPart: '{"query"' },
        { time: expect.any(Number), agentId: 'main', turnId: 0, toolCallId: 'call_lookup', argumentsPart: ':"moon"}' },
      ]);
      expect(protocolEvents(ctx, 'toolCall').at(-1)?.args).toEqual({
        turnId: 0,
        toolCallId: 'call_lookup',
        args: { query: 'moon' },
      });

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      await ctx.untilTurnEnd();
    });
  });

  describe('request failure logging', () => {
    let ctx: TestAgentContext | undefined;

    afterEach(async () => {
      if (ctx === undefined) return;
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        ctx = undefined;
      }
    });

    it('logs request failures without request payloads or stacks', async () => {
      const entries: unknown[] = [];
      const logger: Logger = {
        warn: (_message: string, payload?: LogPayload) => entries.push(payload),
        error: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: () => logger,
      };
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          throw new Error('temporary provider failure');
        })),
        logServices(logger),
      );
      const llmRequester = ctx.get(IAgentLoopService).requester;

      await expect(
        requestCore(llmRequester, {
          source: {
            type: 'operation',
            requestKind: 'direct_test',
            logFields: { turnStep: '0.1' },
          },
        }),
      ).rejects.toMatchObject({ message: 'temporary provider failure' });

      expect(entries).toEqual([
        expect.objectContaining({
          requestKind: 'direct_test',
          turnStep: '0.1',
          model: expect.any(String),
          errorName: 'Error',
          errorMessage: 'temporary provider failure',
        }),
      ]);
      expect(JSON.stringify(entries)).not.toContain('messages');
      expect(JSON.stringify(entries)).not.toContain('stack');
    });

    it('fails a retryable provider error on the first attempt — retries are the loop\u2019s concern', async () => {
      let calls = 0;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          calls += 1;
          throw new APIConnectionError('terminated');
        })),
      );
      const llmRequester = ctx.get(IAgentLoopService).requester;

      await expect(requestCore(llmRequester)).rejects.toMatchObject({
        name: 'APIConnectionError',
      });
      expect(calls).toBe(1);
    });

    it('tracks api_error with the v1 wire shape (model id, alias, protocol, status code)', async () => {
      const records: TelemetryRecord[] = [];
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          throw new APIStatusError(429, 'rate limited', true);
        })),
        telemetryServices(recordingTelemetry(records)),
      );
      const llmRequester = ctx.get(IAgentLoopService).requester;

      await expect(requestCore(llmRequester)).rejects.toMatchObject({
        name: 'APIStatusError',
      });

      expect(records).toContainEqual({
        event: 'api_error',
        properties: expect.objectContaining({
          error_type: 'rate_limit',
          agent_id: 'main',
          model: 'mock-model',
          alias: 'mock-model',
          provider_type: 'kimi',
          protocol: 'openai',
          retryable: expect.any(Boolean),
          duration_ms: expect.any(Number),
          status_code: 429,
        }),
      });
    });

    it('tags api_error with turn_id and request_kind from the request source', async () => {
      const records: TelemetryRecord[] = [];
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          throw new APIConnectionError('terminated');
        })),
        telemetryServices(recordingTelemetry(records)),
      );
      const llmRequester = ctx.get(IAgentLoopService).requester;

      await expect(
        requestCore(llmRequester, { source: { type: 'turn', turnId: 3, step: 1 } }),
      ).rejects.toMatchObject({ name: 'APIConnectionError' });
      await expect(
        requestCore(llmRequester, {
          source: { type: 'operation', turnId: 7, requestKind: 'full_compaction' },
        }),
      ).rejects.toMatchObject({ name: 'APIConnectionError' });

      expect(records).toContainEqual({
        event: 'api_error',
        properties: expect.objectContaining({
          error_type: 'network',
          turn_id: 3,
          request_kind: 'turn',
        }),
      });
      expect(records).toContainEqual({
        event: 'api_error',
        properties: expect.objectContaining({
          error_type: 'network',
          turn_id: 7,
          request_kind: 'full_compaction',
        }),
      });
    });
  });

  describe('request timing and budget', () => {
    let ctx: TestAgentContext;
    let llmRequester: LoopRequester;
    let profile: IAgentLoopService;
    let requestMaxTokens: unknown;
    let logEntries: CapturedLogEntry[];

    beforeEach(() => {
      requestMaxTokens = undefined;
      const { logger, entries } = captureLogs();
      logEntries = entries;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async (_provider, _systemPrompt, _tools, _messages, callbacks, options) => {
          requestMaxTokens = options?.maxCompletionTokens;
          await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
          return {
            id: 'response-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'timed' }],
              toolCalls: [],
            },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        })),
        configServices(() => ({
          defaultModel: 'deepseek/deepseek-v4-flash',
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
              capabilities: ['tool_use'],
            },
          },
        })),
        logServices(logger),
      );
      llmRequester = ctx.get(IAgentLoopService).requester;
      profile = ctx.get(IAgentLoopService);
      profile.update({
        modelAlias: 'deepseek/deepseek-v4-flash',
        systemPrompt: 'system',
        thinkingLevel: 'off',
      });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('emits stream timing and applies the model output budget through LoopRequester', async () => {
      const { parts, finish } = await collectLLMRequest((onPart) =>
        requestCore(llmRequester, undefined, onPart),
      );

      expect(requestMaxTokens).toBe(384_000);
      expect(parts).toContainEqual({ type: 'text', text: 'timed' });
      expect(finish).toMatchObject({
        usage: emptyUsage(),
        messageId: 'response-1',
        finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      });
      expect(finish.timing).toEqual(
        expect.objectContaining({
          firstTokenLatencyMs: expect.any(Number),
          streamDurationMs: expect.any(Number),
        }),
      );
    });

    it('logs successful LLM responses with caller-provided request fields', async () => {
      await collectLLMRequest((onPart) =>
        requestCore(llmRequester, 
          {
            source: {
              type: 'operation',
              requestKind: 'direct_test',
              logFields: { turnStep: '0.1' },
            },
          },
          onPart,
        ),
      );

      const responseLogs = logEntries.filter((entry) => entry.message === 'llm response');
      expect(responseLogs).toHaveLength(1);
      const payload = responseLogs[0]?.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        requestKind: 'direct_test',
        turnStep: '0.1',
        ttftMs: expect.any(Number),
        streamDurationMs: expect.any(Number),
        outputTokens: expect.any(Number),
        serverDecodeMs: expect.any(Number),
        clientConsumeMs: expect.any(Number),
      });
      expect(payload).not.toHaveProperty('requestBuildMs');
      expect(payload).not.toHaveProperty('serverFirstTokenMs');
    });

    it('applies a per-request output budget override', async () => {
      await requestCore(llmRequester, { maxOutputSize: 123_000 });

      expect(requestMaxTokens).toBe(123_000);
    });

    it('carries kosong decode accounting and leaves the TTFT split undefined without a dispatch boundary', async () => {
      const { finish } = await collectLLMRequest((onPart) =>
        requestCore(llmRequester, undefined, onPart),
      );
      const timing = finish.timing;

      expect(timing?.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
      expect(timing?.serverDecodeMs).toBeGreaterThanOrEqual(0);
      expect(timing?.clientConsumeMs).toBeGreaterThanOrEqual(0);
      expect(timing?.requestBuildMs).toBeUndefined();
      expect(timing?.serverFirstTokenMs).toBeUndefined();
    });
  });

  describe('per-turn intent handoff', () => {
    let ctx: TestAgentContext;
    let llmRequester: LoopRequester;
    let capturedCacheKey: unknown;

    beforeEach(() => {
      capturedCacheKey = undefined;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async (_provider, _systemPrompt, _tools, _messages, _callbacks, options) => {
          capturedCacheKey = options?.cacheKey;
          return {
            id: 'response-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'intent' }],
              toolCalls: [],
            },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        })),
      );
      llmRequester = ctx.get(IAgentLoopService).requester;
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('forwards the session id as the per-turn cache-key intent', async () => {
      await requestCore(llmRequester);

      expect(capturedCacheKey).toBe('test-session');
    });
  });

  describe('media recovery across turns', () => {
    function countMedia(history: readonly Message[]): number {
      return history
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url' || part.type === 'video_url').length;
    }

    it.each([
      {
        recovery: 'media-degraded',
        error: new APIRequestTooLargeError(413, 'Request Entity Too Large'),
        keptMedia: 2,
      },
      {
        recovery: 'media-stripped',
        error: new APIStatusError(400, 'unsupported image format: image/avif is not supported', false),
        keptMedia: 0,
      },
    ])(
      'starts the next turn as a prefix extension of the $recovery request the previous turn settled on',
      async ({ error, keptMedia }) => {
        const compared = promptCacheComparisons();
        const ctx = createTestAgent();
        try {
          ctx.configure({
            provider: {
              type: 'kimi',
              apiKey: 'test-key',
              baseUrl: 'https://api.example/v1',
              model: 'kimi-code',
            },
            modelCapabilities: {
              image_in: true,
              video_in: true,
              audio_in: false,
              thinking: true,
              tool_use: true,
              max_context_tokens: 256_000,
            },
          });
          ctx.appendRichToolExchange();
          ctx.appendRichToolExchange();
          ctx.mockNextProviderResponse({ error });
          ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
          await ctx.rpc.prompt({ input: [{ type: 'text', text: 'describe the media' }] });
          await ctx.untilTurnEnd();
          ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
          await ctx.rpc.prompt({ input: [{ type: 'text', text: 'and now?' }] });
          await ctx.untilTurnEnd();

          const [rejected, settled, nextTurn] = ctx.llmCalls;
          expect(countMedia(rejected!.history)).toBeGreaterThan(2);
          expect(countMedia(settled!.history)).toBe(keptMedia);
          expect(findGenerateCallPrefixBreak(settled!, nextTurn!)).toBeUndefined();
          expect(ctx.llmCalls).toHaveLength(3);
          expect(promptCacheComparisons()).toBeGreaterThan(compared);
        } finally {
          await ctx.dispose();
        }
      },
    );
  });

});

type ProtocolEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[rpc]' }
>;

type WireEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[wire]' }
>;

function protocolEvents(
  ctx: TestAgentContext,
  eventName: string,
): readonly ProtocolEvent[] {
  return ctx.allEvents.filter(
    (event): event is ProtocolEvent => event.type === '[rpc]' && event.event === eventName,
  );
}

function wireEvents(
  ctx: TestAgentContext,
  eventName: string,
): readonly WireEvent[] {
  return ctx.allEvents.filter(
    (event): event is WireEvent => event.type === '[wire]' && event.event === eventName,
  );
}

function userMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }] };
}

interface RequestOverrides {
  readonly messages?: readonly Message[];
  readonly tools?: readonly Tool[];
  readonly systemPrompt?: string;
  readonly source?: AgentLLMRequestSource;
  readonly maxOutputSize?: number;
}

async function requestCore(
  requester: LoopRequester,
  overrides: RequestOverrides = {},
  onPart: (part: StreamedMessagePart) => void = () => {},
  signal = new AbortController().signal,
) {
  const source: AgentLLMRequestSource = overrides.source ?? { type: 'operation' };
  const operation = await requester.prepareOperation({
    source: () => source,
    maxOutputSize: overrides.maxOutputSize,
    tools: overrides.tools,
  }, signal);
  const outcome = await operation.with({ policy: { retry: { maxAttemptsPerStep: 1 } } }).generate(
    {
      content: { messages: overrides.messages },
      profile: { systemPrompt: overrides.systemPrompt, tools: overrides.tools },
    },
    {
      signal,
      onEvent: (event) => {
        if (event.type === 'llm.streaming.part') onPart(event.part);
      },
    },
  );
  if (outcome.type !== 'done') throw errorFromLlmOutcome(outcome);
  return outcome;
}

async function collectLLMRequest(
  request: (onPart: (part: StreamedMessagePart) => void) => Promise<Extract<LlmOutcome, { type: 'done' }>>,
): Promise<{ parts: StreamedMessagePart[]; finish: Extract<LlmOutcome, { type: 'done' }> }> {
  const parts: StreamedMessagePart[] = [];
  const finish = await request((part) => {
    parts.push(part);
  });
  return { parts, finish };
}
