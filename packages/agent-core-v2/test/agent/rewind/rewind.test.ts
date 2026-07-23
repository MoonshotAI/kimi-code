/**
 * Scenario: rewind validation and restoration across conversation-scoped models.
 * Responsibility: AgentRewindService commits one undo and publishes restored observable state.
 * Wiring: full TestAgentContext with real wire models and event bus.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 test -- test/agent/rewind/rewind.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationReconciliationRegistry } from '#/agent/contextMemory/conversationReconciliation';
import { contextApplyCompaction } from '#/agent/contextMemory/contextOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { TurnModel } from '#/agent/loop/turnOps';
import { IAgentPlanService } from '#/agent/plan/plan';
import { PlanModel } from '#/agent/plan/planOps';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentRewindService } from '#/agent/rewind/rewind';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { TodoModel, todoSet } from '#/session/todo/todoOps';
import { IWireService } from '#/wire/wire';

import { createTestAgent, telemetryServices, type TestAgentContext } from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

describe('AgentRewindService', () => {
  let ctx: TestAgentContext;
  let records: TelemetryRecord[];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function setup() {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));
    ctx.get(IAgentContextMemoryService);
    return ctx;
  }

  it('exposes availability from context history', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    expect(rewind.availability()).toEqual({ maxTurns: 0, stoppedAtCompaction: false });

    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    expect(rewind.availability()).toEqual({ maxTurns: 2, stoppedAtCompaction: false });
  });

  it('rejects undo with structured reasons', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);

    await expect(rewind.rewind(1)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'empty', requestedCount: 1, undoableCount: 0 },
    });

    ctx.appendTurnExchange('u1', 'a1');
    await expect(rewind.rewind(2)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'insufficient', requestedCount: 2, undoableCount: 1 },
    });
  });

  it('does not interrupt an active turn when undo is unavailable', async () => {
    setup();
    const loop = ctx.get(IAgentLoopService);
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-invalid-rewind', async (_hookCtx, next) => {
      started();
      await canFinish;
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'system result' });
    const turn = (
      await loop.enqueue(
        new MessageStepRequest(
          {
            role: 'user',
            content: [{ type: 'text', text: 'system work' }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'test' },
          },
          { admission: 'newTurn' },
        ),
      ).assigned
    ).turn;
    await didStart;

    await expect(ctx.get(IAgentRewindService).rewind(1)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'empty' },
    });
    expect(turn.signal.aborted).toBe(false);
    expect(loop.status().state).toBe('running');

    hook.dispose();
    release();
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });
  });

  it('refuses to cross a compaction boundary', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.get(IAgentContextMemoryService).applyCompaction({
      summary: 'summary of u1',
      compactedCount: 2,
      tokensBefore: 100,
      tokensAfter: 10,
    });
    ctx.appendTurnExchange('u2', 'a2');

    expect(rewind.availability()).toEqual({ maxTurns: 1, stoppedAtCompaction: true });
    await expect(rewind.rewind(2)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'compaction_boundary', requestedCount: 2, undoableCount: 1 },
    });

    await rewind.rewind(1);
    const history = ctx.context.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'user']);
    expect(history[1]?.origin?.kind).toBe('compaction_summary');
  });

  it('refuses loudly when a legacy compaction leaves anchors without checkpoints', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    const wire = ctx.get(IWireService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    wire.dispatch(contextApplyCompaction({ summary: 'legacy summary', compactedCount: 2 }));
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'user', 'assistant']);

    await expect(rewind.rewind(1)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'compaction_boundary', requestedCount: 1, undoableCount: 0 },
    });
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('restores todos to their pre-turn value', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    const wire = ctx.get(IWireService);
    ctx.appendTurnExchange('u1', 'a1');
    wire.dispatch(todoSet({ key: 'todo', value: [{ title: 'kept', status: 'pending' }] }));
    ctx.appendTurnExchange('u2', 'a2');
    wire.dispatch(todoSet({ key: 'todo', value: [{ title: 'doomed', status: 'pending' }] }));

    await rewind.rewind(1);

    expect(wire.getModel(TodoModel).current).toEqual([{ title: 'kept', status: 'pending' }]);
  });

  it('restores plan mode and its telemetry mirror to their pre-turn value', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    const wire = ctx.get(IWireService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    await ctx.get(IAgentPlanService).enter('plan-x', false);
    const restoredModes: boolean[] = [];
    const subscription = ctx.get(IEventBus).subscribe('agent.status.updated', (event) => {
      if (event.planMode !== undefined) restoredModes.push(event.planMode);
    });

    try {
      await rewind.rewind(1);

      expect(wire.getModel(PlanModel).current.active).toBe(false);
      expect(ctx.get(IAgentTelemetryContextService).get().mode).toBe('agent');
      expect(restoredModes).toEqual([false]);
    } finally {
      subscription.dispose();
    }
  });

  it('does not roll back world-time turn bookkeeping', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    const wire = ctx.get(IWireService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    expect(wire.getModel(TurnModel).nextTurnId).toBe(2);

    await rewind.rewind(1);

    expect(wire.getModel(TurnModel).nextTurnId).toBe(2);
  });

  it('flushes state reconciliation before rebuilding projections', async () => {
    setup();
    const wire = ctx.get(IWireService);
    const order: string[] = [];
    const flush = vi.spyOn(wire, 'flush');
    const originalFlush = flush.getMockImplementation();
    flush.mockImplementation(async () => {
      order.push('flush');
      await originalFlush?.();
    });
    const participants = ctx.get(IAgentConversationReconciliationRegistry);
    participants.register({
      id: 'test.state',
      reconcileAfterRewind: async () => {
        order.push('state');
      },
    });
    participants.register({
      id: 'test.projection',
      phase: 'projection',
      reconcileAfterRewind: async () => {
        order.push('projection');
      },
    });
    const subscription = ctx.get(IEventBus).subscribe('context.rewound', () => {
      order.push('context.rewound');
    });
    ctx.appendTurnExchange('u1', 'a1');

    try {
      await ctx.get(IAgentRewindService).rewind(1);

      expect(order).toEqual([
        'flush',
        'state',
        'flush',
        'projection',
        'flush',
        'context.rewound',
      ]);
    } finally {
      subscription.dispose();
      flush.mockRestore();
    }
  });

  it.each([1, 2, 3])(
    'finishes the committed rewind when post-cut flush %i fails',
    async (failureCall) => {
      setup();
      const wire = ctx.get(IWireService);
      const originalFlush = wire.flush.bind(wire);
      let flushCalls = 0;
      const flush = vi.spyOn(wire, 'flush').mockImplementation(async () => {
        flushCalls += 1;
        if (flushCalls === failureCall) throw new Error('storage unavailable');
        await originalFlush();
      });
      const reconciled: string[] = [];
      const participants = ctx.get(IAgentConversationReconciliationRegistry);
      participants.register({
        id: 'test.flush-failure-state',
        reconcileAfterRewind: async () => {
          reconciled.push('state');
        },
      });
      participants.register({
        id: 'test.flush-failure-projection',
        phase: 'projection',
        reconcileAfterRewind: async () => {
          reconciled.push('projection');
        },
      });
      const rewound: number[] = [];
      const subscription = ctx.get(IEventBus).subscribe('context.rewound', ({ turns }) => {
        rewound.push(turns);
      });
      ctx.appendTurnExchange('u1', 'a1');

      try {
        await expect(ctx.get(IAgentRewindService).rewind(1)).resolves.toBe(1);
        expect(ctx.context.get()).toEqual([]);
        expect(reconciled).toEqual(['state', 'projection']);
        expect(rewound).toEqual([1]);
      } finally {
        subscription.dispose();
        flush.mockRestore();
      }
    },
  );

  it('prevents compaction from starting until rewind reconciliation finishes', async () => {
    setup();
    const compaction = ctx.get(IAgentFullCompactionService);
    let beginAccepted: boolean | undefined;
    ctx.get(IAgentConversationReconciliationRegistry).register({
      id: 'test.compaction-admission',
      reconcileAfterRewind: async () => {
        beginAccepted = compaction.begin({ source: 'manual' });
      },
    });
    ctx.appendTurnExchange('u1', 'a1');

    await ctx.get(IAgentRewindService).rewind(1);

    expect(beginAccepted).toBe(false);
    expect(() => compaction.begin({ source: 'manual' })).toThrowError(
      expect.objectContaining({ code: ErrorCodes.COMPACTION_UNABLE }),
    );
  });

  it('re-enables compaction before releasing held loop work', async () => {
    setup();
    const order: string[] = [];
    const compaction = ctx.get(IAgentFullCompactionService);
    const originalPauseLaunching = compaction.pauseLaunching.bind(compaction);
    const pauseLaunching = vi.spyOn(compaction, 'pauseLaunching').mockImplementation(() => {
      const lease = originalPauseLaunching();
      return {
        dispose: () => {
          order.push('compaction');
          lease.dispose();
        },
      };
    });
    const loop = ctx.get(IAgentLoopService);
    const originalAcquireQuiescence = loop.acquireQuiescence.bind(loop);
    const acquireQuiescence = vi.spyOn(loop, 'acquireQuiescence').mockImplementation(async () => {
      const lease = await originalAcquireQuiescence();
      return {
        dispose: () => {
          order.push('loop');
          lease.dispose();
        },
      };
    });
    ctx.appendTurnExchange('u1', 'a1');

    try {
      await ctx.get(IAgentRewindService).rewind(1);
      expect(order).toEqual(['compaction', 'loop']);
    } finally {
      acquireQuiescence.mockRestore();
      pauseLaunching.mockRestore();
    }
  });

  it('serializes concurrent rewinds through projection reconciliation', async () => {
    setup();
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    ctx.get(IAgentConversationReconciliationRegistry).register({
      id: 'test.serial-projection',
      phase: 'projection',
      reconcileAfterRewind: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        active -= 1;
      },
    });

    const first = ctx.get(IAgentRewindService).rewind(1);
    await firstStarted;
    const second = ctx.get(IAgentRewindService).rewind(1);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(ctx.context.get().map((message) => message.role)).toEqual(['user', 'assistant']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(ctx.context.get()).toEqual([]);
  });

  it('publishes context.rewound and tracks conversation_undo', async () => {
    setup();
    ctx.get(IAgentRewindService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');

    await ctx.rpc.undoHistory({ count: 1 });

    expect(records).toContainEqual({
      event: 'conversation_undo',
      properties: { agent_id: 'main', count: 1 },
    });
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('clears lastPrompt when undo removes the only prompt', async () => {
    setup();
    const metadata = ctx.get(ISessionMetadata);
    await metadata.ready;
    await metadata.update({ lastPrompt: 'u1' });
    ctx.appendTurnExchange('u1', 'a1');

    await ctx.get(IAgentRewindService).rewind(1);

    await expect(metadata.read()).resolves.toMatchObject({ lastPrompt: undefined });
  });

  it('uses the newest pending prompt as lastPrompt after undo', async () => {
    setup();
    const metadata = ctx.get(ISessionMetadata);
    await metadata.ready;
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    const list = vi.spyOn(ctx.get(IAgentPromptService), 'list').mockReturnValue({
      active: undefined,
      pending: [
        {
          id: 'queued',
          userMessageId: 'queued',
          createdAt: new Date(0).toISOString(),
          state: 'pending',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'queued prompt' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
      ],
    });

    try {
      await ctx.get(IAgentRewindService).rewind(1);
      await expect(metadata.read()).resolves.toMatchObject({ lastPrompt: 'queued prompt' });
    } finally {
      list.mockRestore();
    }
  });

  it('treats metadata reconciliation failure as non-fatal after committing undo', async () => {
    setup();
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    const update = vi.spyOn(ctx.get(ISessionMetadata), 'update').mockRejectedValueOnce(
      new Error('metadata write failed'),
    );
    const rewound: number[] = [];
    const subscription = ctx.get(IEventBus).subscribe('context.rewound', ({ turns }) => {
      rewound.push(turns);
    });

    try {
      await expect(ctx.get(IAgentRewindService).rewind(1)).resolves.toBe(1);

      expect(ctx.context.get().map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(rewound).toEqual([1]);
      expect(records).toContainEqual({
        event: 'conversation_undo',
        properties: { agent_id: 'main', count: 1 },
      });
    } finally {
      subscription.dispose();
      update.mockRestore();
    }
  });

  it('persists context.undo without introducing a wire-level cut record', async () => {
    setup();
    ctx.appendTurnExchange('u1', 'a1');

    await ctx.get(IAgentRewindService).rewind(1);
    await ctx.get(IWireService).flush();

    const wireEvents = ctx.allEvents
      .filter((event) => event.type === '[wire]')
      .map((event) => event.event);
    expect(wireEvents).toContain('context.undo');
    expect(wireEvents).not.toContain('log.cut');
  });
});
