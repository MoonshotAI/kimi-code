/**
 * `AgentActivityView` — the folded read model: turn slice, lastTurn memory,
 * and the background-work busy layer (seeded from task and compaction owners,
 * folded from their lifecycle events).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, turnKey, type TurnModelState } from '#/agent/loop/turnOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskStarted, TaskTerminatedNotice } from '#/agent/task/taskOps';
import type { AgentTaskInfo } from '#/agent/task/types';
import {
  CompactionCancelled,
  CompactionStarted,
} from '#/agent/fullCompaction/compactionOps';
import { AgentActivityView } from '#/agent/activityView/activityViewService';
import { IAgentActivityView, type AgentActivityState } from '#/agent/activityView/activityView';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import type { FullCompactionTask } from '#/agent/fullCompaction/fullCompaction';
import { OrderedHookSlot } from '#/hooks';
import { IEventDispatcher } from '#/state/eventDispatcher';

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

let disposables: DisposableStore;

function harness(
  seedTasks: readonly AgentTaskInfo[] = [],
  compacting: FullCompactionTask | null = null,
  lastEnded?: TurnModelState['lastEnded'],
) {
  const bus = new FakeBus();
  const loop = {
    status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
  } as unknown as IAgentLoopService;
  const tasks = { list: () => seedTasks } as unknown as IAgentTaskService;
  const restoreHooks: Array<() => Promise<void>> = [];
  const dispatcher = {
    dispatch: async (event: Event2) => {
      bus.publish(event);
    },
    hooks: {
      onDidRestore: {
        register: (_id: string, fn: (ctx: undefined, next: () => Promise<void>) => Promise<void>) => {
          restoreHooks.push(async () => fn(undefined, async () => {}));
          return { dispose: () => {} };
        },
      },
    },
  } as unknown as IEventDispatcher;
  const restore = async (ended: TurnModelState['lastEnded']): Promise<void> => {
    agentState.set(turnKey, { nextTurnId: 1, cancelledTurnIds: [], lastEnded: ended });
    for (const hook of restoreHooks) await hook();
  };
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IEventBus, bus as unknown as IEventBus);
  ix.stub(IAgentLoopService, loop);
  ix.stub(IAgentTaskService, tasks);
  ix.stub(IEventDispatcher, dispatcher);
  const agentState = new AgentStateService();
  agentState.contributeState(turnKey);
  agentState.set(turnKey, { nextTurnId: 1, cancelledTurnIds: [], lastEnded });
  ix.set(IAgentStateService, agentState);
  ix.stub(IAgentFullCompactionService, {
    _serviceBrand: undefined,
    compacting,
  } as unknown as IAgentFullCompactionService);
  ix.set(IAgentActivityView, new SyncDescriptor(AgentActivityView));
  const view = ix.get(IAgentActivityView);
  const updates = (): AgentActivityState[] =>
    bus.published
      .filter((e) => e.type === 'agent.activity.updated')
      .map((e) => e as unknown as AgentActivityState);
  return { bus, view, updates, restore };
}

describe('AgentActivityView', () => {
  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('starts with an empty, not-busy snapshot', () => {
    const { view } = harness();
    expect(view.state()).toEqual({ lifecycle: 'ready', background: [] });
  });

  it('folds task.started / task.terminated into the background slice', () => {
    const { bus, view, updates } = harness();

    bus.publish(new TaskStarted({ info: makeTaskInfo('bash-1') }));
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-1', since: 100 }]);
    expect(updates().at(-1)?.background).toHaveLength(1);

    bus.publish(new TaskTerminatedNotice({ info: makeTaskInfo('bash-1') }));
    expect(view.state().background).toEqual([]);
    expect(updates().at(-1)?.background).toHaveLength(0);
  });

  it('seeds the background slice from the task registry on creation', () => {
    const { view } = harness([makeTaskInfo('bash-9')]);
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-9', since: 100 }]);
  });

  it('seeds lastTurn from the wire turnKey when the view is built after restore', () => {
    const { view } = harness([], null, { turnId: 7, reason: 'failed', durationMs: 1234 });
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('seeds lastTurn when the wire restore lands after construction (cold resume ordering)', async () => {
    const { view, restore } = harness();
    expect(view.state().lastTurn).toBeUndefined();
    await restore({ turnId: 7, reason: 'failed', durationMs: 1234 });
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('does not overwrite a live lastTurn when the restore hook runs', async () => {
    const { bus, view, restore } = harness([], null, { turnId: 7, reason: 'failed' });
    bus.publish(new TurnEnded({ turnId: 9, reason: 'completed' }));
    await restore({ turnId: 7, reason: 'failed' });
    expect(view.state().lastTurn).toMatchObject({ turnId: 9, reason: 'completed' });
  });

  it('leaves lastTurn empty when the wire has no ended turn', () => {
    const { view } = harness();
    expect(view.state().lastTurn).toBeUndefined();
  });

  it('folds full compaction into the background slice', () => {
    const { bus, view } = harness();

    bus.publish(new CompactionStarted({ trigger: 'manual' }));
    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);

    bus.publish(new CompactionCancelled({}));
    expect(view.state().background).toEqual([]);
  });

  it('seeds an in-flight full compaction on creation', () => {
    const compacting: FullCompactionTask = {
      abortController: new AbortController(),
      promise: new Promise(() => {}),
      trigger: 'manual',
      tokenCount: 100,
    };

    const { view } = harness([], compacting);

    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);
  });

  it('folds turn boundaries into turn / lastTurn', () => {
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    expect(view.state().turn?.turnId).toBe(1);

    bus.publish(new TurnEnded({ turnId: 1, reason: 'completed' }));
    expect(view.state().turn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the previous outcome when a new turn starts', () => {
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    bus.publish(new TurnEnded({ turnId: 1, reason: 'cancelled' }));
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'cancelled' });

    bus.publish(new TurnStarted({ turnId: 2, origin: { kind: 'user' } }));
    expect(view.state().lastTurn).toBeUndefined();

    bus.publish(new TurnEnded({ turnId: 2, reason: 'completed' }));
    expect(view.state().lastTurn).toMatchObject({ turnId: 2, reason: 'completed' });
  });

  it('exposes the engine-minted interaction id as the approval id', () => {
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    bus.publish(
      new PermissionApprovalRequested({
        id: 'approval_1',
        sessionId: 's',
        agentId: 'main',
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

    bus.publish(
      new PermissionApprovalResolved({
        id: 'approval_1',
        sessionId: 's',
        agentId: 'main',
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
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    bus.publish(
      new PermissionApprovalRequested({
        sessionId: 's',
        agentId: 'main',
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
});
