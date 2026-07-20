import { APIConnectionError, APIStatusError } from '#/kosong/contract/errors';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { type StreamedMessagePart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { emptyUsage } from '#/kosong/contract/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
} from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ILogger as Logger, LogPayload } from '#/_base/log/log';
import {
  configServices,
  createTestAgent,
  llmGenerateServices,
  logServices,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
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
      vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
      ctx = createTestAgent();
      llmRequester = ctx.get(IAgentLLMRequesterService);
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
        // The durable record's `provider` field carries the wire protocol:
        // Kimi is a vendor over the openai base, not a protocol.
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
      llmRequester = ctx.get(IAgentLLMRequesterService);
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
        llmGenerateServices(async () => {
          calls += 1;
          throw new APIConnectionError('terminated');
        }),
      );
      const llmRequester = ctx.get(IAgentLLMRequesterService);

      await expect(llmRequester.request()).rejects.toMatchObject({
        name: 'APIConnectionError',
      });
      expect(calls).toBe(1);
    });

    it('tracks api_error with the v1 wire shape (model id, alias, protocol, status code)', async () => {
      const records: TelemetryRecord[] = [];
      ctx = createTestAgent(
        llmGenerateServices(async () => {
          throw new APIStatusError(429, 'rate limited');
        }),
        telemetryServices(recordingTelemetry(records)),
      );
      const llmRequester = ctx.get(IAgentLLMRequesterService);

      await expect(llmRequester.request()).rejects.toMatchObject({
        name: 'APIStatusError',
      });

      expect(records).toContainEqual({
        event: 'api_error',
        properties: expect.objectContaining({
          error_type: 'rate_limit',
          model: 'mock-model',
          alias: 'mock-model',
          // vendor and wire protocol are separate fields now: the mock
          // provider is the kimi vendor over the openai base.
          provider_type: 'kimi',
          protocol: 'openai',
          retryable: expect.any(Boolean),
          duration_ms: expect.any(Number),
          status_code: 429,
        }),
      });
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
        llmGenerateServices(async (_provider, _systemPrompt, _tools, _messages, callbacks, options) => {
          // The per-turn completion budget arrives as a GenerateOptions
          // intent (the morph-era baked `modelParameters.max_tokens` is gone).
          requestMaxTokens = options?.maxCompletionTokens;
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
      expect(timing?.serverDecodeMs).toBeGreaterThanOrEqual(0);
      expect(timing?.clientConsumeMs).toBeGreaterThanOrEqual(0);
      expect(timing?.requestBuildMs).toBeUndefined();
      expect(timing?.serverFirstTokenMs).toBeUndefined();
    });
  });

  describe('per-turn intent handoff', () => {
    let ctx: TestAgentContext;
    let llmRequester: IAgentLLMRequesterService;
    let capturedCacheKey: unknown;

    beforeEach(() => {
      capturedCacheKey = undefined;
      ctx = createTestAgent(
        llmGenerateServices(async (_provider, _systemPrompt, _tools, _messages, _callbacks, options) => {
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
        }),
      );
      llmRequester = ctx.get(IAgentLLMRequesterService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('forwards the session id as the per-turn cache-key intent', async () => {
      // The engine half of the cache-key probe: the same session's id reaches
      // the composed provider as GenerateOptions.cacheKey. How each dialect
      // encodes it (Kimi `prompt_cache_key`, Anthropic `metadata.user_id`) is
      // asserted at the kosong/provider composition layer.
      await llmRequester.request();

      expect(capturedCacheKey).toBe('test-session');
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
  request: (onPart: (part: StreamedMessagePart) => void) => Promise<AgentLLMRequestFinish>,
): Promise<{ parts: StreamedMessagePart[]; finish: AgentLLMRequestFinish }> {
  const parts: StreamedMessagePart[] = [];
  const finish = await request((part) => {
    parts.push(part);
  });
  return { parts, finish };
}
