import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIStatusError,
  generate as runKosongGenerate,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type Message,
  type StreamedMessage,
  type StreamedMessagePart,
  type ToolCall,
} from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KimiConfig } from '../../../src/config';
import type { AgentOptions } from '../../../src/agent';
import {
  COMPACTION_SUMMARY_PREFIX,
  DefaultCompactionStrategy,
  type CompactionStrategy,
} from '../../../src/agent/compaction';
import { FLAG_DEFINITIONS, MASTER_ENV } from '../../../src/flags';
import { HookEngine, type HookEngineTriggerArgs } from '../../../src/session/hooks';
import { estimateTokensForMessages } from '../../../src/utils/tokens';
import { recordingTelemetry, type TelemetryRecord } from '../../fixtures/telemetry';
import type { TestAgentContext, TestAgentOptions } from '../harness/agent';
import { testAgent } from '../harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;
const MICRO_COMPACTION_FLAG_ENV = getMicroCompactionFlagEnv();

describe('FullCompaction', () => {
  it('runs manual compaction and applies the compacted context', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('context.apply_compaction', () => {
        resolve();
      });
    });
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;
    await completed;

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "old user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user three" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin      { "source": "manual", "instruction": "Keep the important test facts.", "time": "<time>" }
      [emit] compaction.started         { "trigger": "manual", "instruction": "Keep the important test facts." }
      [wire] usage.record               { "model": "kimi-code", "usage": { "inputOther": 184, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 120, "maxContextTokens": 256000, "contextUsage": 0.00046875, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 184, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 184, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction   { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nCompacted summary.", "compactedCount": 6, "tokensBefore": 39, "tokensAfter": 119, "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 119, "maxContextTokens": 256000, "contextUsage": 0.00046484375, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 184, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 184, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete   { "time": "<time>" }
      [emit] compaction.completed       { "result": { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nCompacted summary.", "compactedCount": 6, "tokensBefore": 39, "tokensAfter": 119 } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "old user two"
        assistant: text "old assistant two"
        user: text "recent user three"
        assistant: text "recent assistant three"
        user: text "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\\n\\nInclude:\\n- Current progress and key decisions made\\n- Important context, constraints, or user preferences\\n- What remains to be done (clear next steps)\\n- Any critical data, examples, or references needed to continue\\n\\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\\n\\nRespond with text only. Do not call any tools — you already have everything you need in the conversation history.\\n\\nKeep the important test facts."
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`
      [
        {
          "role": "user",
          "text": "old user one",
        },
        {
          "role": "user",
          "text": "old user two",
        },
        {
          "role": "user",
          "text": "recent user three",
        },
        {
          "role": "user",
          "text": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
      Compacted summary.",
        },
      ]
    `);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'manual',
        instruction: 'Keep the important test facts.',
        tokensBefore: 39,
        tokensAfter: 119,
        duration_ms: expect.any(Number),
        compactedCount: 6,
        retryCount: 0,
        thinkingLevel: 'off',
        inputOther: 184,
        output: 8,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('refreshes the system prompt after compaction completes', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 40);

    const refreshSpy = vi.spyOn(ctx.agent, 'refreshSystemPrompt');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('projects the compacted prefix before sending the summary request', async () => {
    const ctx = testAgent({ compactionStrategy: alwaysCompactOnce });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'empty-placeholder', turnId: '', step: 2 },
    });
    ctx.appendExchange(3, 'old user two', 'old assistant two', 40);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('context.apply_compaction', () => {
        resolve();
      });
    });

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;

    const [compactionCall] = ctx.llmCalls;
    expect(compactionCall?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(
      compactionCall?.history.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.length === 0 &&
          message.toolCalls.length === 0,
      ),
    ).toBe(false);
  });

  it('micro-compacts old tool results before sending the summary request', async () => {
    vi.useFakeTimers();
    enableMicroCompactionFlag();
    const ctx = testAgent({
      compactionStrategy: alwaysCompactOnce,
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
        minContextUsageRatio: 0,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.microCompaction.detect();
    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Summarize tool exchanges.' });
    await compacted;

    const [compactionCall] = ctx.llmCalls;
    expect(messageText(compactionCall?.history[2])).toBe('[Old tool result content cleared]');
    expect(messageText(compactionCall?.history[5])).toBe('lookup result');
  });

  it('force-refreshes OAuth credentials on compaction 401 and falls back to login_required when replay 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthTestAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      _callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      if (authKeys.length <= 2) {
        throw new APIStatusError(401, 'Unauthorized', 'req-compact-401');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const outcome = ctx.onceAny(['context.apply_compaction', 'error']);

    await ctx.rpc.beginCompaction({});

    expect(await outcome).toBe('error');
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        event: 'error',
        args: expect.objectContaining({
          code: 'auth.login_required',
          details: expect.objectContaining({
            statusCode: 401,
            requestId: 'req-compact-401',
          }),
        }),
      }),
    );
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);

    const retryOutcome = ctx.onceAny(['context.apply_compaction', 'error']);
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});

    expect(await retryOutcome).toBe('context.apply_compaction');
    await completed;
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token', 'fresh-token']);
    expect(tokenCalls).toEqual([undefined, true, undefined]);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nRecovered compacted summary.` },
    ]);
    await ctx.expectResumeMatches();
  });

  it('fires PreCompact and PostCompact hooks from the compaction module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-compact-hooks-'));
    const hookLog = join(dir, 'hooks.jsonl');
    const hookCommand = hookPayloadLoggerCommand(hookLog);
    const ctx = testAgent({
      hookEngine: new HookEngine(
        [
          { event: 'PreCompact', matcher: 'auto', command: hookCommand, timeout: 5 },
          { event: 'PostCompact', matcher: 'auto', command: hookCommand, timeout: 5 },
        ],
        { cwd: dir, sessionId: 'session-hooks' },
      ),
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = ctx.once('context.apply_compaction');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    ctx.agent.fullCompaction.begin({ source: 'auto', instruction: undefined });
    await compacted;
    await vi.waitFor(() => {
      expect(readHookPayloads(hookLog).map((payload) => payload['hook_event_name'])).toEqual([
        'PreCompact',
        'PostCompact',
      ]);
    });

    const [pre, post] = readHookPayloads(hookLog);
    expect(pre).toMatchObject({
      hook_event_name: 'PreCompact',
      session_id: 'session-hooks',
      cwd: dir,
      trigger: 'auto',
      token_count: 39,
    });
    expect(post).toMatchObject({
      hook_event_name: 'PostCompact',
      session_id: 'session-hooks',
      cwd: dir,
      trigger: 'auto',
      estimated_token_count: ctx.agent.context.tokenCount,
    });
  });

  it('cancels while waiting for a PreCompact hook', async () => {
    let preCompactSignal: AbortSignal | undefined;
    const trigger = vi.fn(async (_event: string, args?: HookEngineTriggerArgs) => {
      preCompactSignal = args?.signal;
      await new Promise<void>((resolve) => {
        args?.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      return [];
    });
    const ctx = testAgent({ hookEngine: { trigger } as unknown as HookEngine });

    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);

    ctx.agent.fullCompaction.begin({ source: 'manual', instruction: undefined });
    await vi.waitFor(() => {
      expect(preCompactSignal).toBeInstanceOf(AbortSignal);
    });
    const canceled = ctx.once('compaction.cancelled');
    ctx.agent.fullCompaction.cancel();
    await canceled;

    expect(trigger).toHaveBeenCalledWith(
      'PreCompact',
      expect.objectContaining({
        matcherValue: 'manual',
        inputData: expect.objectContaining({ trigger: 'manual' }),
      }),
    );
    expect(preCompactSignal?.aborted).toBe(true);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('reports compaction retry_count after a retryable generation failure recovers', async () => {
    const records: TelemetryRecord[] = [];
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new APIConnectionError('socket hang up');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(attempts).toBe(2);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'manual',
        tokensBefore: 25,
        retryCount: 1,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('retries compaction responses with empty summaries before applying context', async () => {
    vi.useFakeTimers();
    const firstEmptySummary = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts <= 2) {
        if (attempts === 1) firstEmptySummary.resolve();
        return textResult(attempts === 1 ? '' : '   \n');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await firstEmptySummary.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;
    await completed;

    expect(attempts).toBe(3);
    // Empty summaries are retried without shrinking the history; the recovered
    // summary replaces the whole history with the real user messages plus the
    // prefixed summary.
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nRecovered compacted summary.` },
    ]);
    expect(
      ctx.allEvents.filter((event) => event.event === 'compaction.completed'),
    ).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: expect.stringContaining('Recovered compacted summary.'),
          }),
        }),
      }),
    ]);
    await ctx.expectResumeMatches();
  });

  it('reduces the compacted prefix and retries when the model returns only thinking content', async () => {
    // End-to-end through the real kosong generate(): a think-only stream (think
    // parts, no text, no tool calls) makes generate() itself throw
    // APIEmptyResponseError. Compaction must treat that like a truncated summary
    // — shrink the compacted prefix and retry — rather than resend the identical
    // request that produced no summary.
    vi.useFakeTimers();
    const firstThinkOnly = deferred<void>();
    const inputs: string[][] = [];
    const generate = realKosongGenerate((attempt, history) => {
      inputs.push(inputHistorySnapshot(history));
      if (attempt === 1) {
        firstThinkOnly.resolve();
        return mockStreamedMessage([
          { type: 'think', think: 'Reasoning about the summary but never writing it...' },
        ]);
      }
      return mockStreamedMessage([{ type: 'text', text: 'Recovered compacted summary.' }]);
    });
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await firstThinkOnly.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;
    await completed;

    expect(inputs).toHaveLength(2);
    // The retry sends a strictly smaller input than the first attempt.
    expect(inputs[1]!.length).toBeLessThan(inputs[0]!.length);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nRecovered compacted summary.` },
    ]);
    await ctx.expectResumeMatches();
  });

  it('fails after exhausting retries when the model only ever returns thinking content', async () => {
    // End-to-end through the real kosong generate(): every attempt is think-only,
    // so generate() keeps throwing APIEmptyResponseError. Compaction shrinks the
    // prefix on each retry but eventually exhausts MAX_COMPACTION_RETRY_ATTEMPTS
    // and fails without ever applying a summary.
    vi.useFakeTimers();
    const records: TelemetryRecord[] = [];
    const inputs: string[][] = [];
    const generate = realKosongGenerate((_attempt, history) => {
      inputs.push(inputHistorySnapshot(history));
      return mockStreamedMessage([
        { type: 'think', think: 'Still only thinking, no summary produced.' },
      ]);
    });
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;

    // Each empty/think-only response drops the oldest item and resets the retry
    // counter; once only one item remains, MAX_COMPACTION_RETRY_ATTEMPTS more
    // retries run before failing. 3 drops + 5 retries = 8 generate calls.
    expect(inputs).toHaveLength(8);
    expect(inputs[1]!.length).toBeLessThan(inputs[0]!.length);
    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({
        source: 'manual',
        retryCount: 4,
        errorType: 'APIEmptyResponseError',
      }),
    });
    // No summary was ever applied; the original history is left intact.
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);
  });

  it('waits before retrying compaction generation after a retryable failure', async () => {
    vi.useFakeTimers();
    const firstAttemptFailed = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptFailed.resolve();
        throw new APIConnectionError('socket hang up');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('context.apply_compaction');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFailed.promise;
    await vi.advanceTimersByTimeAsync(299);

    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;

    expect(attempts).toBe(2);
    await ctx.expectResumeMatches();
  });

  it('cancels retry backoff without issuing another compaction request', async () => {
    vi.useFakeTimers();
    const firstAttemptFailed = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptFailed.resolve();
      }
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const cancelled = ctx.once('compaction.cancelled');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFailed.promise;

    ctx.agent.fullCompaction.cancel();
    await cancelled;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts).toBe(1);
    await ctx.expectResumeMatches();
  });

  it('cancels the compaction lifecycle when manual compaction generation fails', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw new Error('compaction exploded');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await failed;

    const events = ctx.newEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.cancel' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.cancelled' }),
        expect.objectContaining({ type: '[rpc]', event: 'error' }),
      ]),
    );
    expect(eventIndex(events, 'compaction.cancelled')).toBeLessThan(eventIndex(events, 'error'));
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);
    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({
        source: 'manual',
        tokensBefore: 25,
        duration_ms: expect.any(Number),
        round: 1,
        retryCount: 0,
        errorType: 'Error',
      }),
    });
    expect(
      records.find((record) => record.event === 'compaction_failed')?.properties,
    ).not.toHaveProperty('tokensAfter');
    await ctx.expectResumeMatches();
  });

  it('fails a blocked turn when auto compaction generation fails', async () => {
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      throw new APIStatusError(400, 'Bad request');
    };
    const ctx = testAgent({ generate, compactionStrategy: alwaysCompactOnce });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger failed auto compaction' }] });
    const events = await ctx.untilTurnEnd();

    expect(attempts).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'error' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: {
          turnId: 0,
          reason: 'failed',
          error: expect.objectContaining({
            code: 'compaction.failed',
            message: 'APIStatusError: Bad request',
          }),
        },
      }),
    );
    const errorEvents = ctx.newEvents();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      event: 'error',
      args: expect.objectContaining({
        code: 'compaction.failed',
        message: 'APIStatusError: Bad request',
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('names truncated compaction responses when retries are exhausted', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      return {
        ...textResult('Partial summary.'),
        finishReason: 'truncated',
        rawFinishReason: 'length',
      };
    };
    const ctx = testAgent({ generate, compactionStrategy: alwaysCompactOnce });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger truncated auto compaction' }] });
    await vi.advanceTimersByTimeAsync(60_000);
    const events = await ctx.untilTurnEnd();

    // A single-item history cannot be shrunk further, so the truncated response
    // fails immediately instead of looping through retries.
    expect(attempts).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: {
          turnId: 0,
          reason: 'failed',
          error: expect.objectContaining({
            code: 'compaction.failed',
            message:
              'CompactionTruncatedError: Compaction response was truncated before producing a complete summary.',
          }),
        },
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('reports compaction retry_count when retryable generation failures are exhausted', async () => {
    vi.useFakeTimers();
    const records: TelemetryRecord[] = [];
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;

    expect(attempts).toBe(5);
    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({
        source: 'manual',
        tokensBefore: 25,
        duration_ms: expect.any(Number),
        retryCount: 4,
        errorType: 'APIConnectionError',
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('renders rich compacted history without dropping non-text context', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendRichToolExchange();
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('context.apply_compaction', () => {
        resolve();
      });
    });

    ctx.mockNextResponse({ type: 'text', text: 'Rich summary.' });
    const completed = ctx.once('compaction.completed');
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    await ctx.expectResumeMatches();
  });

  it('keeps an unresolved tool exchange out of the compaction prompt', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendPartiallyResolvedParallelToolExchange();
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted before open tools.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep stable facts.' });
    await compacted;
    await completed;

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "run both tools"
        assistant: []  calls call_open_one:LookupOne { "query": "one" }, call_open_two:LookupTwo { "query": "two" }
        tool[call_open_one]: text "one result"
        user: text "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\\n\\nInclude:\\n- Current progress and key decisions made\\n- Important context, constraints, or user preferences\\n- What remains to be done (clear next steps)\\n- Any critical data, examples, or references needed to continue\\n\\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\\n\\nRespond with text only. Do not call any tools — you already have everything you need in the conversation history.\\n\\nKeep stable facts."
    `);
    // The unresolved tool exchange is sent to the model (see the compaction input
    // above) but is dropped from the replacement history, leaving only the real
    // user messages followed by the compaction summary.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_open_two',
        toolCallId: 'call_open_two',
        result: { output: 'two result' },
      },
    });
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    await ctx.expectResumeMatches();
  });

  it('keeps messages appended while compacting an unchanged prefix', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted prefix.' });
    await ctx.rpc.beginCompaction({});
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'new user while compacting' }]);
    await compacted;
    await completed;

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin      { "source": "manual", "time": "<time>" }
      [emit] compaction.started         { "trigger": "manual" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "new user while compacting" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] usage.record               { "model": "kimi-code", "usage": { "inputOther": 162, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 80, "maxContextTokens": 256000, "contextUsage": 0.0003125, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 162, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 162, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction   { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nCompacted prefix.", "compactedCount": 4, "tokensBefore": 25, "tokensAfter": 114, "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 114, "maxContextTokens": 256000, "contextUsage": 0.0004453125, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 162, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 162, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete   { "time": "<time>" }
      [emit] compaction.completed       { "result": { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nCompacted prefix.", "compactedCount": 4, "tokensBefore": 25, "tokensAfter": 114 } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "recent user two"
        assistant: text "recent assistant two"
        user: text "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\\n\\nInclude:\\n- Current progress and key decisions made\\n- Important context, constraints, or user preferences\\n- What remains to be done (clear next steps)\\n- Any critical data, examples, or references needed to continue\\n\\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\\n\\nRespond with text only. Do not call any tools — you already have everything you need in the conversation history."
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`
      [
        {
          "role": "user",
          "text": "old user one",
        },
        {
          "role": "user",
          "text": "recent user two",
        },
        {
          "role": "user",
          "text": "new user while compacting",
        },
        {
          "role": "user",
          "text": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
      Compacted prefix.",
        },
      ]
    `);
    await ctx.expectResumeMatches();
  });


  it('cancels when the compacted prefix changes before completion', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const canceled = ctx.once('full_compaction.cancel');

    ctx.mockNextResponse({ type: 'text', text: 'Stale summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.rpc.clearContext({});
    await canceled;

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin    { "source": "manual", "time": "<time>" }
      [emit] compaction.started       { "trigger": "manual" }
      [wire] context.clear            { "time": "<time>" }
      [emit] agent.status.updated     { "model": "kimi-code", "contextTokens": 0, "maxContextTokens": 256000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "manual" }
      [wire] usage.record             { "model": "kimi-code", "usage": { "inputOther": 162, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated     { "model": "kimi-code", "contextTokens": 0, "maxContextTokens": 256000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 162, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 162, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.cancel   { "time": "<time>" }
      [emit] compaction.cancelled     {}
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "recent user two"
        assistant: text "recent assistant two"
        user: text "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\\n\\nInclude:\\n- Current progress and key decisions made\\n- Important context, constraints, or user preferences\\n- What remains to be done (clear next steps)\\n- Any critical data, examples, or references needed to continue\\n\\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\\n\\nRespond with text only. Do not call any tools — you already have everything you need in the conversation history."
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`[]`);
    await ctx.expectResumeMatches();
  });

  it('blocks the turn until auto compaction finishes', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 100);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 200);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 950_000);

    ctx.mockNextResponse({ type: 'text', text: 'Auto compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer after compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Answer after compacting' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "old user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user three" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Answer after compacting" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Answer after compacting" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin       { "source": "auto", "time": "<time>" }
      [emit] compaction.started          { "trigger": "auto" }
      [emit] compaction.blocked          { "turnId": 0 }
      [wire] usage.record                { "model": "kimi-code", "usage": { "inputOther": 183, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated        { "model": "kimi-code", "contextTokens": 950000, "maxContextTokens": 256000, "contextUsage": 3.7109375, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 183, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 183, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction    { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nAuto compacted summary.", "compactedCount": 7, "tokensBefore": 46, "tokensAfter": 127, "time": "<time>" }
      [emit] agent.status.updated        { "model": "kimi-code", "contextTokens": 127, "maxContextTokens": 256000, "contextUsage": 0.00049609375, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 183, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 183, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete    { "time": "<time>" }
      [emit] compaction.completed        { "result": { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nAuto compacted summary.", "compactedCount": 7, "tokensBefore": 46, "tokensAfter": 127 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I can answer after compaction." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I can answer after compaction." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 126, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 126, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "kimi-code", "usage": { "inputOther": 126, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "kimi-code", "contextTokens": 137, "maxContextTokens": 256000, "contextUsage": 0.00053515625, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 309, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 309, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 126, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "old user one"
          assistant: text "old assistant one"
          user: text "old user two"
          assistant: text "old assistant two"
          user: text "recent user three"
          assistant: text "recent assistant three"
          user: text "Answer after compacting"
          user: text "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\\n\\nInclude:\\n- Current progress and key decisions made\\n- Important context, constraints, or user preferences\\n- What remains to be done (clear next steps)\\n- Any critical data, examples, or references needed to continue\\n\\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\\n\\nRespond with text only. Do not call any tools — you already have everything you need in the conversation history."

      call 2:
        messages:
          user: text "old user one\\n\\nold user two\\n\\nrecent user three\\n\\nAnswer after compacting"
          user: text "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nAuto compacted summary."
    `);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'auto',
        tokensBefore: 46,
        tokensAfter: 127,
        compactedCount: 7,
        retryCount: 0,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('keeps a deferred system reminder behind an unresolved tool exchange across compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendUnresolvedToolExchange(0);
    ctx.agent.context.appendSystemReminder('host note', {
      kind: 'injection',
      variant: 'host',
    });

    // Tool exchange is open, so the reminder is deferred — not yet in history.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);

    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted with open tools.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    // Compaction drops the in-flight tool exchange and the deferred reminder
    // (initial context is rebuilt every turn); only real user messages and
    // the compaction summary remain.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.agent.context.history.at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    // The dropped tool calls no longer exist, so late tool results are orphans
    // and do not change history.
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_one',
        toolCallId: 'call_unresolved_one',
        result: { output: 'one result' },
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_two',
        toolCallId: 'call_unresolved_two',
        result: { output: 'two result' },
      },
    });

    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
  });

  it('keeps a deferred system reminder behind a partially resolved tool exchange across compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendUnresolvedToolExchange(1);
    ctx.agent.context.appendSystemReminder('host note', {
      kind: 'injection',
      variant: 'host',
    });

    // One tool result has landed but the second is still pending — reminder defers.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);

    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted with partial tools.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    // Compaction drops the partially-resolved tool exchange and the deferred
    // reminder (initial context is rebuilt every turn); only real user
    // messages and the compaction summary remain.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.agent.context.history.at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    // The dropped tool calls no longer exist, so a late tool result is an orphan
    // and does not change history.
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_two',
        toolCallId: 'call_unresolved_two',
        result: { output: 'two result' },
      },
    });

    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
  });

  it('rejects manual compaction with compaction.unable when history is empty', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    await expect(ctx.rpc.beginCompaction({})).rejects.toMatchObject({
      code: 'compaction.unable',
    });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('compacts a single user message and keeps it ahead of the summary', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'only pending user' }]);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Single message summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'only pending user' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nSingle message summary.` },
    ]);
    await ctx.expectResumeMatches();
  });

  it('does not auto compact small contexts when reserved size exceeds the model window', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { reservedContextSize: 50_000 },
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 32_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_000);

    ctx.mockNextResponse({ type: 'text', text: 'I can answer without reserved compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'small prompt' }] });
    const events = await ctx.untilTurnEnd();

    expect(eventIndex(events, 'compaction.started')).toBe(-1);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]?.history.map(messageText)).toContain('old assistant one');
    expect(messageText(ctx.llmCalls[0]?.history.at(-1))).toBe('small prompt');
    await ctx.expectResumeMatches();
  });

  it('triggers auto compaction when pending tokens cross the reserved threshold', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { reservedContextSize: 500 },
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 2_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_400);

    ctx.mockNextResponse({ type: 'text', text: 'Reserved compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer after reserved compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'x'.repeat(440) }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const [compactionCall, answerCall] = ctx.llmCalls;
    expect(messageText(compactionCall?.history.at(-1))).toContain('CONTEXT CHECKPOINT COMPACTION');
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('Reserved compacted summary.')),
    ).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('keeps an oversized pending user prompt out of auto compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 2_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_650);
    const oversizedPrompt = `keep-this-pending-verbatim:${'x'.repeat(1_800)}`;

    ctx.mockNextResponse({ type: 'text', text: 'Oversized prompt summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer the oversized prompt.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: oversizedPrompt }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const [compactionCall, answerCall] = ctx.llmCalls;
    const compactionTexts = compactionCall?.history.map(messageText) ?? [];
    // The whole history is compacted, so the pending prompt is included in the
    // compaction input and kept verbatim in the post-compaction replacement.
    expect(compactionTexts.some((text) => text.includes('keep-this-pending-verbatim'))).toBe(true);
    expect(compactionCall?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
    ]);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('Oversized prompt summary.')),
    ).toBe(true);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('keep-this-pending-verbatim')),
    ).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('triggers auto compaction when pending tokens cross the ratio threshold', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 1_000_000,
      },
    });
    // The auto-compact ratio is 0.85, so the context alone (840k) sits below
    // the 850k threshold and the pending prompt pushes it over.
    ctx.appendExchange(1, 'old user one', 'old assistant one', 840_000);
    const pendingPrompt = `ratio-pending-verbatim:${'x'.repeat(60_000)}`;

    ctx.mockNextResponse({ type: 'text', text: 'Ratio compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer the ratio pending prompt.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: pendingPrompt }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const [compactionCall, answerCall] = ctx.llmCalls;
    const compactionTexts = compactionCall?.history.map(messageText) ?? [];
    // The whole history is compacted, so the pending prompt is included in the
    // compaction input and kept verbatim in the post-compaction replacement.
    expect(compactionTexts.some((text) => text.includes('ratio-pending-verbatim'))).toBe(true);
    expect(compactionCall?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
    ]);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('Ratio compacted summary.')),
    ).toBe(true);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('ratio-pending-verbatim')),
    ).toBe(true);

    await ctx.expectResumeMatches();
  });

  it('compacts and retries when the provider reports context overflow', async () => {
    let callCount = 0;
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history, callbacks) => {
      callCount += 1;
      inputs.push(inputHistorySnapshot(history));
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-context-overflow');
      }
      if (callCount === 2) {
        return textResult('Overflow compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after overflow compaction.',
        });
        return textResult('Recovered after overflow compaction.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry after provider overflow' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'context.apply_compaction',
        args: expect.objectContaining({
          summary: expect.stringContaining('Overflow compacted summary.'),
          compactedCount: 4,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
    expect(inputs).toMatchInlineSnapshot(`
      [
        [
          "user: old user one",
          "assistant: old assistant one",
          "user: Retry after provider overflow",
        ],
        [
          "user: old user one",
          "assistant: old assistant one",
          "user: Retry after provider overflow",
          "user: <compaction-instruction>",
        ],
        [
          "user: old user one

      Retry after provider overflow",
          "user: Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
      Overflow compacted summary.",
        ],
      ]
    `);
    await ctx.expectResumeMatches();
  });

  it('recovers from plain 413 when estimated request is over effective max', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIStatusError(413, 'Request Entity Too Large', 'req-plain-413');
      }
      if (callCount === 2) {
        return textResult('Plain 413 compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered after plain 413 compaction.',
      });
      return textResult('Recovered after plain 413 compaction.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 200_000,
      },
    });
    ctx.appendExchange(1, 'old user one', `old assistant one ${'x'.repeat(600_000)}`, 150_000);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry after plain 413' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(ctx.agent.fullCompaction.getEffectiveMaxContextTokens()).toBeLessThan(200_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('does not compact plain 413 when estimated request is small', async () => {
    const generate: GenerateFn = async () => {
      throw new APIStatusError(413, 'Request Entity Too Large', 'req-small-413');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 200_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'small prompt' }] });
    const events = await ctx.untilTurnEnd();

    expect(eventIndex(events, 'compaction.started')).toBe(-1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ turnId: 0, reason: 'failed' }),
      }),
    );
  });

  it('preserves thinking effort when compacting after provider context overflow', async () => {
    let callCount = 0;
    const records: TelemetryRecord[] = [];
    const providerThinkingEfforts: Array<Parameters<GenerateFn>[0]['thinkingEffort']> = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      providerThinkingEfforts.push(provider.thinkingEffort);
      if (callCount === 1) {
        throw new APIContextOverflowError(
          400,
          'Context length exceeded',
          'req-thinking-context-overflow',
        );
      }
      if (callCount === 2) {
        return textResult('Thinking compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after thinking compaction.',
        });
        return textResult('Recovered after thinking compaction.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.agent.config.update({ thinkingLevel: 'high' });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with thinking preserved' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(providerThinkingEfforts).toEqual(['high', 'high', 'high']);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'auto',
        thinkingLevel: 'high',
      }),
    });
  });

  it('compacts provider overflow when model context size is unknown', async () => {
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-unknown-context');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Unknown window compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered with unknown context size.',
        });
        return textResult('Recovered with unknown context size.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    const providerManager = ctx.agent.modelProvider;
    if (providerManager === undefined) throw new Error('Expected provider manager');
    const resolveProviderConfig = providerManager.resolveProviderConfig.bind(providerManager);
    providerManager.resolveProviderConfig = (model) => ({
      ...resolveProviderConfig(model),
      modelCapabilities: UNKNOWN_CAPABILITY,
    });
    expect(ctx.agent.config.modelCapabilities.max_context_tokens).toBe(0);
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry without known model window' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([32000]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'context.apply_compaction',
        args: expect.objectContaining({
          summary: expect.stringContaining('Unknown window compacted summary.'),
          compactedCount: 4,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
  });

  it('honors completion budget env hard caps during compaction', async () => {
    vi.stubEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS', '8192');
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-hard-cap');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Hard cap compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with hard cap.',
      });
      return textResult('Recovered with hard cap.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with hard cap' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([8192]);
  });

  it('honors completion budget env opt-out during compaction', async () => {
    vi.stubEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS', '0');
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-opt-out');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Opt-out compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with opt-out.',
      });
      return textResult('Recovered with opt-out.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with opt-out' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([undefined]);
  });

  it('honors maxOutputSize from model config during compaction', async () => {
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-max-output');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Max output compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with max output.',
      });
      return textResult('Recovered with max output.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    // Set maxOutputSize on the harness's internal kimiConfig — the
    // compaction path reads it via ConfigState.maxOutputSize.
    const models = (ctx as unknown as { kimiConfig: KimiConfig }).kimiConfig.models;
    models![CATALOGUED_PROVIDER.model] = {
      ...models![CATALOGUED_PROVIDER.model]!,
      maxOutputSize: 384000,
    };
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with max output' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([384000]);
  });

  it('uses default 128k hardCap when maxOutputSize is not configured', async () => {
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-default-cap');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Default cap compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with default cap.',
      });
      return textResult('Recovered with default cap.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with default cap' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([128 * 1024]);
  });

  it('ignores filtered assistant placeholders when checking the retained overflow suffix', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(
          400,
          'Context length exceeded',
          'req-placeholder-boundary',
        );
      }
      if (callCount === 2) {
        return textResult('Placeholder compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after ignoring the placeholder.',
        });
        return textResult('Recovered after ignoring the placeholder.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({
      generate,
      compactionStrategy: overflowOnlyCompactionStrategy(),
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 14,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1);
    const promptThatFitsWithoutPlaceholder = 'x'.repeat(40);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: promptThatFitsWithoutPlaceholder }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'context.apply_compaction',
        args: expect.objectContaining({
          summary: expect.stringContaining('Placeholder compacted summary.'),
          compactedCount: 4,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
  });

  it('emits context.overflow and terminates the turn after too many auto compactions', async () => {
    const ctx = testAgent({ compactionStrategy: alwaysCompactOnce });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'First compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I need a tool.' }, missingToolCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger repeated compaction' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Trigger repeated compaction" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Trigger repeated compaction" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin       { "source": "auto", "time": "<time>" }
      [emit] compaction.started          { "trigger": "auto" }
      [emit] compaction.blocked          { "turnId": 0 }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 145, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 145, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 145, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction    { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nFirst compacted summary.", "compactedCount": 1, "tokensBefore": 8, "tokensAfter": 114, "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 114, "maxContextTokens": 1000000, "contextUsage": 0.000114, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 145, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 145, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete    { "time": "<time>" }
      [emit] compaction.completed        { "result": { "summary": "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nFirst compacted summary.", "compactedCount": 1, "tokensBefore": 8, "tokensAfter": 114 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I need a tool." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_missing", "name": "MissingTool", "argumentsPart": "{}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I need a tool." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_missing", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_missing", "name": "MissingTool", "args": {} }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_missing", "name": "MissingTool", "args": {} }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_missing", "toolCallId": "call_missing", "result": { "output": "Tool \\"MissingTool\\" not found", "isError": true } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_missing", "output": "Tool \\"MissingTool\\" not found", "isError": true }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 115, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 115, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 115, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 126, "maxContextTokens": 1000000, "contextUsage": 0.000126, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 260, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 260, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 115, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 2, "reason": "error", "message": "Compaction limit exceeded (1)" }
      [emit] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "context.overflow", "message": "Compaction limit exceeded (1)", "name": "KimiError", "details": { "maxCompactions": 1, "turnId": 0 }, "retryable": true } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "context.overflow", "message": "Compaction limit exceeded (1)", "name": "KimiError", "details": { "maxCompactions": 1, "turnId": 0 }, "retryable": true }`,
    );
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "Trigger repeated compaction"
          user: text "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\\n\\nInclude:\\n- Current progress and key decisions made\\n- Important context, constraints, or user preferences\\n- What remains to be done (clear next steps)\\n- Any critical data, examples, or references needed to continue\\n\\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.\\n\\nRespond with text only. Do not call any tools — you already have everything you need in the conversation history."

      call 2:
        messages:
          user: text "Trigger repeated compaction"
          user: text "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\nFirst compacted summary."
    `);
    await ctx.expectResumeMatches();
  });

});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function enableMicroCompactionFlag(): void {
  vi.stubEnv(MASTER_ENV, '0');
  vi.stubEnv(MICRO_COMPACTION_FLAG_ENV, '1');
}

function getMicroCompactionFlagEnv(): string {
  const flag = FLAG_DEFINITIONS.find((definition) => definition.id === 'micro_compaction');
  if (flag === undefined) {
    throw new Error('Missing micro_compaction flag definition.');
  }
  return flag.env;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventIndex(events: ReturnType<TestAgentContext['newEvents']>, type: string): number {
  return events.findIndex((event) => {
    if (typeof event !== 'object' || event === null) return false;
    return (event as { readonly event?: unknown }).event === type;
  });
}

function countEvents(events: ReturnType<TestAgentContext['newEvents']>, type: string): number {
  return events.filter((event) => {
    if (typeof event !== 'object' || event === null) return false;
    return (event as { readonly event?: unknown }).event === type;
  }).length;
}

function oauthTestAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
): Pick<TestAgentOptions, 'initialConfig' | 'providerManagerOverrides'> {
  return {
    initialConfig: {
      defaultModel: 'kimi-code',
      providers: {
        'managed:kimi-code': {
          type: 'vertexai',
          baseUrl: 'https://api.example/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'kimi-code': {
          provider: 'managed:kimi-code',
          model: 'kimi-for-coding',
          maxContextSize: 1_000_000,
        },
      },
    },
    providerManagerOverrides: {
      resolveOAuthTokenProvider: () => ({ getAccessToken }),
    },
  };
}

function providerMaxCompletionTokens(provider: Parameters<GenerateFn>[0]): unknown {
  return (
    provider as {
      readonly modelParameters?: Record<string, unknown>;
    }
  ).modelParameters?.['max_completion_tokens'];
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-compaction-oauth-retry',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function mockStreamedMessage(parts: readonly StreamedMessagePart[]): StreamedMessage {
  return {
    get id(): string | null {
      return 'mock-stream';
    },
    get usage() {
      return null;
    },
    finishReason: null,
    rawFinishReason: null,
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

// Runs the REAL kosong generate() over a scripted provider stream so think-only
// and empty responses exercise kosong's actual APIEmptyResponseError path rather
// than a mocked generate function that throws directly.
function realKosongGenerate(
  script: (attempt: number, history: readonly Message[]) => StreamedMessage,
): GenerateFn {
  let attempt = 0;
  return (chat, systemPrompt, tools, history, callbacks, options) => {
    attempt += 1;
    const currentAttempt = attempt;
    const provider: ChatProvider = {
      name: 'mock-think-only',
      modelName: chat.modelName,
      thinkingEffort: chat.thinkingEffort,
      generate: () => Promise.resolve(script(currentAttempt, history)),
      withThinking() {
        return provider;
      },
    };
    return runKosongGenerate(provider, systemPrompt, tools, history, callbacks, options);
  };
}

const alwaysCompactOnce: CompactionStrategy = {
  shouldCompact: () => true,
  shouldBlock: () => true,
  checkAfterStep: true,
  maxCompactionPerTurn: 1,
};

function missingToolCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_missing',
    name: 'MissingTool',
    arguments: '{}',
  };
}

function overflowOnlyCompactionStrategy(maxSize: number = 14): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: Infinity,
    blockRatio: Infinity,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
  });
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function messageText(message: Message | undefined): string {
  return message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

function hookPayloadLoggerCommand(logPath: string): string {
  // Write the hook script to a file and run it with node, instead of
  // `node -e <json>` — cmd.exe on Windows mangles the escaped quotes in the
  // inline form and corrupts the script before it can run.
  const scriptPath = `${logPath}.cjs`;
  const script = [
    "const fs = require('node:fs');",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    `  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(JSON.parse(input)) + '\\n');`,
    '});',
  ].join('');
  writeFileSync(scriptPath, script);
  return `${process.execPath} ${scriptPath}`;
}

function readHookPayloads(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf-8').trim();
  if (text.length === 0) return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function inputHistorySnapshot(history: readonly Message[]): string[] {
  return history.map((message) => {
    const text = message.content
      .map((part) => (part.type === 'text' ? normalizeInputText(part.text) : ''))
      .join('');
    return `${message.role}: ${text}`;
  });
}

function normalizeInputText(text: string): string {
  return text.includes('CONTEXT CHECKPOINT COMPACTION') ? '<compaction-instruction>' : text;
}
