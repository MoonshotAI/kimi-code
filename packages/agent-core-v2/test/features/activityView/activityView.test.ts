import { afterEach, describe, expect, it } from 'vitest';

import type { Event2, Event2Class } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { IDisposable } from '#/_base/di/lifecycle';
import { stubAgentContext } from '../../agent/agentContext/stubs';
import { IAgentHostService } from '#/agent/host/agentHost';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import { AgentTask } from '#/features/task/taskAgentRuntime';
import { TaskStarted, TaskTerminatedNotice } from '#/features/task/taskOps';
import type { AgentTaskInfo } from '#/features/task/types';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import {
  AgentActivityView,
  activityViewAgentRuntimeProvider,
  type ActivityViewRuntime,
} from '#/features/activityView/activityViewAgentRuntime';
import { AgentActivityUpdated } from '#/features/activityView/activityViewEvents';
import type { AgentActivityState } from '#/features/activityView/types';
import {
  CompactionCancelled,
  CompactionStarted,
} from '#/features/fullCompaction/fullCompactionEvents';
import { AgentFullCompaction } from '#/features/fullCompaction/fullCompactionAgentRuntime';
import { registerLoopControl } from '#/features/loop/internal/access';
import type { LoopControl } from '#/features/loop/internal/loop';
import { TurnStarted } from '#/features/loop/turnEvents';
import { TurnEnded } from '#/features/loop/turnOps';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';

import {
  agentService,
  createTestAgent,
  InMemoryWireRecordPersistence,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

class FakeBus {
  private readonly byType = new Map<string, Array<(e: Event2) => void>>();
  private readonly all: Array<(e: Event2) => void> = [];
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    for (const h of this.all) h(event);
    for (const h of this.byType.get(event.type) ?? []) h(event);
  }

  subscribe(typeOrClass: unknown, handler?: unknown): IDisposable {
    if (typeof typeOrClass === 'function' && !('type' in typeOrClass)) {
      this.all.push(typeOrClass as (e: Event2) => void);
      return { dispose: () => {} };
    }
    const type =
      typeof typeOrClass === 'string' ? typeOrClass : (typeOrClass as Event2Class).type;
    const list = this.byType.get(type) ?? [];
    list.push(handler as (e: Event2) => void);
    this.byType.set(type, list);
    return { dispose: () => {} };
  }
}

function makeTaskInfo(taskId: string): AgentTaskInfo {
  return {
    taskId,
    kind: 'process',
    description: 'sleep 60',
    status: 'running',
    startedAt: 100,
    endedAt: null,
    command: 'sleep 60',
    pid: 4242,
    exitCode: null,
  };
}

function turnEndedRecord(turnId: number, reason: string, durationMs?: number): WireRecord {
  return { type: 'turn.ended', agentId: 'main', turnId, reason, durationMs, time: 1 };
}

function track(ctx: TestAgentContext): {
  view: ActivityViewRuntime;
  updates: () => AgentActivityState[];
} {
  const published: AgentActivityState[] = [];
  ctx.get(IEventBus).subscribe(AgentActivityUpdated, (event) => {
    published.push(event);
  });
  return { view: ctx.resolve(AgentActivityView), updates: () => published };
}

describe('AgentActivityView', () => {
  const contexts: TestAgentContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.dispose();
  });

  function harness(
    ...inputs: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): TestAgentContext {
    const ctx = createTestAgent(...inputs);
    contexts.push(ctx);
    return ctx;
  }

  it('starts with an empty, not-busy snapshot', () => {
    const ctx = harness();
    const { view } = track(ctx);
    expect(view.state()).toEqual({ lifecycle: 'ready', background: [] });
  });

  it('folds task.started / task.terminated into the background slice', () => {
    const ctx = harness();
    const { view, updates } = track(ctx);

    ctx.get(IEventBus).publish(new TaskStarted({ agentId: 'main', info: makeTaskInfo('bash-1') }));
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-1', since: 100 }]);
    expect(updates().at(-1)?.background).toHaveLength(1);

    ctx
      .get(IEventBus)
      .publish(new TaskTerminatedNotice({ agentId: 'main', info: makeTaskInfo('bash-1') }));
    expect(view.state().background).toEqual([]);
    expect(updates().at(-1)?.background).toHaveLength(0);
  });

  it('seeds the background slice from the task registry on creation', async () => {
    const bus = new FakeBus();
    const agent = stubAgentContext('main', 1);
    const loop = {
      status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
    } as unknown as LoopControl;
    registerLoopControl(agent, loop, () => ({ nextTurnId: 1, cancelledTurnIds: [] }));
    const accessor = {
      get: (id: unknown): unknown => {
        if (id === IAgentHostService) return { of: () => ({ eventBus: bus }) };
        if (id === IAgentLifecycleService) {
          return {
            resolve: (_agent: unknown, definition: unknown) => {
              if (definition === AgentFullCompaction) return { status: () => 'idle' };
              if (definition === AgentTask) return { list: () => [makeTaskInfo('bash-9')] };
              throw new Error(`unexpected runtime resolution: ${String(definition)}`);
            },
          };
        }
        throw new Error(`unexpected service resolution: ${String(id)}`);
      },
    };
    const dispatcher = {
      dispatch: (event: Event2) => {
        bus.publish(event);
        return Promise.resolve();
      },
    };
    const runtimes = new AgentRuntimeSet(agent, accessor as never, () => dispatcher as never);
    runtimes.apply({
      definition: AgentActivityView,
      provider: activityViewAgentRuntimeProvider,
      generation: 1,
      active: true,
    });
    const view = runtimes.resolve(AgentActivityView);
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-9', since: 100 }]);
    await runtimes.close();
  });

  it('seeds lastTurn from the wire turnKey when the view is built after restore', async () => {
    const ctx = harness(
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence([
          createWireMetadataRecord(1),
          turnEndedRecord(7, 'failed', 1234),
        ]),
      ),
    );
    await ctx.restorePersisted();
    const { view } = track(ctx);
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('seeds lastTurn when the wire restore lands after construction (cold resume ordering)', async () => {
    const ctx = harness();
    const { view } = track(ctx);
    expect(view.state().lastTurn).toBeUndefined();
    await ctx.restore([turnEndedRecord(7, 'failed', 1234)]);
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('does not overwrite a live lastTurn when the restore hook runs', async () => {
    const ctx = harness();
    const { view } = track(ctx);
    ctx.get(IEventBus).publish(new TurnEnded({ agentId: 'main', turnId: 9, reason: 'completed' }));
    await ctx.restore([turnEndedRecord(7, 'failed', 1234)]);
    expect(view.state().lastTurn).toMatchObject({ turnId: 9, reason: 'completed' });
  });

  it('leaves lastTurn empty when the wire has no ended turn', () => {
    const ctx = harness();
    const { view } = track(ctx);
    expect(view.state().lastTurn).toBeUndefined();
  });

  it('folds full compaction into the background slice', () => {
    const ctx = harness();
    const { view } = track(ctx);

    ctx.get(IEventBus).publish(new CompactionStarted({ agentId: 'main', trigger: 'manual' }));
    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);

    ctx.get(IEventBus).publish(new CompactionCancelled({ agentId: 'main' }));
    expect(view.state().background).toEqual([]);
  });

  it('seeds an in-flight full compaction on creation', async () => {
    const bus = new FakeBus();
    const agent = stubAgentContext('main', 1);
    const loop = {
      status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
    } as unknown as LoopControl;
    registerLoopControl(agent, loop, () => ({ nextTurnId: 1, cancelledTurnIds: [] }));
    const accessor = {
      get: (id: unknown): unknown => {
        if (id === IAgentHostService) return { of: () => ({ eventBus: bus }) };
        if (id === IAgentLifecycleService) {
          return {
            resolve: (_agent: unknown, definition: unknown) => {
              if (definition === AgentFullCompaction) return { status: () => 'running' };
              if (definition === AgentTask) return { list: () => [] };
              throw new Error(`unexpected runtime resolution: ${String(definition)}`);
            },
          };
        }
        throw new Error(`unexpected service resolution: ${String(id)}`);
      },
    };
    const dispatcher = {
      dispatch: (event: Event2) => {
        bus.publish(event);
        return Promise.resolve();
      },
    };
    const runtimes = new AgentRuntimeSet(agent, accessor as never, () => dispatcher as never);
    runtimes.apply({
      definition: AgentActivityView,
      provider: activityViewAgentRuntimeProvider,
      generation: 1,
      active: true,
    });
    const view = runtimes.resolve(AgentActivityView);
    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);
    await runtimes.close();
  });

  it('folds turn boundaries into turn / lastTurn', () => {
    const ctx = harness();
    const { view } = track(ctx);

    ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    expect(view.state().turn?.turnId).toBe(1);

    ctx.get(IEventBus).publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }));
    expect(view.state().turn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the previous outcome when a new turn starts', () => {
    const ctx = harness();
    const { view } = track(ctx);

    ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    ctx.get(IEventBus).publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'cancelled' }));
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'cancelled' });

    ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 2, origin: { kind: 'user' } }));
    expect(view.state().lastTurn).toBeUndefined();

    ctx.get(IEventBus).publish(new TurnEnded({ agentId: 'main', turnId: 2, reason: 'completed' }));
    expect(view.state().lastTurn).toMatchObject({ turnId: 2, reason: 'completed' });
  });

  it('exposes the engine-minted interaction id as the approval id', () => {
    const ctx = harness();
    const { view } = track(ctx);

    ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    ctx.get(IEventBus).publish(
      new PermissionApprovalRequested({ agentId: 'main',
        id: 'approval_1',
        sessionId: 's',
        turnId: 1,
        toolCallId: 'tc-1',
        toolName: 'Bash',
        action: 'run',
        toolInput: {},
        display: { kind: 'command', command: 'ls' },
      }),
    );
    expect(view.state().turn?.pendingApprovals).toEqual([
      { approvalId: 'approval_1', toolCallId: 'tc-1', since: expect.any(Number) },
    ]);

    ctx.get(IEventBus).publish(
      new PermissionApprovalResolved({ agentId: 'main',
        id: 'approval_1',
        sessionId: 's',
        turnId: 1,
        toolCallId: 'tc-1',
        toolName: 'Bash',
        action: 'run',
        toolInput: {},
        display: { kind: 'command', command: 'ls' },
        decision: 'approved',
      }),
    );
    expect(view.state().turn?.pendingApprovals).toEqual([]);
  });

  it('falls back to the tool call id when the approval event carries no interaction id', () => {
    const ctx = harness();
    const { view } = track(ctx);

    ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    ctx.get(IEventBus).publish(
      new PermissionApprovalRequested({ agentId: 'main',
        sessionId: 's',
        turnId: 1,
        toolCallId: 'tc-1',
        toolName: 'Bash',
        action: 'run',
        toolInput: {},
        display: { kind: 'command', command: 'ls' },
      }),
    );
    expect(view.state().turn?.pendingApprovals).toEqual([
      { approvalId: 'tc-1', toolCallId: 'tc-1', since: expect.any(Number) },
    ]);
  });

  it('publishes a final disposed snapshot when the agent is removed', async () => {
    const ctx = harness();
    const { view, updates } = track(ctx);
    ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    expect(view.state().turn?.turnId).toBe(1);

    await ctx.get(IAgentLifecycleService).remove(ctx.agentContext);

    const final = updates().at(-1);
    expect(final?.lifecycle).toBe('disposed');
  });
});
