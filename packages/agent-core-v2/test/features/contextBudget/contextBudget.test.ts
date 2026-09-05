import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { CompactionBudget } from '#/agent/fullCompaction/fullCompaction';
import {
  contextBudgetBucket,
  renderCompactionAheadReminder,
  renderContextBudgetReminder,
  shouldRemindCompactionAhead,
} from '#/features/contextBudget/contextBudgetReminder';

import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { testAgent, type TestAgentContext } from '../../harness';

const PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;
const CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 100_000,
} as const;

function budget(used: number, overrides: Partial<CompactionBudget> = {}): CompactionBudget {
  return {
    used,
    maxSize: 100_000,
    triggerRatio: 0.85,
    reservedContextSize: 0,
    triggerTokens: 85_000,
    ...overrides,
  };
}

function reminders(context: IAgentContextMemoryService, variant: string): ContextMessage[] {
  return context
    .get()
    .filter((message) => message.origin?.kind === 'injection' && message.origin.variant === variant);
}

function textOf(message: ContextMessage | undefined): string {
  const part = message?.content[0];
  return part?.type === 'text' ? part.text : '';
}

describe('context budget reminder rules', () => {
  it('buckets usage by its share of the compaction trigger', () => {
    expect(contextBudgetBucket(budget(42_499))).toBeUndefined();
    expect(contextBudgetBucket(budget(42_500))).toBe('half');
    expect(contextBudgetBucket(budget(63_749))).toBe('half');
    expect(contextBudgetBucket(budget(63_750))).toBe('three_quarters');
    expect(contextBudgetBucket(budget(76_500))).toBe('three_quarters');
    expect(contextBudgetBucket(budget(84_999))).toBe('three_quarters');
    expect(contextBudgetBucket(budget(90_000))).toBe('three_quarters');
  });

  it('never buckets when compaction can never trigger', () => {
    expect(contextBudgetBucket(budget(50_000, { triggerTokens: Number.POSITIVE_INFINITY }))).toBeUndefined();
    expect(contextBudgetBucket(budget(50_000, { maxSize: 0, triggerTokens: Number.POSITIVE_INFINITY }))).toBeUndefined();
  });

  it('warns about compaction only inside the lead window and before the trigger', () => {
    expect(shouldRemindCompactionAhead(budget(74_999))).toBe(false);
    expect(shouldRemindCompactionAhead(budget(75_000))).toBe(true);
    expect(shouldRemindCompactionAhead(budget(84_999))).toBe(true);
    expect(shouldRemindCompactionAhead(budget(85_000))).toBe(false);
    expect(shouldRemindCompactionAhead(budget(50_000, { triggerTokens: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('renders the budget reminder with the numbers that drive compaction', () => {
    const text = renderContextBudgetReminder(budget(41_000));

    expect(text.startsWith('<context_budget>')).toBe(true);
    expect(text.endsWith('</context_budget>')).toBe(true);
    expect(text).toContain('~41% of the 100k-token window is used; automatic compaction runs at 85k (85%)');
    expect(text).toContain('capped at ~20k tokens');
    expect(text).toContain('Do not wrap up or stop early because of budget');
    expect(text).not.toContain('${');
  });

  it('renders the compaction-ahead reminder with the remaining lead', () => {
    const text = renderCompactionAheadReminder(budget(76_000));

    expect(text.startsWith('<compaction_ahead>')).toBe(true);
    expect(text).toContain('Context is at ~76%; automatic compaction runs at 85% (about 9k tokens from now)');
    expect(text).toContain('text only — no tool calls');
    expect(text).toContain('Then continue the task; do not stop.');
    expect(text).not.toContain('${');
  });
});

describe('context budget reminders in the agent', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let loop: StubLoop;
  let telemetry: TelemetryRecord[];

  beforeEach(async () => {
    telemetry = [];
    ctx = testAgent({
      telemetry: recordingTelemetry(telemetry),
      initialConfig: { loopControl: { reservedContextSize: 0 } },
    });
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPABILITIES });
    context = ctx.get(IAgentContextMemoryService);
    loop = ctx.get(IAgentLoopService) as StubLoop;
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('tells the model its budget once per bucket as usage grows', async () => {
    ctx.appendExchange(1, 'user one', 'assistant one', 30_000);
    await runWillBeginStepHooks(loop);
    expect(reminders(context, 'context_budget')).toHaveLength(0);

    ctx.appendExchange(2, 'user two', 'assistant two', 45_000);
    await runWillBeginStepHooks(loop);
    const [first] = reminders(context, 'context_budget');
    expect(textOf(first)).toContain('<context_budget>');
    expect(textOf(first)).toContain('automatic compaction runs at 85k (85%)');
    expect(first?.origin).toMatchObject({ kind: 'injection', variant: 'context_budget', disclosure: { bucket: 'half' } });

    await runWillBeginStepHooks(loop);
    expect(reminders(context, 'context_budget')).toHaveLength(1);

    ctx.appendExchange(3, 'user three', 'assistant three', 65_000);
    await runWillBeginStepHooks(loop);
    const budgetReminders = reminders(context, 'context_budget');
    expect(budgetReminders).toHaveLength(2);
    expect(budgetReminders[1]?.origin).toMatchObject({ disclosure: { bucket: 'three_quarters' } });
    expect(telemetry.filter((record) => record.event === 'context_budget_reminder')).toHaveLength(2);
  });

  it('warns once that compaction is ahead when the trigger is within the lead window', async () => {
    ctx.appendExchange(1, 'user one', 'assistant one', 76_000);
    await runWillBeginStepHooks(loop);

    const [ahead] = reminders(context, 'compaction_ahead');
    expect(textOf(ahead)).toContain('<compaction_ahead>');
    expect(textOf(ahead)).toContain('This is your last chance to act');
    expect(reminders(context, 'context_budget')).toHaveLength(1);
    expect(context.get().at(-1)?.origin).toMatchObject({ variant: 'compaction_ahead' });

    await runWillBeginStepHooks(loop);
    expect(reminders(context, 'compaction_ahead')).toHaveLength(1);
    expect(telemetry.filter((record) => record.event === 'compaction_ahead_reminder')).toHaveLength(1);
  });

  it('re-arms both reminders after compaction clears the window', async () => {
    ctx.appendExchange(1, 'user one', 'assistant one', 76_000);
    await runWillBeginStepHooks(loop);
    expect(reminders(context, 'compaction_ahead')).toHaveLength(1);

    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;
    expect(reminders(context, 'compaction_ahead')).toHaveLength(0);
    expect(reminders(context, 'context_budget')).toHaveLength(0);

    ctx.appendExchange(2, 'user two', 'assistant two', 77_000);
    await runWillBeginStepHooks(loop);
    expect(reminders(context, 'compaction_ahead')).toHaveLength(1);
    expect(reminders(context, 'context_budget')).toHaveLength(1);
  });
});
