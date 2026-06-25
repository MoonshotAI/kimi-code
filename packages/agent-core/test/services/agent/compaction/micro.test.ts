import type { ContentPart } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLAG_DEFINITIONS, FlagResolver, MASTER_ENV } from '../../../../src/flags';
import { estimateTokensForMessages } from '../../../../src/utils/tokens';
import { recordingTelemetry, type TelemetryRecord } from '../../../fixtures/telemetry';
import { testAgent, type TestAgentContext } from '../harness';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IMicroCompactionService,
  InMemoryWireRecordPersistence,
  type PersistedWireRecord,
} from '../../../../src/services/agent';

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

  it('defaults the micro_compaction flag on', () => {
    expect(new FlagResolver({}, FLAG_DEFINITIONS).enabled('micro_compaction')).toBe(true);
  });

  it('truncates old tool results after cache miss', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 4,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,
          minContextUsageRatio: 0,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    expect(ctx.project()).toHaveLength(9);

    vi.setSystemTime(61 * 60 * 1000);

    (ctx.get(IMicroCompactionService) as any).detect();
    const messages = ctx.project();
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
        config: {
          keepRecentMessages: 4,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(30 * 60 * 1000);

    const messages = ctx.project();
    expect(hasMarker(messages)).toBe(false);
  });

  it('persists cutoff across calls until cache miss resets it', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 2,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,
          minContextUsageRatio: 0,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    (ctx.get(IMicroCompactionService) as any).detect();
    const first = ctx.project();
    expect(first[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: DEFAULT_MARKER }],
    });

    vi.setSystemTime(62 * 60 * 1000);

    (ctx.get(IMicroCompactionService) as any).detect();
    const second = ctx.project();
    expect(second[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: DEFAULT_MARKER }],
    });
  });

  it('clears cutoff on reset', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 4,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    (ctx.get(IMicroCompactionService) as any).reset();

    const messages = ctx.project();
    expect(hasMarker(messages)).toBe(false);
  });

  it('skips tool results below minContentTokens', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 2,
          minContentTokens: 100,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.project();
    expect(hasMarker(messages)).toBe(false);
  });

  it('skips non-tool messages', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 2,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'user one', 'assistant one', 10);
    ctx.appendExchange(2, 'user two', 'assistant two', 10);
    ctx.appendExchange(3, 'user three', 'assistant three', 10);

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.project();
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(hasMarker(messages)).toBe(false);
  });

  it('clears cutoff on context clear', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 2,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.clearContext();

    expect(ctx.project()).toHaveLength(0);
    expect((ctx.get(IMicroCompactionService) as any).lastAssistantAt).toBeNull();
  });

  it('sends truncated old tool results to the next model request without mutating history', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 4,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
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

    expect(textOf(ctx.context.getHistory()[2])).toBe('old result one');
    expect(textOf(ctx.context.getHistory()[5])).toBe('middle result two');
    expect(textOf(ctx.context.getHistory()[8])).toBe('recent result three');
    await ctx.expectResumeMatches();
  });

  it('restores lastAssistantAt from record time before applying cache-miss rules', async () => {
    vi.useFakeTimers();
    const assistantRecordTime = 2_000;
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
      },
      persistence: new InMemoryWireRecordPersistence(
        resumeToolExchangeRecords(assistantRecordTime),
      ),
    });

    vi.setSystemTime(999_999);
    await ctx.runtime.restore();

    expect((ctx.get(IMicroCompactionService) as any).lastAssistantAt).toBe(assistantRecordTime);

    vi.setSystemTime(assistantRecordTime + 30 * MINUTE);
    expect(hasMarker(ctx.project())).toBe(false);

    vi.setSystemTime(assistantRecordTime + 61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([DEFAULT_MARKER]);
  });

  it('preserves the restored cutoff when resuming before the next cache miss', async () => {
    vi.useFakeTimers();
    const persistence = new InMemoryWireRecordPersistence();
    const config = {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    };
    const ctx = testAgent({
      microCompaction: { config },
      persistence,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([DEFAULT_MARKER, 'result two']);
    expect(lastMicroCompactionCutoff(persistence.records)).toBe(4);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    const resumed = testAgent({
      microCompaction: { config },
      persistence: new InMemoryWireRecordPersistence(cloneRecords(persistence.records)),
    });

    vi.setSystemTime(63 * MINUTE);
    await resumed.runtime.restore();

    expect((resumed.get(IMicroCompactionService) as any).lastAssistantAt).toBe(62 * MINUTE);
    expect(toolTexts(resumed.project())).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);
  });

  it('recomputes the restored cutoff when resuming after the cache-miss threshold', async () => {
    vi.useFakeTimers();
    const persistence = new InMemoryWireRecordPersistence();
    const config = {
      keepRecentMessages: 2,
      minContentTokens: 1,
      cacheMissedThresholdMs: 60 * MINUTE,
      minContextUsageRatio: 0,
    };
    const ctx = testAgent({
      microCompaction: { config },
      persistence,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([DEFAULT_MARKER, 'result two']);
    expect(lastMicroCompactionCutoff(persistence.records)).toBe(4);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    const resumedPersistence = new InMemoryWireRecordPersistence(
      cloneRecords(persistence.records),
    );
    const resumed = testAgent({
      microCompaction: { config },
      persistence: resumedPersistence,
    });

    vi.setSystemTime(123 * MINUTE);
    await resumed.runtime.restore();

    expect((resumed.get(IMicroCompactionService) as any).lastAssistantAt).toBe(62 * MINUTE);
    (resumed.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(resumed.project())).toEqual([
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
        config: {
          keepRecentMessages: 2,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([DEFAULT_MARKER, 'result two']);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    vi.setSystemTime(63 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([
      DEFAULT_MARKER,
      'result two',
      'result three',
    ]);

    vi.setSystemTime(123 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);
  });

  it('clamps cutoff when undo shortens the context', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 2,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });
    appendMicroToolExchange(ctx, 2, { output: 'result two' });
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);

    ctx.undoHistory(2);
    appendMicroToolExchange(ctx, 4, { output: 'result four' });

    expect(toolTexts(ctx.project())).toEqual([
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
      microCompaction: { config: microCompaction },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one '.repeat(20) });
    appendMicroToolExchange(ctx, 2, { output: 'result two '.repeat(20) });
    appendMicroToolExchange(ctx, 3, { output: 'result three' });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([
      DEFAULT_MARKER,
      DEFAULT_MARKER,
      'result three',
    ]);

    const event = singleTelemetryEvent(records, 'micro_compaction_finished');
    expect(event.properties).toMatchObject({
      ...microCompaction,
      truncatedMarker: DEFAULT_MARKER,
      previous_cutoff: 0,
      cutoff: 7,
      message_count: 9,
      cache_age_ms: 61 * MINUTE,
      truncatedToolResultCount: 2,
      truncatedToolResultTokensBefore: expect.any(Number),
      truncatedToolResultTokensAfter: expect.any(Number),
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
      thinkingLevel: 'off',
    });
    expect(numberProperty(event, 'truncatedToolResultTokensBefore')).toBeGreaterThan(
      numberProperty(event, 'truncatedToolResultTokensAfter'),
    );
    expect(numberProperty(event, 'tokensBefore')).toBeGreaterThan(
      numberProperty(event, 'tokensAfter'),
    );

    expect(ctx.project()).toHaveLength(9);
    expect(records.filter((record) => record.event === 'micro_compaction_finished')).toHaveLength(1);
  });

  it('reports context token deltas from the previously compacted projection', () => {
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
      microCompaction: { config: microCompaction },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one '.repeat(20) });
    appendMicroToolExchange(ctx, 2, { output: 'result two '.repeat(20) });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([
      DEFAULT_MARKER,
      'result two '.repeat(20),
    ]);

    vi.setSystemTime(62 * MINUTE);
    appendMicroToolExchange(ctx, 3, { output: 'result three' });
    const expectedContextTokensBefore = estimateTokensForMessages(ctx.project());

    vi.setSystemTime(123 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();

    const events = records.filter((record) => record.event === 'micro_compaction_finished');
    expect(events).toHaveLength(2);
    const secondEvent = events[1]!;
    expect(secondEvent.properties).toMatchObject({
      previous_cutoff: 4,
      cutoff: 7,
      truncatedToolResultCount: 2,
      tokensBefore: expectedContextTokensBefore,
      tokensAfter: estimateTokensForMessages(ctx.project()),
    });
  });

  it('leaves context unchanged when the micro_compaction flag is disabled', () => {
    vi.stubEnv(MICRO_COMPACTION_FLAG_ENV, '0');
    vi.useFakeTimers();
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
      },
      persistence,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });

    vi.setSystemTime(61 * MINUTE);
    (ctx.get(IMicroCompactionService) as any).detect();

    expect(toolTexts(ctx.project())).toEqual(['result one']);
    expect(lastMicroCompactionCutoff(persistence.records)).toBeUndefined();
  });

  it('uses the custom marker at the minContentTokens boundary', () => {
    vi.useFakeTimers();
    const marker = '[tool output removed for test]';
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          truncatedMarker: marker,
          minContextUsageRatio: 0,

        }
      },
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'abcd' });

    vi.setSystemTime(61 * MINUTE);

    (ctx.get(IMicroCompactionService) as any).detect();
    expect(toolTexts(ctx.project())).toEqual([marker]);
    expect(textOf(ctx.context.getHistory()[2])).toBe('abcd');
  });

  it('keeps raw pending token accounting even when projection truncates tool output', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
      },
    });
    ctx.configure();

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, {
      output: 'x'.repeat(400),
      usageTokens: 50,
    });

    vi.setSystemTime(61 * MINUTE);

    (ctx.get(IMicroCompactionService) as any).detect();
    const rawPending = ctx.context.getHistory().slice(-1);
    const projectedPending = ctx.project(rawPending);
    expect(textOf(projectedPending[0])).toBe(DEFAULT_MARKER);
    expect(ctx.contextSize.getStatus().contextTokensWithPending).toBe(
      ctx.contextSize.getStatus().contextTokens + estimateTokensForMessages(rawPending),
    );
    expect(ctx.contextSize.getStatus().contextTokensWithPending).toBeGreaterThan(
      ctx.contextSize.getStatus().contextTokens + estimateTokensForMessages(projectedPending),
    );
  });

  it('replaces rich error tool content while preserving context metadata before projection', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0,

        }
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

    (ctx.get(IMicroCompactionService) as any).detect();
    const compacted = (ctx.get(IMicroCompactionService) as any).compact(ctx.context.getHistory());
    const tool = compacted.find((message: any) => message.role === 'tool');
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
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,

        }
      },
    });

    vi.setSystemTime(61 * MINUTE);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'orphan tool-like output' }],
        toolCalls: [],
      },
    ]);

    expect(toolTexts(ctx.project())).toEqual(['orphan tool-like output']);
  });

  it('clears cutoff on full compaction', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 2,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
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

    const compacted = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    expect(ctx.project()).toHaveLength(1);
    expect(ctx.project()[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Summary.' }],
    });
  });

  it('does not apply when context usage is below minContextUsageRatio', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0.9,

        }
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    appendMicroToolExchange(ctx, 1, { output: 'result one' });

    vi.setSystemTime(61 * MINUTE);

    const messages = ctx.project();
    expect(hasMarker(messages)).toBe(false);
  });

  it('applies when context usage is above minContextUsageRatio', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 0,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * MINUTE,
          minContextUsageRatio: 0.5,

        }
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

    (ctx.get(IMicroCompactionService) as any).detect();
    const messages = ctx.project();
    expect(hasMarker(messages)).toBe(true);
  });

  it('does not truncate when messages are fewer than keepRecentMessages', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        config: {
          keepRecentMessages: 20,
          minContentTokens: 1,
          cacheMissedThresholdMs: 60 * 60 * 1000,

        }
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.project();
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

  ctx.appendUserMessage([{ type: 'text', text: `lookup ${String(index)}` }]);

  ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `calling Lookup ${String(index)}` },
      ],
      toolCalls: [
        { type: 'function', id: toolCallId, name: 'Lookup', arguments: JSON.stringify({ query: `item-${String(index)}` }) },
      ],
    },
  ]);

  if (usage !== undefined) {
    ctx.contextSize.measure(
      ctx.context.getHistory().length,
      usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation,
    );
  }

  ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
    {
      role: 'tool',
      content: typeof output === 'string' ? [{ type: 'text', text: output }] : [...output],
      toolCalls: [],
      toolCallId,
      isError: options.isError,
    },
  ]);
}

function resumeToolExchangeRecords(assistantRecordTime: number): PersistedWireRecord[] {
  return [
    {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    {
      type: 'context.splice',
      time: 1_000,
      start: 0,
      deleteCount: 0,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'lookup from restored session' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      ],
    },
    {
      type: 'turn.launch',
      time: assistantRecordTime,
      turnId: 0,
      origin: { kind: 'user' },
    },
    {
      type: 'context.splice',
      time: assistantRecordTime,
      start: 1,
      deleteCount: 0,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'calling restored Lookup' }],
          toolCalls: [
            {
              type: 'function',
              id: 'resume_micro_call',
              name: 'Lookup',
              arguments: JSON.stringify({ query: 'restored' }),
            },
          ],
        },
      ],
    },
    {
      type: 'context.splice',
      time: assistantRecordTime + 2,
      start: 2,
      deleteCount: 0,
      messages: [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'restored lookup result' }],
          toolCalls: [],
          toolCallId: 'resume_micro_call',
        },
      ],
    },
  ] as PersistedWireRecord[];
}

function cloneRecords(records: readonly PersistedWireRecord[]): PersistedWireRecord[] {
  return records.map((record) => structuredClone(record));
}

function lastMicroCompactionCutoff(records: readonly PersistedWireRecord[]): number | undefined {
  return (records.findLast((record) => record.type === 'micro_compaction.apply') as any)?.cutoff;
}

function toolTexts(messages: readonly { role: string; content?: readonly { type: string; text?: string }[] }[]): string[] {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => textOf(message));
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content
      ?.map((part) => {
        if (part.type === 'text') return part.text;
        return '';
      })
      .join('') ?? ''
  );
}

function hasMarker(messages: readonly { role: string; content?: readonly { type: string; text?: string }[] }[]): boolean {
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
