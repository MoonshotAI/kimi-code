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
  AgentLLMRequestFinish,
} from '#/agent/loop/requesterContract';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
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
      vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
      ctx = createTestAgent();
      llmRequester = ctx.get(IAgentLoopService).requester;
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('records one tools snapshot per unique provider-visible tool table and one request per outbound call', async () => {
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
      await llmRequester.request({
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
      await llmRequester.request({
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
        provider: 'openai',
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
      ctx.get(IAgentProfileService).update({ thinkingLevel: 'high' });
      ctx.mockNextResponse({ type: 'text', text: 'thinking response' });

      await llmRequester.request();

      expect(wireEvents(ctx, 'llm.request')).toHaveLength(1);
      expect(wireEvents(ctx, 'llm.request')[0]?.args).toMatchObject({
        thinkingEffort: 'on',
        thinkingKeep: 'all',
      });
    });

    it('records the env-forced Kimi effort used by the provider', async () => {
      await ctx.dispose();
      vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
      ctx = createTestAgent();
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
      const profile = ctx.get(IAgentProfileService);
      profile.update({ thinkingLevel: 'high' });
      expect(profile.data().thinkingLevel).toBe('on');
      expect(profile.resolveModelContext().thinkingLevel).toBe('max');
      ctx.mockNextResponse({ type: 'text', text: 'forced thinking response' });

      await llmRequester.request();

      expect(wireEvents(ctx, 'llm.request')).toHaveLength(1);
      expect(wireEvents(ctx, 'llm.request')[0]?.args).toMatchObject({
        thinkingEffort: 'max',
      });
    });

    it('records strict projection resends as separate outbound requests', async () => {
      await ctx.dispose();
      let calls = 0;
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
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
        })),
      );
      llmRequester = ctx.get(IAgentLoopService).requester;

      await llmRequester.request();

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
        { time: expect.any(Number), agentId: 'main', turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: undefined },
        { time: expect.any(Number), agentId: 'main', turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: '{"query"' },
        { time: expect.any(Number), agentId: 'main', turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: ':"moon"}' },
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
        llmRequester.request({
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

      await expect(llmRequester.request()).rejects.toMatchObject({
        name: 'APIConnectionError',
      });
      expect(calls).toBe(1);
    });

    it('tracks api_error with the v1 wire shape (model id, alias, protocol, status code)', async () => {
      const records: TelemetryRecord[] = [];
      ctx = createTestAgent(
        llmGenerateServices(requesterFromGenerateFn(async () => {
          throw new APIStatusError(429, 'rate limited');
        })),
        telemetryServices(recordingTelemetry(records)),
      );
      const llmRequester = ctx.get(IAgentLoopService).requester;

      await expect(llmRequester.request()).rejects.toMatchObject({
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
        llmRequester.request({ source: { type: 'turn', turnId: 3, step: 1 } }),
      ).rejects.toMatchObject({ name: 'APIConnectionError' });
      await expect(
        llmRequester.request({
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
    let profile: IAgentProfileService;
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

    it('emits stream timing and applies the model output budget through LoopRequester', async () => {
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
      await llmRequester.request();

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
        error: new APIStatusError(400, 'unsupported image format: image/avif is not supported'),
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

async function collectLLMRequest(
  request: (onPart: (part: StreamedMessagePart) => void) => Promise<AgentLLMRequestFinish>,
): Promise<{ parts: StreamedMessagePart[]; finish: AgentLLMRequestFinish }> {
  const parts: StreamedMessagePart[] = [];
  const finish = await request((part) => {
    parts.push(part);
  });
  return { parts, finish };
}
