import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ReminderFeature } from '#/features/reminder/reminderFeature';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { createTestAgent, type TestAgentContext } from '../../harness';
import {
  runWillBeginStepHooks,
  type StubLoop,
} from '../../agent/loop/stubs';

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function compactionSummary(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function lastText(context: IAgentContextMemoryService): string | undefined {
  const message = context.get().at(-1);
  const part = message?.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

describe('AgentReminderService', () => {
  let ctx: TestAgentContext;
  let reminder: IAgentReminderService;
  let context: IAgentContextMemoryService;
  let loop: StubLoop;

  beforeEach(async () => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    loop = ctx.get(IAgentLoopService) as StubLoop;
    await ctx.restorePersisted();
    reminder = ctx.get(IAgentReminderService);
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  async function runInjectionStep(firstStepOfTurn = false): Promise<void> {
    await runWillBeginStepHooks(loop, firstStepOfTurn);
  }

  function spliceContext(
    start: number,
    deleteCount: number,
    inserted: readonly ContextMessage[],
  ): void {
    const backing = [...ctx.agentState.get(contextMemoryKey)];
    backing.splice(start, deleteCount, ...inserted);
    ctx.agentState.set(contextMemoryKey, backing);
    ctx.get(IEventBus).publish(
      new ContextSpliced({
        agentId: 'main',
        start,
        deleteCount,
        messages: [...inserted],
      }),
      ctx.agentContext,
    );
  }

  it('registers providers and appends injection messages with the provider variant', async () => {
    const seen: Array<number | null> = [];

    reminder.register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return 'recorded reminder';
    });

    await runInjectionStep();

    expect(seen).toEqual([null]);
    expect(lastText(context)).toContain('<system-reminder>');
    expect(lastText(context)).toContain('recorded reminder');
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('persists provider disclosure metadata on the injected message origin', async () => {
    reminder.register('date_test', () => ({
      content: 'date reminder',
      disclosure: {
        kind: 'date',
        renderGeneration: 4,
        localDate: '2026-07-29',
        timeZone: 'Asia/Shanghai',
      },
    }));

    await runInjectionStep();

    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'date_test',
      disclosure: {
        kind: 'date',
        renderGeneration: 4,
        localDate: '2026-07-29',
        timeZone: 'Asia/Shanghai',
      },
    });
  });

  it('appends provider content parts verbatim without system-reminder wrapping', async () => {
    reminder.register('media_test', () => [
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
    ]);

    await runInjectionStep();

    const message = context.get().at(-1);
    expect(message?.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
    ]);
    expect(message?.origin).toEqual({ kind: 'injection', variant: 'media_test' });
  });

  it('skips injection when the provider returns an empty content array', async () => {
    reminder.register('empty_test', () => []);

    await runInjectionStep();

    expect(context.get()).toHaveLength(0);
  });

  it('passes the previous injection index back to the provider', async () => {
    const seen: Array<number | null> = [];

    reminder.register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    await runInjectionStep();

    expect(seen).toEqual([null, 0]);
    expect(context.get()).toHaveLength(1);
  });

  it('reconciles only providers registered under the requested name while idle', async () => {
    const seen: string[] = [];
    reminder.register('target', () => {
      seen.push('target');
      return 'target reminder';
    });
    reminder.register('other', () => {
      seen.push('other');
      return 'other reminder';
    });

    await reminder.reconcileWhenIdle('target');

    expect(seen).toEqual(['target']);
    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]?.origin).toEqual({ kind: 'injection', variant: 'target' });
  });

  it('leaves reconciliation to the next step head when quiescence cannot be acquired', async () => {
    let calls = 0;
    reminder.register('target', () => {
      calls++;
      return 'target reminder';
    });
    loop.settled = async () => {
      throw new Error('idle reconciliation must not wait for an active turn');
    };
    loop.tryAcquireQuiescence = () => undefined;

    await reminder.reconcileWhenIdle('target');

    expect(calls).toBe(0);
    expect(context.get()).toHaveLength(0);
  });

  it('exposes all live injection positions alongside the newest one', async () => {
    const seen: Array<readonly number[]> = [];

    reminder.register('recording_test', ({ injectedPositions, lastInjectedAt }) => {
      seen.push(injectedPositions);
      expect(lastInjectedAt).toBe(injectedPositions.at(-1) ?? null);
      return seen.length <= 2 ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    spliceContext(1, 0, [userMessage('between reminders')]);
    await runInjectionStep();
    await runInjectionStep();

    expect(seen).toEqual([[], [0], [0, 2]]);
  });

  it('falls back to the previous surviving copy when the newest injection is deleted', async () => {
    const seen: Array<number | null> = [];

    reminder.register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return seen.length <= 2 ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    spliceContext(1, 0, [userMessage('between reminders')]);
    await runInjectionStep();
    spliceContext(2, 1, []);
    await runInjectionStep();

    expect(seen).toEqual([null, 0, 0]);
    expect(context.get().map((message) => message.origin?.kind)).toEqual([
      'injection',
      'user',
    ]);
  });

  it('resets every stored injection index after context clear', async () => {
    const seenA: Array<number | null> = [];
    const seenB: Array<number | null> = [];

    reminder.register('recording_a', ({ lastInjectedAt }) => {
      seenA.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder A' : undefined;
    });
    reminder.register('recording_b', ({ lastInjectedAt }) => {
      seenB.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder B' : undefined;
    });

    await runInjectionStep();
    spliceContext(0, context.get().length, []);
    await runInjectionStep();

    expect(seenA).toEqual([null, null]);
    expect(seenB).toEqual([null, null]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'injection', variant: 'recording_a' },
      { kind: 'injection', variant: 'recording_b' },
    ]);
  });

  it('re-injects at the next step after compaction swallows the reminder', async () => {
    const seen: Array<number | null> = [];

    context.append(userMessage('before reminder'));
    reminder.register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    spliceContext(
      0,
      2,
      [compactionSummary('Compacted summary.')],
    );
    await runInjectionStep();

    expect(seen).toEqual([null, null]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'recording_test' },
    ]);
  });

  it('keeps every injection index aligned after compaction preserves injected messages', async () => {
    const seenA: Array<number | null> = [];
    const seenB: Array<number | null> = [];

    context.append(
      userMessage('old request'),
      userMessage('old follow-up'),
    );
    reminder.register('recording_a', ({ lastInjectedAt }) => {
      seenA.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder A' : undefined;
    });
    reminder.register('recording_b', ({ lastInjectedAt }) => {
      seenB.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder B' : undefined;
    });

    await runInjectionStep();
    spliceContext(0, 2, [compactionSummary('Compacted summary.')]);
    await runInjectionStep();

    expect(seenA).toEqual([null, 1]);
    expect(seenB).toEqual([null, 2]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'recording_a' },
      { kind: 'injection', variant: 'recording_b' },
    ]);
  });

  it('re-arms per-turn providers at the first step after a compaction splice', async () => {
    const seen: boolean[] = [];
    reminder.register('per_turn_test', ({ isNewTurn }) => {
      seen.push(isNewTurn);
      return isNewTurn ? 'per-turn reminder' : undefined;
    });

    await runInjectionStep(true);
    await runInjectionStep();
    spliceContext(0, 1, [compactionSummary('Compacted summary.')]);
    await runInjectionStep();

    expect(seen).toEqual([true, false, true]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'per_turn_test' },
    ]);
  });

  it('does not re-arm the new-turn flag for non-compaction splices', async () => {
    const seen: boolean[] = [];
    reminder.register('per_turn_test', ({ isNewTurn }) => {
      seen.push(isNewTurn);
      return undefined;
    });

    await runInjectionStep(true);
    spliceContext(0, 0, [userMessage('between steps')]);
    await runInjectionStep();

    expect(seen).toEqual([true, false]);
  });

  it('re-reconciles within the same step when compaction lands inside the step hook chain', async () => {
    const seen: boolean[] = [];
    reminder.register('per_turn_test', ({ isNewTurn }) => {
      seen.push(isNewTurn);
      return isNewTurn ? 'per-turn reminder' : undefined;
    });
    loop.hooks.onWillBeginStep.register('test-compaction', async (_ctx, next) => {
      spliceContext(0, 1, [compactionSummary('Compacted summary.')]);
      await next();
    });

    await runInjectionStep(true);

    expect(seen).toEqual([true, true]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'per_turn_test' },
    ]);
  });

  it('appends tagged raw messages verbatim with the injection origin stamped', async () => {
    reminder.register('schema_test', () => ({
      message: {
        role: 'system',
        content: [],
        tools: [{ name: 'TestTool', description: 'test tool', parameters: { type: 'object' } }],
      },
    }));

    await runInjectionStep();

    const message = context.get().at(-1);
    expect(message?.role).toBe('system');
    expect(message?.tools).toEqual([
      { name: 'TestTool', description: 'test tool', parameters: { type: 'object' } },
    ]);
    expect(message?.origin).toEqual({ kind: 'injection', variant: 'schema_test' });
  });

  it('stamps the disclosure on tagged raw messages returned through the result wrapper', async () => {
    reminder.register('schema_test', () => ({
      content: { message: { role: 'user', content: [{ type: 'text', text: 'raw' }] } },
      disclosure: { kind: 'test_receipt', id: 'r1' },
    }));

    await runInjectionStep();

    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'schema_test',
      disclosure: { kind: 'test_receipt', id: 'r1' },
    });
  });

  it('skips tagged raw messages with neither content nor tools', async () => {
    reminder.register('empty_raw_test', () => ({ message: { role: 'system', content: [] } }));

    await runInjectionStep();

    expect(context.get()).toHaveLength(0);
  });

  it('skips a throwing step provider and still runs the rest', async () => {
    reminder.register('step_throwing', () => {
      throw new Error('boom');
    });
    reminder.register('step_surviving', () => 'surviving reminder');

    await runInjectionStep();

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('surviving reminder');
  });

  it('skips a rejecting step provider and still runs the rest', async () => {
    reminder.register('step_rejecting', () => Promise.reject(new Error('boom')));
    reminder.register('step_surviving', () => 'surviving reminder');

    await runInjectionStep();

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('surviving reminder');
  });

  it('installs effects only after restore and only once', async () => {
    const local = createTestAgent();
    const localLoop = local.get(IAgentLoopService) as StubLoop;
    const localReminder = local.get(IAgentReminderService);
    let calls = 0;
    localReminder.register('restore_test', () => {
      calls += 1;
      return undefined;
    });

    await runWillBeginStepHooks(localLoop, false);
    expect(calls).toBe(0);

    await local.restorePersisted();
    await runWillBeginStepHooks(localLoop, false);
    expect(calls).toBe(1);

    await local.dispose();
    await runWillBeginStepHooks(localLoop, false);
    expect(calls).toBe(1);
  });

  it('cleans the registry and hook when the feature is withdrawn', async () => {
    let calls = 0;
    reminder.register('withdraw_test', () => {
      calls += 1;
      return undefined;
    });
    await runInjectionStep();
    expect(calls).toBe(1);

    await ctx.get(IFeatureManager).unprovideUnit('reminder');
    await runInjectionStep();

    expect(calls).toBe(1);
    expect(() => ctx.get(IAgentReminderService)).toThrow("unknown service 'agentReminderService'");
  });

  it('resumes injection when the feature is re-provided after restore', async () => {
    await ctx.get(IFeatureManager).unprovideUnit('reminder');
    expect(() => ctx.get(IAgentReminderService)).toThrow("unknown service 'agentReminderService'");

    ctx.get(IFeatureManager).provideUnit(ReminderFeature);

    let calls = 0;
    const revived = await vi.waitFor(() => ctx.get(IAgentReminderService));
    revived.register('reprovide_test', () => {
      calls += 1;
      return undefined;
    });
    loop = ctx.get(IAgentLoopService) as StubLoop;
    await vi.waitFor(async () => {
      await runInjectionStep();
      expect(calls).toBeGreaterThan(0);
    });
  });
});
