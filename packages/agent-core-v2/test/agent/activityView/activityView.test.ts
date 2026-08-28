import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { Event } from '#/_base/event';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { LoopControl } from '#/features/loop/internal/loop';
import { registerLoopControl, type LoopDurableState } from '#/features/loop/internal/access';
import { TurnStarted } from '#/features/loop/turnEvents';
import { TurnEnded } from '#/features/loop/turnOps';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskStarted, TaskTerminatedNotice } from '#/agent/task/taskOps';
import type { AgentTaskInfo } from '#/agent/task/types';
import {
  CompactionCancelled,
  CompactionStarted,
} from '#/features/fullCompaction/fullCompactionEvents';
import { AgentActivityView } from '#/agent/activityView/activityViewService';
import { IAgentActivityView, type AgentActivityState } from '#/agent/activityView/activityView';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import {
  AgentFullCompaction,
  type FullCompactionRuntime,
  type FullCompactionStatus,
} from '#/features/fullCompaction/fullCompactionAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { OrderedHookSlot } from '#/hooks';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { stubAgentContext } from '../agentContext/stubs';

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
  compactionStatus: FullCompactionStatus = 'idle',
  lastEnded?: LoopDurableState['lastEnded'],
) {
  const bus = new FakeBus();
  let durableState: LoopDurableState = { nextTurnId: 1, cancelledTurnIds: [], lastEnded };
  const loop = {
    status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
  } as unknown as LoopControl;
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
  const restore = async (ended: LoopDurableState['lastEnded']): Promise<void> => {
    durableState = { nextTurnId: 1, cancelledTurnIds: [], lastEnded: ended };
    for (const hook of restoreHooks) await hook();
  };
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IEventBus, bus as unknown as IEventBus);
  const agentContext = stubAgentContext('main', 1);
  registerLoopControl(agentContext, loop, () => durableState);
  ix.stub(IAgentTaskService, tasks);
  ix.stub(IEventDispatcher, dispatcher);
  ix.stub(IAgentStateService, new AgentStateService());
  const agentScope: IAgentScopeContext = {
    _serviceBrand: undefined,
    agentId: 'main',
    agentContext,
    scope: (subKey?: string) => subKey ?? '',
  };
  const fullCompaction: FullCompactionRuntime = {
    begin: () => Promise.resolve({ id: 'compaction-1', status: compactionStatus }),
    cancel: () => Promise.resolve(),
    status: () => compactionStatus,
    onDidFinish: Event.None as FullCompactionRuntime['onDidFinish'],
    registerBeforeCompactHook: () => ({ dispose: () => {} }),
  };
  ix.stub(IAgentLifecycleService, {
    _serviceBrand: undefined,
    resolve: (_agent: unknown, definition: unknown) => {
      if (definition === AgentFullCompaction) return fullCompaction;
      throw new Error(`unexpected runtime resolution: ${String(definition)}`);
    },
  } as unknown as IAgentLifecycleService);
  ix.set(
    IAgentActivityView,
    new AgentActivityView(
      ix.get(IEventBus),
      ix.get(IAgentTaskService),
      ix.get(IAgentLifecycleService),
      ix.get(IAgentStateService),
      ix.get(IEventDispatcher),
      agentScope,
    ),
  );
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

    bus.publish(new TaskStarted({ agentId: 'main', info: makeTaskInfo('bash-1') }));
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-1', since: 100 }]);
    expect(updates().at(-1)?.background).toHaveLength(1);

    bus.publish(new TaskTerminatedNotice({ agentId: 'main', info: makeTaskInfo('bash-1') }));
    expect(view.state().background).toEqual([]);
    expect(updates().at(-1)?.background).toHaveLength(0);
  });

  it('seeds the background slice from the task registry on creation', () => {
    const { view } = harness([makeTaskInfo('bash-9')]);
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-9', since: 100 }]);
  });

  it('seeds lastTurn from the wire turnKey when the view is built after restore', () => {
    const { view } = harness([], undefined, { turnId: 7, reason: 'failed', durationMs: 1234 });
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('seeds lastTurn when the wire restore lands after construction (cold resume ordering)', async () => {
    const { view, restore } = harness();
    expect(view.state().lastTurn).toBeUndefined();
    await restore({ turnId: 7, reason: 'failed', durationMs: 1234 });
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('does not overwrite a live lastTurn when the restore hook runs', async () => {
    const { bus, view, restore } = harness([], undefined, { turnId: 7, reason: 'failed' });
    bus.publish(new TurnEnded({ agentId: 'main', turnId: 9, reason: 'completed' }));
    await restore({ turnId: 7, reason: 'failed' });
    expect(view.state().lastTurn).toMatchObject({ turnId: 9, reason: 'completed' });
  });

  it('leaves lastTurn empty when the wire has no ended turn', () => {
    const { view } = harness();
    expect(view.state().lastTurn).toBeUndefined();
  });

  it('folds full compaction into the background slice', () => {
    const { bus, view } = harness();

    bus.publish(new CompactionStarted({ agentId: 'main', trigger: 'manual' }));
    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);

    bus.publish(new CompactionCancelled({ agentId: 'main' }));
    expect(view.state().background).toEqual([]);
  });

  it('seeds an in-flight full compaction on creation', () => {
    const { view } = harness([], 'running');

    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);
  });

  it('folds turn boundaries into turn / lastTurn', () => {
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    expect(view.state().turn?.turnId).toBe(1);

    bus.publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }));
    expect(view.state().turn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the previous outcome when a new turn starts', () => {
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'cancelled' }));
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'cancelled' });

    bus.publish(new TurnStarted({ agentId: 'main', turnId: 2, origin: { kind: 'user' } }));
    expect(view.state().lastTurn).toBeUndefined();

    bus.publish(new TurnEnded({ agentId: 'main', turnId: 2, reason: 'completed' }));
    expect(view.state().lastTurn).toMatchObject({ turnId: 2, reason: 'completed' });
  });

  it('exposes the engine-minted interaction id as the approval id', () => {
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(
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

    bus.publish(
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
    const { bus, view } = harness();

    bus.publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(
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
});
