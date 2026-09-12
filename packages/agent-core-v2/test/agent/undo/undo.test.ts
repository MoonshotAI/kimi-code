import { afterEach, describe, expect, it, vi } from 'vitest';

import { type IDisposable } from '#/_base/di/lifecycle';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import { ContextApplyCompaction } from '#/agent/contextMemory/contextEvents';
import { isPromptOwnedInjection, isUndoAnchor } from '#/agent/contextMemory/conversationTime';
import type { ContextMessage, TaskOrigin } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { turnKey } from '#/agent/loop/turnOps';
import { IAgentPlanService } from '#/features/plan/plan';
import { planKey } from '#/features/plan/planOps';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService, type AgentTask } from '#/agent/task/task';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { ContextUndone } from '#/agent/undo/undoService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ToolsUpdateStore } from '#/features/todo/todoOps';
import type { TodoItem } from '#/features/todo/todoItem';
import { IAgentTodoService } from '#/features/todo/todoService';
import type { DurableAgentRuntimeParticipant } from '#/state/eventDispatcher';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import type { WireRecord } from '#/wire/record';
import { IWireService } from '#/wire/wire';

import { createTestAgent, execEnvServices, telemetryServices, InMemoryWireRecordPersistence, type TestAgentContext } from '../../harness';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { ITelemetryService } from '#/app/telemetry/telemetry';

describe('AgentConversationUndoService', () => {
  let ctx: TestAgentContext;
  let records: TelemetryRecord[];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  async function setup() {
    records = [];
    ctx = createTestAgent(
      telemetryServices(recordingTelemetry(records)),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    ctx.get(IAgentContextMemoryService);
    await ctx.restorePersisted();
    return ctx;
  }

  it('exposes availability from context history', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);
    expect(undo.availability()).toEqual({ maxTurns: 0, stoppedAtCompaction: false });

    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');
    expect(undo.availability()).toEqual({ maxTurns: 2, stoppedAtCompaction: false });
  });

  it('rejects undo with structured reasons', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);

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
    await setup();
    ctx.appendTurnExchange('u1', 'a1');
    const history = ctx.context.get();

    await expect(ctx.get(IAgentConversationUndoService).undo(count)).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID,
      details: { field: 'count' },
    });

    expect(ctx.context.get()).toBe(history);
  });

  it('returns session.busy for an active turn without cancelling it', async () => {
    await setup();
    const loop = ctx.get(IAgentLoopService);
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
    const turn = loop.submit({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'system work' }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'test' },
      },
    }).turn;
    await didStart;
    const history = ctx.context.get();

    await expect(ctx.get(IAgentConversationUndoService).undo(1)).rejects.toMatchObject({
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
    await setup();
    ctx.appendTurnExchange('u1', 'a1');
    const history = ctx.context.get();
    const compaction = ctx.get(IAgentFullCompactionService);
    const abortController = new AbortController();
    const active = vi.spyOn(compaction, 'compacting', 'get').mockReturnValue({
      abortController,
      promise: new Promise<never>(() => {}),
      trigger: 'manual',
      tokenCount: 2,
    });

    try {
      await expect(ctx.get(IAgentConversationUndoService).undo(1)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_BUSY,
        details: { reason: 'compaction' },
      });
      expect(abortController.signal.aborted).toBe(false);
      expect(ctx.context.get()).toBe(history);
    } finally {
      active.mockRestore();
    }
  });

  it('refuses to cross a compaction boundary', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.get(IAgentContextMemoryService).applyCompaction({
      summary: 'summary of u1',
      compactedCount: 2,
      tokensBefore: 100,
      tokensAfter: 10,
    });
    ctx.appendTurnExchange('u2', 'a2');

    expect(undo.availability()).toEqual({ maxTurns: 1, stoppedAtCompaction: true });
    await expect(undo.undo(2)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_UNDO_UNAVAILABLE,
      details: { reason: 'compaction_boundary', requestedCount: 2, undoableCount: 1 },
    });

    await undo.undo(1);
    const history = ctx.context.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'user', 'user']);
    expect(history[1]?.origin?.kind).toBe('compaction_summary');
    expect(history[2]?.origin).toEqual({ kind: 'injection', variant: 'compaction_continuation' });
  });

  it('rejects undo across a legacy compaction boundary even when the in-memory precheck allows it', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);
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

  it('cuts before the anchor that survives a legacy unpaired undo', async () => {
    records = [];
    const prompt = (text: string): WireRecord => ({
      type: 'context.append_message',
      agentId: 'main',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: 1,
    });
    const reply = (text: string): WireRecord => ({
      type: 'context.append_message',
      agentId: 'main',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        toolCalls: [],
      },
      time: 1,
    });
    const persistence = new InMemoryWireRecordPersistence([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      prompt('u1'),
      reply('a1'),
      prompt('u2'),
      reply('a2'),
      { type: 'context.undo', agentId: 'main', count: 1, time: 2 },
      prompt('u3'),
      reply('a3'),
    ] as WireRecord[]);
    ctx = createTestAgent(
      { autoConfigure: false, persistence },
      telemetryServices(recordingTelemetry(records)),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    ctx.get(IAgentContextMemoryService);
    await ctx.restorePersisted();
    expect(
      ctx.context.get().map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')),
    ).toEqual(['u1', 'a1', 'u3', 'a3']);

    await ctx.get(IAgentConversationUndoService).undo(2);

    expect(ctx.context.get()).toEqual([]);
    const persisted = await ctx.persistedWireRecords();
    const edgeIndex = persisted.findIndex((record) => record.type === 'agent.switched');
    expect(persisted[edgeIndex]).toMatchObject({
      branch: 'b1',
      base: { branch: 'main', line: 1 },
      turns: 2,
      legacyUndoLine: 10,
    });
    expect(persisted[edgeIndex + 1]).toMatchObject({ type: 'context.undo', count: 2 });
    expect(persisted[edgeIndex + 2]).toMatchObject({ type: 'context.undone', turns: 2 });
  });

  it('restores plan mode and its telemetry mirror to their pre-turn value', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);
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
      expect(ctx.get(ITelemetryService).getContext().mode).toBe('agent');
      expect(restoredModes).toEqual([false]);
    } finally {
      subscription.dispose();
    }
  });

  it('keeps machine and wire turn ids aligned across undo, a continued turn, and a restart', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);

    const runTurn = async (
      target: TestAgentContext,
      text: string,
    ): Promise<number | undefined> => {
      target.mockNextResponse({ type: 'text', text: `answer to ${text}` });
      const { turn } = target.get(IAgentLoopService).submit({
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      });
      await expect(turn.result).resolves.toMatchObject({ type: 'completed' });
      return turn.id;
    };

    await runTurn(ctx, 'u1');
    await runTurn(ctx, 'u2');
    expect(ctx.agentState.get(turnKey).nextTurnId).toBe(2);

    await undo.undo(1);

    expect(ctx.agentState.get(turnKey).nextTurnId).toBe(2);

    await expect(runTurn(ctx, 'u3')).resolves.toBe(1);

    const persisted = await ctx.persistedWireRecords();
    expect(
      persisted.filter((record) => record.type === 'turn.prompt').map((record) => record['turnId']),
    ).toEqual([0, 1, 1]);
    expect(
      persisted
        .filter((record) => record.type === 'human.agent.turn.started')
        .map((record) => record['turnId']),
    ).toEqual([0, 1, 1]);

    const resumed = createTestAgent(
      { autoConfigure: false, persistence: new InMemoryWireRecordPersistence(persisted) },
      telemetryServices(recordingTelemetry(records)),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    try {
      resumed.get(IAgentContextMemoryService);
      await resumed.restorePersisted();
      expect(resumed.agentState.get(turnKey).nextTurnId).toBe(2);
      await expect(runTurn(resumed, 'u4')).resolves.toBe(2);
      const repersisted = await resumed.persistedWireRecords();
      expect(
        repersisted
          .filter((record) => record.type === 'human.agent.turn.started')
          .map((record) => record['turnId']),
      ).toEqual([0, 1, 1, 2]);
    } finally {
      await resumed.dispose();
    }
  });

  it('reports the removed turn id only when context anchors were opened by engine turns', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);
    const loop = ctx.get(IAgentLoopService);

    ctx.mockNextResponse({ type: 'text', text: 'a1' });
    const userTurn = loop.submit({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'u1' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    }).turn;
    await expect(userTurn.result).resolves.toMatchObject({ type: 'completed' });

    ctx.mockNextResponse({ type: 'text', text: 'cron done' });
    const cronTurn = loop.submit({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'cron work' }],
        toolCalls: [],
        origin: {
          kind: 'cron_job',
          jobId: 'j1',
          cron: '0 9 * * *',
          recurring: true,
          coalescedCount: 0,
          stale: false,
        },
      },
    }).turn;
    await expect(cronTurn.result).resolves.toMatchObject({ type: 'completed' });

    let fromTurnId: number | undefined;
    const subscription = ctx.get(IEventBus).subscribe(ContextUndone, (event) => {
      fromTurnId = event.fromTurnId;
    });
    try {
      await undo.undo(1);
      expect(fromTurnId).toBe(userTurn.id);
      expect(ctx.agentState.get(turnKey).anchorTurnIds).toEqual([]);
      expect(ctx.context.get()).toHaveLength(0);
    } finally {
      subscription.dispose();
    }

    ctx.get(IAgentContextMemoryService).append(
      {
        role: 'user',
        content: [{ type: 'text', text: 'u2' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a2' }],
        toolCalls: [],
      },
    );

    let absentTurnId: number | undefined = Number.NaN;
    const second = ctx.get(IEventBus).subscribe(ContextUndone, (event) => {
      absentTurnId = event.fromTurnId;
    });
    try {
      await undo.undo(1);
      expect(absentTurnId).toBeUndefined();
    } finally {
      second.dispose();
    }
  });

  it('flushes state reconciliation before publishing undo', async () => {
    await setup();
    const wire = ctx.get(IWireService);
    const order: string[] = [];
    const flush = vi.spyOn(wire, 'flush');
    const originalFlush = flush.getMockImplementation();
    flush.mockImplementation(async () => {
      order.push('flush');
      await originalFlush?.();
    });
    const participants = ctx.get(IAgentConversationUndoParticipantRegistry);
    participants.register({
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
      await ctx.get(IAgentConversationUndoService).undo(1);

      expect(order).toEqual(['flush', 'flush', 'state', 'flush', 'context.undone']);
    } finally {
      subscription.dispose();
      flush.mockRestore();
    }
  });

  it.each([
    [1, []],
    [3, ['state']],
  ] as const)(
    'rejects the undo when wire flush %i fails',
    async (failureCall, expectedReconciled) => {
      await setup();
      const wire = ctx.get(IWireService);
      const originalFlush = wire.flush.bind(wire);
      let flushCalls = 0;
      const storageError = new Error('storage unavailable');
      const flush = vi.spyOn(wire, 'flush').mockImplementation(async () => {
        flushCalls += 1;
        if (flushCalls === failureCall) throw storageError;
        await originalFlush();
      });
      const originalAppend = wire.appendRecord.bind(wire);
      const appendRecord = vi.spyOn(wire, 'appendRecord');
      if (failureCall === 1) {
        appendRecord.mockImplementation((record, dehydrate) => {
          if (
            record.type === 'agent.switched' ||
            record.type === 'context.undo' ||
            record.type === 'context.undone'
          ) {
            return;
          }
          originalAppend(record, dehydrate);
        });
      }
      const reconciled: string[] = [];
      const participants = ctx.get(IAgentConversationUndoParticipantRegistry);
      participants.register({
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
        await expect(ctx.get(IAgentConversationUndoService).undo(1)).rejects.toBe(storageError);
        if (failureCall === 1) {
          expect(ctx.context.get().map((message) => message.role)).toEqual(['user', 'assistant']);
        } else {
          expect(ctx.context.get()).toEqual([]);
        }
        expect(reconciled).toEqual(expectedReconciled);
        expect(undone).toEqual([]);
        expect(records.filter((record) => record.event === 'conversation_undo')).toEqual([]);
      } finally {
        subscription.dispose();
        appendRecord.mockRestore();
        flush.mockRestore();
      }
    },
  );

  it('serializes concurrent undos through state reconciliation', async () => {
    await setup();
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
    ctx.get(IAgentConversationUndoParticipantRegistry).register({
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

    const first = ctx.get(IAgentConversationUndoService).undo(1);
    await firstStarted;
    const second = ctx.get(IAgentConversationUndoService).undo(1);
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
    await setup();
    ctx.get(IAgentConversationUndoService);
    ctx.appendTurnExchange('u1', 'a1');
    ctx.appendTurnExchange('u2', 'a2');

    await ctx.rpc.undoHistory({ count: 1 });

    expect(records).toContainEqual({
      event: 'conversation_undo',
      properties: {
        agent_id: 'main',
        count: 1,
        mode: 'agent',
        model: 'mock-model',
        protocol: 'openai',
        provider_type: 'kimi',
      },
    });
    expect(ctx.context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('reconciles lastPrompt after undo', async () => {
    await setup();
    const metadata = ctx.get(ISessionMetadata);
    await metadata.ready;
    await metadata.update({ lastPrompt: 'u1' });
    ctx.appendTurnExchange('u1', 'a1');

    await ctx.get(IAgentConversationUndoService).undo(1);
    await expect(metadata.read()).resolves.toMatchObject({ lastPrompt: undefined });

    ctx.appendTurnExchange('u2', 'a2');
    ctx.appendTurnExchange('u3', 'a3');
    const list = vi.spyOn(ctx.get(IAgentPromptService), 'list').mockReturnValue({
      active: undefined,
      launching: false,
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
      await ctx.get(IAgentConversationUndoService).undo(1);
      await expect(metadata.read()).resolves.toMatchObject({ lastPrompt: 'queued prompt' });
    } finally {
      list.mockRestore();
    }
  });

  it('treats metadata reconciliation failure as non-fatal after committing undo', async () => {
    await setup();
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
      await expect(ctx.get(IAgentConversationUndoService).undo(1)).resolves.toBe(1);

      expect(ctx.context.get().map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(undone).toEqual([1]);
      expect(records).toContainEqual({
        event: 'conversation_undo',
        properties: {
          agent_id: 'main',
          count: 1,
          mode: 'agent',
          model: 'mock-model',
          protocol: 'openai',
          provider_type: 'kimi',
        },
      });
    } finally {
      subscription.dispose();
      update.mockRestore();
    }
  });

  it('re-delivers wait-reported task notifications after conversation undo', async () => {
    await setup();
    const undo = ctx.get(IAgentConversationUndoService);
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

  it('registers a participant that late-attaches inside the undo rerun window', async () => {
    await setup();
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      const dispatcher = ctx.dispatcher;
      const box: { todos: readonly TodoItem[] } = { todos: [] };
      const folded: TodoItem[][] = [];
      const participant: DurableAgentRuntimeParticipant<{ todos: readonly TodoItem[] }> = {
        id: 'runtime.test.rerun-late',
        events: [ToolsUpdateStore],
        undoable: true,
        transition: (draft, event) => {
          if (event instanceof ToolsUpdateStore && event.key === 'todo') {
            const value = event.value as TodoItem[];
            draft.todos = value;
            folded.push(value);
          }
        },
        getState: () => box,
        commit: (next) => {
          box.todos = next.todos;
        },
      };
      const update = (title: string) =>
        new ToolsUpdateStore({ agentId: 'main', key: 'todo', value: [{ title, status: 'pending' }] });
      await dispatcher.dispatch(update('kept'));
      ctx.appendTurnExchange('u1', 'a1');
      await dispatcher.dispatch(update('doomed'));

      let lateAttach: Promise<IDisposable> | undefined;
      let liveDispatch: Promise<void> | undefined;
      const originalRestore = dispatcher.restore.bind(dispatcher);
      const restoreSpy = vi.spyOn(dispatcher, 'restore').mockImplementation(async () => {
        const restored = originalRestore();
        lateAttach = dispatcher.attachLate(participant);
        liveDispatch = dispatcher.dispatch(update('live'));
        await restored;
      });
      try {
        await ctx.get(IAgentConversationUndoService).undo(1);

        await expect(lateAttach!).resolves.toBeDefined();
        await liveDispatch;
        expect(folded).toEqual([
          [{ title: 'kept', status: 'pending' }],
          [{ title: 'live', status: 'pending' }],
        ]);
        expect(box.todos).toEqual([{ title: 'live', status: 'pending' }]);

        await dispatcher.dispatch(update('after'));
        expect(box.todos).toEqual([{ title: 'after', status: 'pending' }]);
        expect(ctx.get(IAgentTodoService).get()).toEqual([{ title: 'after', status: 'pending' }]);
        expect(
          unexpected.filter((error) => String((error as Error)?.message).includes('late-attached')),
        ).toEqual([]);
      } finally {
        restoreSpy.mockRestore();
      }
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('recovers the undo when the rerun restore fails transiently', async () => {
    await setup();
    ctx.appendTurnExchange('u1', 'a1');
    const wire = ctx.get(IWireService);
    const originalFlush = wire.flush.bind(wire);
    const failure = new Error('transient storage failure');
    let flushCalls = 0;
    const flush = vi.spyOn(wire, 'flush').mockImplementation(async () => {
      flushCalls += 1;
      if (flushCalls === 2) throw failure;
      await originalFlush();
    });

    try {
      await expect(ctx.get(IAgentConversationUndoService).undo(1)).resolves.toBe(1);

      expect(ctx.context.get()).toEqual([]);
      expect(ctx.dispatcher.restorePhase).toBe('ready');
      const persisted = await ctx.persistedWireRecords();
      expect(persisted.filter((record) => record.type === 'agent.switched')).toHaveLength(1);
      expect(records.filter((record) => record.event === 'conversation_undo')).toHaveLength(1);
    } finally {
      flush.mockRestore();
    }
  });

  it('keeps terminal state equivalent across a legacy record-level downgrade round trip, and documents the orphan-edge crash window', async () => {
    records = [];
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      { persistence },
      telemetryServices(recordingTelemetry(records)),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    ctx.get(IAgentContextMemoryService);
    await ctx.restorePersisted();

    ctx.appendTurnExchange('u1', 'a1');
    await ctx.dispatcher.dispatch(
      new ToolsUpdateStore({ agentId: 'main', key: 'todo', value: [{ title: 'kept', status: 'pending' }] }),
    );
    ctx.appendTurnExchange('u2', 'a2');
    await ctx.dispatcher.dispatch(
      new ToolsUpdateStore({ agentId: 'main', key: 'todo', value: [{ title: 'doomed', status: 'pending' }] }),
    );
    ctx.get(IWireService).append({
      type: 'human.agent.turn.ended',
      kind: 'event',
      turnId: 0,
      outcome: 'done',
      time: 100,
    });
    await ctx.get(IAgentConversationUndoService).undo(1);

    expect(ctx.context.get().map(messageText)).toEqual(['user:u1', 'assistant:a1']);
    expect(ctx.get(IAgentTodoService).get().map((item) => item.title)).toEqual(['kept']);
    const afterNew = await ctx.persistedWireRecords();
    const legacyAfterNew = legacyWireFold(afterNew);
    expect(legacyAfterNew.context).toEqual(['user:u1', 'assistant:a1']);
    expect(legacyAfterNew.todo).toEqual(['kept']);
    expect(legacyAfterNew.skippedUnknownTypes).toEqual([
      'human.agent.turn.ended',
      'agent.switched',
    ]);

    persistence.records.push(
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'u3' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: 200,
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a3' }], toolCalls: [] },
        time: 201,
      },
      { type: 'context.undo', agentId: 'main', count: 1, time: 202 },
    );
    const finalRecords = [...persistence.records];
    const legacyFinal = legacyWireFold(finalRecords);
    expect(legacyFinal.context).toEqual(['user:u1', 'assistant:a1']);
    expect(legacyFinal.todo).toEqual(['kept']);
    expect(legacyFinal.skippedUnknownTypes).toEqual([
      'human.agent.turn.ended',
      'agent.switched',
    ]);

    const reopened = createTestAgent(
      { autoConfigure: false, persistence: new InMemoryWireRecordPersistence(finalRecords) },
      telemetryServices(recordingTelemetry([])),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    try {
      reopened.get(IAgentContextMemoryService);
      await reopened.restorePersisted();
      expect(reopened.context.get().map(messageText)).toEqual(legacyFinal.context);
      expect(reopened.get(IAgentTodoService).get().map((item) => item.title)).toEqual(
        legacyFinal.todo,
      );
    } finally {
      await reopened.dispose();
    }
    await ctx.dispose();

    const orphanRecords: WireRecord[] = [
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'u1' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: 1,
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }], toolCalls: [] },
        time: 2,
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'u2' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: 3,
      },
      {
        type: 'context.append_message',
        agentId: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }], toolCalls: [] },
        time: 4,
      },
      {
        type: 'agent.switched',
        agentId: 'main',
        branch: 'b1',
        reason: 'undo',
        base: { branch: 'main', line: 3 },
        turns: 1,
        legacyUndoLine: 7,
        time: 5,
      },
    ];
    const legacyOrphan = legacyWireFold(orphanRecords);
    expect(legacyOrphan.context).toEqual(['user:u1', 'assistant:a1', 'user:u2', 'assistant:a2']);
    expect(legacyOrphan.skippedUnknownTypes).toEqual(['agent.switched']);

    ctx = createTestAgent(
      { autoConfigure: false, persistence: new InMemoryWireRecordPersistence(orphanRecords) },
      telemetryServices(recordingTelemetry([])),
      execEnvServices({ hostFs: createFakeHostFs({ mkdir: async () => {} }) }),
    );
    ctx.get(IAgentContextMemoryService);
    await ctx.restorePersisted();
    expect(ctx.context.get().map(messageText)).toEqual(['user:u1', 'assistant:a1']);
  });
});

function messageText(message: ContextMessage): string {
  return `${message.role}:${message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')}`;
}

function legacyWireFold(records: readonly WireRecord[]): {
  readonly context: readonly string[];
  readonly todo: readonly string[];
  readonly skippedUnknownTypes: readonly string[];
} {
  const transcript: ContextMessage[] = [];
  const todoCheckpoints: string[][] = [];
  let todo: string[] = [];
  const skippedUnknownTypes: string[] = [];
  let clearFloor = 0;
  const applyUndo = (count: number): void => {
    let removedUserCount = 0;
    for (let i = transcript.length - 1; i >= clearFloor; i--) {
      const message = transcript[i]!;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      transcript.splice(i, 1);
      if (!isUndoAnchor(message)) continue;
      removedUserCount++;
      while (i > clearFloor && isPromptOwnedInjection(transcript[i - 1]!, message)) {
        transcript.splice(i - 1, 1);
        i--;
      }
      if (removedUserCount >= count) break;
    }
    const targetIndex = todoCheckpoints.length - count;
    const target = todoCheckpoints[targetIndex];
    if (target === undefined) return;
    todo = [...target];
    todoCheckpoints.length = targetIndex;
  };
  for (const record of records) {
    switch (record.type) {
      case 'metadata':
        break;
      case 'context.append_message': {
        const message = record['message'] as ContextMessage;
        transcript.push(message);
        if (isUndoAnchor(message)) todoCheckpoints.push([...todo]);
        break;
      }
      case 'context.undo': {
        const count = record['count'];
        if (typeof count === 'number') applyUndo(count);
        break;
      }
      case 'context.clear':
        clearFloor = transcript.length;
        todoCheckpoints.length = 0;
        break;
      case 'tools.update_store': {
        if (record['key'] === 'todo') {
          todo = (record['value'] as { title: string }[]).map((item) => item.title);
        }
        break;
      }
      case 'context.undone':
        break;
      default:
        if (record.type === 'agent.switched' || record.type.startsWith('human.')) {
          skippedUnknownTypes.push(record.type);
        }
        break;
    }
  }
  return {
    context: transcript.slice(clearFloor).map(messageText),
    todo,
    skippedUnknownTypes,
  };
}
