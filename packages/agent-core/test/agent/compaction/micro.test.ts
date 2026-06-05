import type { ContentPart, Message } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../src/agent';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../../src/agent/records';
import { FLAG_DEFINITIONS, MASTER_ENV } from '../../../src/flags';
import { estimateTokensForMessages } from '../../../src/utils/tokens';
import { recordingTelemetry, type TelemetryRecord } from '../../fixtures/telemetry';
import { testAgent, type TestAgentContext } from '../harness/agent';

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

const MINUTE = 60 * 1000;
const DEFAULT_MARKER = '[Old tool result content cleared]';
const MICRO_COMPACTION_FLAG_ENV = getMicroCompactionFlagEnv();

describe('MicroCompaction', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(MICRO_COMPACTION_FLAG_ENV, '1');
  });

  it('truncates old tool results after cache miss', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
        minContextUsageRatio: 0,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    expect(ctx.agent.context.messages).toHaveLength(9);

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.microCompaction.detect();
    const messages = ctx.agent.context.messages;
    expect(messages[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: DEFAULT_MARKER }],
    });
    expect(messages[5]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: 'lookup result' }],
    });
    expect(messages[8]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: 'lookup result' }],
    });
  });

  it('does nothing before cache miss threshold', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(30 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(hasMarker(messages)).toBe(false);
  });

  it('persists cutoff across calls until cache miss resets it', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
        minContextUsageRatio: 0,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.microCompaction.detect();
    const first = ctx.agent.context.messages;
    expect(first[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: DEFAULT_MARKER }],
    });

    vi.setSystemTime(62 * 60 * 1000);

    ctx.agent.microCompaction.detect();
    const second = ctx.agent.context.messages;
    expect(second[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: DEFAULT_MARKER }],
    });
  });

  it('clears cutoff on reset', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.microCompaction.reset();

    const messages = ctx.agent.context.messages;
    expect(hasMarker(messages)).toBe(false);
  });

  it('skips tool results below minContentTokens', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 100,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(hasMarker(messages)).toBe(false);
  });

  it('skips non-tool messages', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'user one', 'assistant one', 10);
    ctx.appendExchange(2, 'user two', 'assistant two', 10);
    ctx.appendExchange(3, 'user three', 'assistant three', 10);

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(hasMarker(messages)).toBe(false);
  });

  it('clears cutoff on context clear', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.context.clear();

    expect(ctx.agent.context.messages).toHaveLength(0);
    expect(ctx.agent.context.lastAssistantAt).toBeNull();
  });

  it('sends truncated old tool results to the next model request without mutating history', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'old result one' });
    appendMicroToolExchange(ctx, 2, { output: 'middle result two' });
    appendMicroToolExchange(ctx, 3, { output: 'recent result three' });

    vi.setSystemTime(61 * MINUTE);

    ctx.mockNextResponse({ type: 'text', text: 'done after micro compaction' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    const call = ctx.llmCalls.at(-1);
    expect(textOf(call?.history[2])).toBe(DEFAULT_MARKER);
    expect(textOf(call?.history[5])).toBe(DEFAULT_MARKER);
    expect(textOf(call?.history[8])).toBe('recent result three');

    expect(textOf(ctx.agent.context.history[2])).toBe('old result one');
    expect(textOf(ctx.agent.context.history[5])).toBe('middle result two');
    expect(textOf(ctx.agent.context.history[8])).toBe('recent result three');
    await ctx.expectResumeMatches();
  });

  it('restores lastAssistantAt from record time before applying cache-miss rules', async () => {
    vi.useFakeTimers();
    const assistantRecordTime = 2_000;
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0,
      },
      persistence: new InMemoryAgentRecordPersistence(
        resumeToolExchangeRecords(assistantRecordTime),
      ),
    });

    vi.setSystemTime(999_999);
    await ctx.agent.resume();

    expect(ctx.agent.context.lastAssistantAt).toBe(assistantRecordTime);

    vi.setSystemTime(assistantRecordTime + 30 * MINUTE);
    expect(hasMarker(ctx.agent.context.messages)).toBe(false);

    vi.setSystemTime(assistantRecordTime + 61 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([DEFAULT_MARKER]);
  });

  it('preserves the restored cutoff when resuming before the next cache miss', async () => {
    vi.useFakeTimers();
    const persistence = new InMemoryAgentRecordPersistence();
    const config = {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    };
    const ctx = testAgent({
      microCompaction: config,
      persistence,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });

    vi.setSystemTime(61 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([DEFAULT_MARKER, 'result two']);
    expect(lastMicroCompactionCutoff(persistence.records)).toBe(4);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    const resumed = testAgent({
      microCompaction: config,
      persistence: new InMemoryAgentRecordPersistence(cloneRecords(persistence.records)),
    });

    vi.setSystemTime(63 * MINUTE);
    await resumed.agent.resume();

    expect(resumed.agent.context.lastAssistantAt).toBe(62 * MINUTE);
    expect(toolTexts(resumed.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);
  });

  it('recomputes the restored cutoff when resuming after the cache-miss threshold', async () => {
    vi.useFakeTimers();
    const persistence = new InMemoryAgentRecordPersistence();
    const config = {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    };
    const ctx = testAgent({
      microCompaction: config,
      persistence,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });

    vi.setSystemTime(61 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([DEFAULT_MARKER, 'result two']);
    expect(lastMicroCompactionCutoff(persistence.records)).toBe(4);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    const resumedPersistence = new InMemoryAgentRecordPersistence(
      cloneRecords(persistence.records),
    );
    const resumed = testAgent({
      microCompaction: config,
      persistence: resumedPersistence,
    });

    vi.setSystemTime(123 * MINUTE);
    await resumed.agent.resume();

    expect(resumed.agent.context.lastAssistantAt).toBe(62 * MINUTE);
    resumed.agent.microCompaction.detect();
    expect(toolTexts(resumed.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);
    expect(lastMicroCompactionCutoff(resumedPersistence.records)).toBe(7);
  });

  it('keeps an old cutoff while cache is warm and advances it on the next miss', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0,
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });

    vi.setSystemTime(61 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([DEFAULT_MARKER, 'result two']);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    vi.setSystemTime(63 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);

    vi.setSystemTime(123 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);
  });

  it('clamps cutoff when undo shortens the context', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0,
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    vi.setSystemTime(61 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);

    ctx.agent.context.undo(2);
    appendMicroToolExchange(ctx, 4, { output: 'result four' });

    expect(toolTexts(ctx.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      'result four',
    ]);
  });

  it('tracks telemetry when a cache miss advances the micro_compaction cutoff', () => {
    vi.useFakeTimers();
    const records: TelemetryRecord[] = [];
    const microCompaction = {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    };
    const ctx = testAgent({
      telemetry: recordingTelemetry(records),
      microCompaction,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one '.repeat(20) });
    appendMicroToolExchange(ctx, 2, { output: 'result two '.repeat(20) });
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    vi.setSystemTime(61 * MINUTE);
    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);

    const event = singleTelemetryEvent(records, 'micro_compaction_applied');
    expect(event.properties).toMatchObject({
      ...microCompaction,
      truncatedMarker: DEFAULT_MARKER,
      previous_cutoff: 0,
      cutoff: 7,
      message_count: 9,
      cache_age_ms: 61 * MINUTE,
      truncatedToolResultCount: 2,
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number),
    });
    expect(numberProperty(event, 'beforeTokens')).toBeGreaterThan(
      numberProperty(event, 'afterTokens'),
    );

    expect(ctx.agent.context.messages).toHaveLength(9);
    expect(records.filter((record) => record.event === 'micro_compaction_applied')).toHaveLength(1);
  });

  it('leaves context unchanged when the micro_compaction flag is disabled', () => {
    vi.stubEnv(MICRO_COMPACTION_FLAG_ENV, '0');
    vi.useFakeTimers();
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
      },
      persistence,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });

    vi.setSystemTime(61 * MINUTE);

    expect(toolTexts(ctx.agent.context.messages)).toEqual(['result one']);
    expect(lastMicroCompactionCutoff(persistence.records)).toBeUndefined();
  });

  it('uses the custom marker at the minContentTokens boundary', () => {
    vi.useFakeTimers();
    const marker = '[tool output removed for test]';
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        truncatedMarker: marker,
        minContextUsageRatio: 0,
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'abcd' });

    vi.setSystemTime(61 * MINUTE);

    ctx.agent.microCompaction.detect();
    expect(toolTexts(ctx.agent.context.messages)).toEqual([marker]);
    expect(textOf(ctx.agent.context.history[2])).toBe('abcd');
  });

  it('keeps raw pending token accounting even when projection truncates tool output', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0,
      },
    });
    ctx.configure();

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, {
      output: 'x'.repeat(400),
      usageTokens: 50,
    });

    vi.setSystemTime(61 * MINUTE);

    ctx.agent.microCompaction.detect();
    const rawPending = ctx.agent.context.history.slice(-1);
    const projectedPending = ctx.agent.context.project(rawPending);
    expect(textOf(projectedPending[0])).toBe(DEFAULT_MARKER);
    expect(ctx.agent.context.tokenCountWithPending).toBe(
      ctx.agent.context.tokenCount + estimateTokensForMessages(rawPending),
    );
    expect(ctx.agent.context.tokenCountWithPending).toBeGreaterThan(
      ctx.agent.context.tokenCount + estimateTokensForMessages(projectedPending),
    );
  });

  it('replaces rich error tool content while preserving context metadata before projection', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0,
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, {
      output: [
        { type: 'text', text: 'large rich output' },
        { type: 'video_url', videoUrl: { url: 'ms://video-1', id: 'video-1' } },
      ],
      isError: true,
    });

    vi.setSystemTime(61 * MINUTE);

    ctx.agent.microCompaction.detect();
    const compacted = ctx.agent.microCompaction.compact(ctx.agent.context.history);
    const tool = compacted.find((message) => message.role === 'tool');
    expect(tool).toMatchObject({
      role: 'tool',
      toolCallId: 'call_micro_1',
      isError: true,
      content: [{ type: 'text', text: DEFAULT_MARKER }],
    });
    expect(tool?.content).toHaveLength(1);
  });

  it('does not truncate tool-shaped messages without a toolCallId', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
      },
    });

    vi.setSystemTime(61 * MINUTE);
    ctx.agent.context.appendMessage({
      role: 'tool',
      content: [{ type: 'text', text: 'orphan tool-like output' }],
      toolCalls: [],
    });

    expect(toolTexts(ctx.agent.context.messages)).toEqual(['orphan tool-like output']);
  });

  it('clears cutoff on full compaction', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    vi.setSystemTime(61 * 60 * 1000);

    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    expect(ctx.agent.context.messages).toHaveLength(1);
    expect(ctx.agent.context.messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Summary.' }],
    });
  });

  it('does not apply when context usage is below minContextUsageRatio', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0.9,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });

    vi.setSystemTime(61 * MINUTE);

    const messages = ctx.agent.context.messages;
    expect(hasMarker(messages)).toBe(false);
  });

  it('applies when context usage is above minContextUsageRatio', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 0,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * MINUTE,
        minContextUsageRatio: 0.5,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 100,
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'x'.repeat(300) });

    vi.setSystemTime(61 * MINUTE);

    ctx.agent.microCompaction.detect();
    const messages = ctx.agent.context.messages;
    expect(hasMarker(messages)).toBe(true);
  });

  it('does not truncate when messages are fewer than keepRecentMessages', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 20,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(hasMarker(messages)).toBe(false);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface MicroToolExchangeOptions {
  readonly output?: string | ContentPart[] | undefined;
  readonly isError?: boolean | undefined;
  readonly usageTokens?: number | undefined;
}

function appendMicroToolExchange(
  ctx: TestAgentContext,
  index: number,
  options: MicroToolExchangeOptions = {},
): void {
  const stepUuid = `micro-tool-step-${String(index)}`;
  const toolCallId = `call_micro_${String(index)}`;
  const output = options.output ?? `lookup result ${String(index)}`;
  const usage =
    options.usageTokens === undefined
      ? undefined
      : {
          inputOther: options.usageTokens - 1,
          output: 1,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        };

  ctx.agent.context.appendUserMessage([{ type: 'text', text: `lookup ${String(index)}` }]);
  ctx.dispatch({
    type: 'context.append_loop_event',
    event: { type: 'step.begin', uuid: stepUuid, turnId: '', step: index },
  });
  ctx.dispatch({
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: `micro-tool-part-${String(index)}`,
      turnId: '',
      step: index,
      stepUuid,
      part: { type: 'text', text: `calling Lookup ${String(index)}` },
    },
  });
  ctx.dispatch({
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      uuid: toolCallId,
      turnId: '',
      step: index,
      stepUuid,
      toolCallId,
      name: 'Lookup',
      args: { query: `item-${String(index)}` },
    },
  });
  ctx.dispatch({
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      uuid: stepUuid,
      turnId: '',
      step: index,
      usage,
      finishReason: 'tool_use',
    },
  });
  ctx.dispatch({
    type: 'context.append_loop_event',
    event: {
      type: 'tool.result',
      parentUuid: toolCallId,
      toolCallId,
      result: { output, isError: options.isError },
    },
  });
}

function resumeToolExchangeRecords(assistantRecordTime: number): AgentRecord[] {
  return [
    {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    {
      type: 'context.append_message',
      time: 1_000,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'lookup from restored session' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: assistantRecordTime,
      event: { type: 'step.begin', uuid: 'resume-micro-step', turnId: '0', step: 1 },
    },
    {
      type: 'context.append_loop_event',
      time: assistantRecordTime + 1,
      event: {
        type: 'content.part',
        uuid: 'resume-micro-part',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-micro-step',
        part: { type: 'text', text: 'calling restored Lookup' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: assistantRecordTime + 2,
      event: {
        type: 'tool.call',
        uuid: 'resume-micro-call',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-micro-step',
        toolCallId: 'resume_micro_call',
        name: 'Lookup',
        args: { query: 'restored' },
      },
    },
    {
      type: 'context.append_loop_event',
      time: assistantRecordTime + 3,
      event: {
        type: 'step.end',
        uuid: 'resume-micro-step',
        turnId: '0',
        step: 1,
        finishReason: 'tool_use',
      },
    },
    {
      type: 'context.append_loop_event',
      time: assistantRecordTime + 4,
      event: {
        type: 'tool.result',
        parentUuid: 'resume-micro-call',
        toolCallId: 'resume_micro_call',
        result: { output: 'restored lookup result' },
      },
    },
  ];
}

function cloneRecords(records: readonly AgentRecord[]): AgentRecord[] {
  return records.map((record) => structuredClone(record));
}

function lastMicroCompactionCutoff(records: readonly AgentRecord[]): number | undefined {
  return records.findLast((record) => record.type === 'micro_compaction.apply')?.cutoff;
}

function toolTexts(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message));
}

function textOf(message: Message | undefined): string {
  return (
    message?.content
      .map((part) => {
        if (part.type === 'text') return part.text;
        return '';
      })
      .join('') ?? ''
  );
}

function hasMarker(messages: readonly Message[]): boolean {
  return toolTexts(messages).includes(DEFAULT_MARKER);
}

function getMicroCompactionFlagEnv(): string {
  const flag = FLAG_DEFINITIONS.find((definition) => definition.id === 'micro_compaction');
  if (flag === undefined) {
    throw new Error('Missing micro_compaction flag definition.');
  }
  return flag.env;
}

function singleTelemetryEvent(
  records: readonly TelemetryRecord[],
  event: string,
): TelemetryRecord {
  const matches = records.filter((record) => record.event === event);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function numberProperty(record: TelemetryRecord, key: string): number {
  const value = record.properties?.[key];
  expect(typeof value).toBe('number');
  return value as number;
}
