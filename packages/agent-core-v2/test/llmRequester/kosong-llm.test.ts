import { APIConnectionError, APIStatusError } from '#/app/llmProtocol/errors';
import { type StreamedMessagePart } from '#/app/llmProtocol/message';
import type { Tool } from '#/app/llmProtocol/tool';
import { emptyUsage } from '#/app/llmProtocol/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentLLMRequesterService,
  type LLMRequestFinish,
  type LLMRequestRetryContext,
} from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ILogger as Logger, LogPayload } from '#/_base/log/log';
import {
  configServices,
  createTestAgent,
  llmGenerateServices,
  logServices,
  type TestAgentContext,
} from '../harness';

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
    let llmRequester: IAgentLLMRequesterService;

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
    ];

    beforeEach(() => {
      ctx = createTestAgent();
      llmRequester = ctx.get(IAgentLLMRequesterService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('records one tools snapshot per unique provider-visible tool table and one request per outbound call', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'first response' });
      await llmRequester.request({
        messages: [userMessage('first direct request')],
        systemPrompt: 'request-specific system',
        tools: requestTools,
        source: {
          type: 'operation',
          requestKind: 'direct_test',
          logFields: { turnStep: '7.2', droppedCount: 3 },
        },
        retry: { maxAttempts: 1 },
      });
      ctx.mockNextResponse({ type: 'text', text: 'second response' });
      await llmRequester.request({
        messages: [userMessage('second direct request')],
        systemPrompt: 'request-specific system',
        tools: requestTools,
        source: {
          type: 'operation',
          requestKind: 'direct_test',
          logFields: { turnStep: '7.3' },
        },
        retry: { maxAttempts: 1 },
      });

      const snapshots = wireEvents(ctx, 'llm.tools_snapshot');
      expect(snapshots).toHaveLength(1);
      const snapshotArgs = snapshots[0]?.args as Record<string, unknown> | undefined;
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

      const requests = wireEvents(ctx, 'llm.request');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.args).toMatchObject({
        kind: 'loop',
        provider: 'kimi',
        model: 'mock-model',
        modelAlias: 'mock-model',
        thinkingEffort: 'off',
        toolSelect: true,
        toolsHash: snapshotArgs?.['hash'],
        messageCount: 1,
        systemPromptHash: expect.any(String),
        systemPrompt: 'request-specific system',
        turnStep: '7.2',
        droppedCount: 3,
      });
      expect(requests[1]?.args).toMatchObject({
        toolsHash: snapshotArgs?.['hash'],
        messageCount: 1,
        turnStep: '7.3',
      });
    });

    it('records the resolved Kimi thinking keep default when thinking is enabled', async () => {
      ctx.get(IAgentProfileService).update({ thinkingLevel: 'high' });
      ctx.mockNextResponse({ type: 'text', text: 'thinking response' });

      await llmRequester.request({ retry: { maxAttempts: 1 } });

      expect(wireEvents(ctx, 'llm.request')).toHaveLength(1);
      expect(wireEvents(ctx, 'llm.request')[0]?.args).toMatchObject({
        thinkingEffort: 'high',
        thinkingKeep: 'all',
      });
    });

    it('records retry attempts after the first request attempt', async () => {
      await ctx.dispose();
      let calls = 0;
      ctx = createTestAgent(
        llmGenerateServices(async () => {
          calls += 1;
          if (calls === 1) {
            throw new APIConnectionError('terminated');
          }
          return {
            id: 'retry-response',
            message: { role: 'assistant', content: [], toolCalls: [] },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        }),
      );
      llmRequester = ctx.get(IAgentLLMRequesterService);

      await llmRequester.request();

      const requests = wireEvents(ctx, 'llm.request');
      expect(requests).toHaveLength(2);
      expect((requests[0]?.args as Record<string, unknown> | undefined)?.['attempt']).toBeUndefined();
      expect(requests[1]?.args).toMatchObject({ attempt: '2/3' });
    });

    it('records strict projection resends as separate outbound requests', async () => {
      await ctx.dispose();
      let calls = 0;
      ctx = createTestAgent(
        llmGenerateServices(async () => {
          calls += 1;
          if (calls === 1) {
            throw new APIStatusError(400, 'tool_use ids must be unique');
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
        }),
      );
      llmRequester = ctx.get(IAgentLLMRequesterService);

      await llmRequester.request({ retry: { maxAttempts: 1 } });

      const requests = wireEvents(ctx, 'llm.request');
      expect(requests).toHaveLength(2);
      expect((requests[0]?.args as Record<string, unknown> | undefined)?.['projection']).toBeUndefined();
      expect(requests[1]?.args).toMatchObject({ projection: 'strict' });
    });
  });

  describe('tool-call deltas', () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;

    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
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
        { turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: undefined },
        { turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: '{"query"' },
        { turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: ':"moon"}' },
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

  describe('retry', () => {
    let ctx: TestAgentContext | undefined;

    afterEach(async () => {
      vi.useRealTimers();
      if (ctx === undefined) return;
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        ctx = undefined;
      }
    });

    it('retries an APIConnectionError("terminated") and succeeds on a later attempt', async () => {
      vi.useFakeTimers();
      let calls = 0;
      const retryEvents: LLMRequestRetryContext[] = [];
      ctx = createTestAgent(
        llmGenerateServices(async () => {
          calls += 1;
          if (calls === 1) {
            throw new APIConnectionError('terminated');
          }
          return {
            id: 'retry-response',
            message: { role: 'assistant', content: [], toolCalls: [] },
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
          };
        }),
      );
      const llmRequester = ctx.get(IAgentLLMRequesterService);

      const responsePromise = llmRequester.request({
        retry: {
          onRetry: (event) => {
            retryEvents.push(event);
          },
        },
      });
      await vi.runAllTimersAsync();

      await expect(responsePromise).resolves.toMatchObject({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
      });
      expect(calls).toBe(2);
      expect(retryEvents).toEqual([
        expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          errorName: 'APIConnectionError',
          errorMessage: 'terminated',
        }),
      ]);
    });

    it('does not retry once the signal is aborted', async () => {
      let calls = 0;
      const controller = new AbortController();
      ctx = createTestAgent(
        llmGenerateServices(async () => {
          calls += 1;
          controller.abort();
          throw new APIConnectionError('terminated');
        }),
      );
      const llmRequester = ctx.get(IAgentLLMRequesterService);

      await expect(
        llmRequester.request(undefined, undefined, controller.signal),
      ).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(calls).toBe(1);
    });

    it('logs final request failures without request payloads or stacks', async () => {
      const entries: unknown[] = [];
      const logger: Logger = {
        warn: (_message: string, payload?: LogPayload) => entries.push(payload),
        error: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: () => logger,
      };
      ctx = createTestAgent(
        llmGenerateServices(async () => {
          throw new Error('temporary provider failure');
        }),
        logServices(logger),
      );
      const llmRequester = ctx.get(IAgentLLMRequesterService);

      await expect(
        llmRequester.request({
          source: {
            type: 'operation',
            requestKind: 'direct_test',
            logFields: { turnStep: '0.1' },
          },
          retry: { maxAttempts: 1 },
        }),
      ).rejects.toMatchObject({ message: 'temporary provider failure' });

      expect(entries).toEqual([
        expect.objectContaining({
          requestKind: 'direct_test',
          turnStep: '0.1',
          attempt: '1/1',
          model: expect.any(String),
          errorName: 'Error',
          errorMessage: 'temporary provider failure',
        }),
      ]);
      expect(JSON.stringify(entries)).not.toContain('messages');
      expect(JSON.stringify(entries)).not.toContain('stack');
    });
  });

  describe('request timing and budget', () => {
    let ctx: TestAgentContext;
    let llmRequester: IAgentLLMRequesterService;
    let profile: IAgentProfileService;
    let requestMaxTokens: unknown;
    let logEntries: CapturedLogEntry[];

    beforeEach(() => {
      requestMaxTokens = undefined;
      const { logger, entries } = captureLogs();
      logEntries = entries;
      ctx = createTestAgent(
        llmGenerateServices(async (provider, _systemPrompt, _tools, _messages, callbacks, options) => {
          requestMaxTokens = (
            provider as unknown as { readonly modelParameters: Record<string, unknown> }
          ).modelParameters['max_tokens'];
          options?.onRequestStart?.();
          await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
          options?.onStreamEnd?.();
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
        }),
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
      llmRequester = ctx.get(IAgentLLMRequesterService);
      profile = ctx.get(IAgentProfileService);
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

    it('emits stream timing and applies the model output budget through IAgentLLMRequesterService', async () => {
      const { parts, finish } = await collectLLMRequest((onPart) =>
        llmRequester.request(undefined, onPart),
      );

      expect(requestMaxTokens).toBe(384_000);
      expect(wireEvents(ctx, 'llm.request')[0]?.args).toMatchObject({
        maxTokens: 384_000,
      });
      expect(parts).toContainEqual({ type: 'text', text: 'timed' });
      expect(finish).toMatchObject({
        usage: emptyUsage(),
        model: 'deepseek/deepseek-v4-flash',
        providerMessageId: 'response-1',
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
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
        llmRequester.request(
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
      await llmRequester.request({ maxOutputSize: 123_000 });

      expect(requestMaxTokens).toBe(123_000);
    });

    it('carries kosong decode accounting and leaves the TTFT split undefined without a dispatch boundary', async () => {
      const { finish } = await collectLLMRequest((onPart) =>
        llmRequester.request(undefined, onPart),
      );
      const timing = finish.timing;

      expect(timing?.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
      // kosong accounts the decode window (server wait vs. client consume) and
      // the requester surfaces it on the timing event.
      expect(timing?.serverDecodeMs).toBeGreaterThanOrEqual(0);
      expect(timing?.clientConsumeMs).toBeGreaterThanOrEqual(0);
      // The scripted provider does not fire onRequestSent, so the TTFT split is
      // not reported through the requester event.
      expect(timing?.requestBuildMs).toBeUndefined();
      expect(timing?.serverFirstTokenMs).toBeUndefined();
    });
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
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [] };
}

async function collectLLMRequest(
  request: (onPart: (part: StreamedMessagePart) => void) => Promise<LLMRequestFinish>,
): Promise<{ parts: StreamedMessagePart[]; finish: LLMRequestFinish }> {
  const parts: StreamedMessagePart[] = [];
  const finish = await request((part) => {
    parts.push(part);
  });
  return { parts, finish };
}
