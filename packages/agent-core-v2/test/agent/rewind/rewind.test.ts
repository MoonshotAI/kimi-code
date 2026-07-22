import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnModel } from '#/agent/loop/turnOps';
import { IAgentPlanService } from '#/agent/plan/plan';
import { PlanModel } from '#/agent/plan/planOps';
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
    // The compaction shape keeps the recent user message plus the summary;
    // turn 2 is gone.
    const history = ctx.context.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'user']);
    expect(history[1]?.origin?.kind).toBe('compaction_summary');
  });

  it('restores todos to their pre-turn value', async () => {
    setup();
    const rewind = ctx.get(IAgentRewindService);
    const wire = ctx.get(IWireService);
    ctx.appendTurnExchange('u1', 'a1');
    // The session todo facade is not wired to the harness agent lifecycle;
    // dispatch the todo ops directly (the facade's own target wire anyway).
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

    await rewind.rewind(1);

    expect(wire.getModel(PlanModel).current.active).toBe(false);
    expect(ctx.get(IAgentTelemetryContextService).get().mode).toBe('agent');
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
