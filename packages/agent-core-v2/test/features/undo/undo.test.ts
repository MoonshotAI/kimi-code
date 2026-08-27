import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentContextMemory } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentUndo } from '#/features/undo/undoAgentRuntime';
import { ContextApplyCompaction } from '#/features/contextMemory/contextEvents';
import type { TaskOrigin } from '#/features/contextMemory/types';
import { LoopControlToken } from '#/features/loop/internal/loop';
import { MessageStepRequest } from '#/features/loop/internal/stepRequest';
import { AgentLoop } from '#/features/loop/loop';
import { IAgentPlanService } from '#/features/plan/plan';
import { planKey } from '#/features/plan/planOps';
import { AgentPrompt } from '#/features/prompt/promptAgentRuntime';
import { AgentFullCompaction } from '#/features/fullCompaction/fullCompactionAgentRuntime';
import { IAgentTaskService, type AgentTask } from '#/agent/task/task';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { ContextUndone } from '#/features/undo/undoEvents';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ToolsUpdateStore } from '#/features/todo/todoOps';
import { AgentTodo } from '#/features/todo/todoAgentRuntime';
import { type ReplayableStateKey } from '#/state/state';
import { IWireService } from '#/wire/wire';

import { createTestAgent, execEnvServices, telemetryServices, type TestAgentContext } from '../../harness';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

describe('UndoRuntime', () => {
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
    ctx = createTestAgent(
      telemetryServices(recordingTelemetry(records)),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    ctx.resolve(AgentContextMemory);
    return ctx;
  }

  it('exposes availability from context history', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    expect(undo.availability()).toEqual({ canUndo: false });

    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    expect(undo.availability()).toEqual({ canUndo: true });
  });

  it('rejects undo with structured reasons', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);

    await expect(undo.undo(1)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'empty', requestedCount: 1, undoableCount: 0 },
    });

    ctx.appendTurnExchange('u1', 'a1');
    await expect(undo.undo(2)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'insufficient', requestedCount: 2, undoableCount: 1 },
    });
  });

  it.each([
    0,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])('rejects invalid undo count %s without mutating history', async (count) => {
    setup();
    ctx.appendTurnExchange('u1', 'a1');
    const history = ctx.context.get();

    await expect(ctx.resolve(AgentUndo).undo(count)).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID,
      details: { field: 'count' },
    });

    expect(ctx.context.get()).toBe(history);
  });

  it('returns session.busy for an active turn without cancelling it', async () => {
    setup();
    const loop = ctx.get(LoopControlToken);
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-invalid-undo', async (_hookCtx, next) => {
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
    const history = ctx.context.get();

    await expect(ctx.resolve(AgentUndo).undo(1)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_BUSY,
      details: { reason: 'loop' },
    });
    expect(turn.signal.aborted).toBe(false);
    expect(loop.status().state).toBe('running');
    expect(ctx.context.get()).toBe(history);

    hook.dispose();
    release();
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });
  });

  it('returns session.busy for active compaction without cancelling it', async () => {
    setup();
    ctx.appendTurnExchange('u1', 'a1');
    const history = ctx.context.get();
    const compaction = ctx.resolve(AgentFullCompaction);
    let release!: () => void;
    const canCompact = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = compaction.registerBeforeCompactHook('test-undo-busy', async () => {
      await canCompact;
    });

    try {
      ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
      const started = compaction.begin({ source: 'auto' });
      await expect(ctx.resolve(AgentUndo).undo(1)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_BUSY,
        details: { reason: 'compaction' },
      });
      expect(compaction.status()).toBe('running');
      expect(ctx.context.get()).toBe(history);

      release();
      await started;
      const finished = new Promise<void>((resolve) => {
        const subscription = compaction.onDidFinish(() => {
          subscription.dispose();
          resolve();
        });
      });
      await finished;
    } finally {
      hook.dispose();
    }
  });

  it('refuses to cross a compaction boundary', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    ctx.appendTurnExchange('u1', 'a1');
    void ctx.resolve(AgentContextMemory).applyCompaction({
      summary: 'summary of u1',
      compactedCount: 2,
      tokensBefore: 100,
      tokensAfter: 10,
    });
    ctx.appendTurnExchange('u2', 'a2');

    expect(undo.availability()).toEqual({ canUndo: true });
    await expect(undo.undo(2)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'compaction_boundary', requestedCount: 2, undoableCount: 1 },
    });

    await undo.undo(1);
    const history = ctx.context.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'user']);
    expect(history[1]?.origin?.kind).toBe('compaction_summary');
  });

  it('refuses loudly when a legacy compaction leaves anchors without checkpoints', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    await ctx.dispatcher.dispatch(
      new ContextApplyCompaction({ agentId: 'main', summary: 'legacy summary', compactedCount: 2 }),
    );
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'user', 'assistant']);

    await expect(undo.undo(1)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'compaction_boundary', requestedCount: 1, undoableCount: 0 },
    });
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('attributes a checkpoint depth failure to the limiting model', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    ctx.appendTurnExchange('u1', 'a1');
    const defective = {
      name: 'testDefective',
      initial: () => null,
      replayable: { undoable: {}, folds: new Map() },
    } as unknown as ReplayableStateKey<unknown>;
    const registration = ctx.agentState.contributeState(defective);

    try {
      await expect(undo.undo(1)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        details: {
          reason: 'checkpoint_lost',
          requestedCount: 1,
          undoableCount: 0,
          model: 'testDefective',
        },
      });
    } finally {
      registration.dispose();
    }
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('restores todos to their pre-turn value', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    const manager = ctx.get(IAgentLifecycleService);
    const agent = ctx.get(IAgentScopeContext).agentContext;
    expect(manager.inspect(agent).contributions.find((entry) => entry.id === 'todo')).toMatchObject({
      id: 'todo',
      status: 'materialized',
      state: [],
      error: undefined,
    });
    ctx.appendTurnExchange('u1', 'a1');
    await ctx.dispatcher.dispatch(
      new ToolsUpdateStore({ agentId: 'main', key: 'todo', value: [{ title: 'kept', status: 'pending' }] }),
    );
    ctx.appendTurnExchange('u2', 'a2');
    await ctx.dispatcher.dispatch(
      new ToolsUpdateStore({ agentId: 'main', key: 'todo', value: [{ title: 'doomed', status: 'pending' }] }),
    );

    await undo.undo(1);

    expect(ctx.resolve(AgentTodo).get()).toEqual([{ title: 'kept', status: 'pending' }]);
  });

  it('restores plan mode and its telemetry mirror to their pre-turn value', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    await ctx.get(IAgentPlanService).enter('plan-x', false);
    const restoredModes: boolean[] = [];
    const subscription = ctx.get(IEventBus).subscribe(AgentStatusUpdated, (event) => {
      if (event.planMode !== undefined) restoredModes.push(event.planMode);
    });

    try {
      await undo.undo(1);

      expect(ctx.agentState.get(planKey).active).toBe(false);
      expect(ctx.get(IAgentTelemetryContextService).get().mode).toBe('agent');
      expect(restoredModes).toEqual([false]);
    } finally {
      subscription.dispose();
    }
  });

  it('does not roll back world-time turn bookkeeping', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    expect(ctx.resolve(AgentLoop).status()).toBe('idle');

    await undo.undo(1);

    expect(ctx.resolve(AgentLoop).status()).toBe('idle');
  });

  it('flushes state reconciliation before publishing undo', async () => {
    setup();
    const wire = ctx.get(IWireService);
    const order: string[] = [];
    const flush = vi.spyOn(wire, 'flush');
    const originalFlush = flush.getMockImplementation();
    flush.mockImplementation(async () => {
      order.push('flush');
      await originalFlush?.();
    });
    const participants = ctx.resolve(AgentUndo);
    participants.registerUndoParticipant({
      id: 'test.state',
      reconcileAfterUndo: async () => {
        order.push('state');
      },
    });
    const subscription = ctx.get(IEventBus).subscribe(ContextUndone, () => {
      order.push('context.undone');
    });
    ctx.appendTurnExchange('u1', 'a1');

    try {
      await ctx.resolve(AgentUndo).undo(1);

      expect(order).toEqual(['flush', 'state', 'flush', 'context.undone']);
    } finally {
      subscription.dispose();
      flush.mockRestore();
    }
  });

  it.each([
    [1, []],
    [2, ['state']],
  ] as const)(
    'rejects the committed undo when post-cut flush %i fails',
    async (failureCall, expectedReconciled) => {
      setup();
      const wire = ctx.get(IWireService);
      const originalFlush = wire.flush.bind(wire);
      let flushCalls = 0;
      const storageError = new Error('storage unavailable');
      const flush = vi.spyOn(wire, 'flush').mockImplementation(async () => {
        flushCalls += 1;
        if (flushCalls === failureCall) throw storageError;
        await originalFlush();
      });
      const reconciled: string[] = [];
      const participants = ctx.resolve(AgentUndo);
      participants.registerUndoParticipant({
        id: 'test.flush-failure-state',
        reconcileAfterUndo: async () => {
          reconciled.push('state');
        },
      });
      const undone: number[] = [];
      const subscription = ctx.get(IEventBus).subscribe(ContextUndone, ({ turns }) => {
        undone.push(turns);
      });
      ctx.appendTurnExchange('u1', 'a1');

      try {
        await expect(ctx.resolve(AgentUndo).undo(1)).rejects.toBe(storageError);
        expect(ctx.context.get()).toEqual([]);
        expect(reconciled).toEqual(expectedReconciled);
        expect(undone).toEqual([]);
        expect(records.filter((record) => record.event === 'conversation_undo')).toEqual([]);
      } finally {
        subscription.dispose();
        flush.mockRestore();
      }
    },
  );

  it('serializes concurrent undos through state reconciliation', async () => {
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
    ctx.resolve(AgentUndo).registerUndoParticipant({
      id: 'test.serial-state',
      reconcileAfterUndo: async () => {
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

    const first = ctx.resolve(AgentUndo).undo(1);
    await firstStarted;
    const second = ctx.resolve(AgentUndo).undo(1);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(ctx.context.get().map((message) => message.role)).toEqual(['user', 'assistant']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(ctx.context.get()).toEqual([]);
  });

  it('publishes context.undone and tracks conversation_undo', async () => {
    setup();
    ctx.resolve(AgentUndo);
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

    await ctx.resolve(AgentUndo).undo(1);

    await expect(metadata.read()).resolves.toMatchObject({ lastPrompt: undefined });
  });

  it('uses the newest pending prompt as lastPrompt after undo', async () => {
    setup();
    const metadata = ctx.get(ISessionMetadata);
    await metadata.ready;
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    const list = vi.spyOn(ctx.resolve(AgentPrompt), 'list').mockReturnValue({
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
      await ctx.resolve(AgentUndo).undo(1);
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
    const undone: number[] = [];
    const subscription = ctx.get(IEventBus).subscribe(ContextUndone, ({ turns }) => {
      undone.push(turns);
    });

    try {
      await expect(ctx.resolve(AgentUndo).undo(1)).resolves.toEqual({ applied: true });

      expect(ctx.context.get().map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(undone).toEqual([1]);
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

    await ctx.resolve(AgentUndo).undo(1);
    await ctx.get(IWireService).flush();

    const wireEvents = ctx.allEvents
      .filter((event) => event.type === '[wire]')
      .map((event) => event.event);
    expect(wireEvents).toContain('context.undo');
    expect(wireEvents).not.toContain('log.cut');
  });

  it('re-delivers wait-reported task notifications after conversation undo', async () => {
    setup();
    const undo = ctx.resolve(AgentUndo);
    const tasks = ctx.get(IAgentTaskService);
    ctx.appendTurnExchange('u1', 'a1');

    const completingTask = (output: string): AgentTask => ({
      idPrefix: 'test',
      kind: 'process',
      description: 'fake process task',
      start: async (sink) => {
        sink.appendOutput(output);
        await sink.settle({ status: 'completed' });
      },
      toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
    });

    const taskA = tasks.registerTask(completingTask('a\n'));
    const taskB = tasks.registerTask(completingTask('b\n'));
    tasks.markTasksDeliveredViaWait([
      { taskId: taskA, status: 'completed' },
      { taskId: taskB, status: 'completed' },
    ]);
    await tasks.wait(taskA, 1000);
    await tasks.wait(taskB, 1000);

    expect(ctx.context.get().some((message) => message.origin?.kind === 'task')).toBe(false);
    expect(ctx.agentState.get(taskNotificationDeliveryKey)).toHaveLength(2);

    await undo.undo(1);

    const redelivered = ctx.context.get().filter((message) => message.origin?.kind === 'task');
    expect(redelivered.map((message) => (message.origin as TaskOrigin).taskId).sort()).toEqual(
      [taskA, taskB].sort(),
    );
  });
});
