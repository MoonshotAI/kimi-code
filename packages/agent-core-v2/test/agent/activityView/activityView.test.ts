/**
 * `AgentActivityView` — the folded read model: turn slice, lastTurn memory,
 * and the background-work busy layer (seeded from task and compaction owners,
 * folded from their lifecycle events).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/types';
import { AgentActivityView } from '#/agent/activityView/activityViewService';
import { IAgentActivityView, type AgentActivityState } from '#/agent/activityView/activityView';
import {
  IAgentFullCompactionService,
  type FullCompactionTask,
} from '#/agent/fullCompaction/fullCompaction';

class FakeBus {
  private readonly byType = new Map<string, Array<(e: DomainEvent) => void>>();
  private readonly all: Array<(e: DomainEvent) => void> = [];
  readonly published: DomainEvent[] = [];

  publish(event: DomainEvent): void {
    this.published.push(event);
    for (const h of this.all) h(event);
    for (const h of this.byType.get(event.type) ?? []) h(event);
  }

  subscribe(type: unknown, handler?: unknown): IDisposable {
    if (typeof type === 'function') {
      this.all.push(type as (e: DomainEvent) => void);
      return { dispose: () => {} };
    }
    const list = this.byType.get(type as string) ?? [];
    list.push(handler as (e: DomainEvent) => void);
    this.byType.set(type as string, list);
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
) {
  const bus = new FakeBus();
  const loop = {
    status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
  } as unknown as IAgentLoopService;
  const tasks = { list: () => seedTasks } as unknown as IAgentTaskService;
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IEventBus, bus as unknown as IEventBus);
  ix.stub(IAgentLoopService, loop);
  ix.stub(IAgentTaskService, tasks);
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
  return { bus, view, updates };
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

    bus.publish({ type: 'task.started', info: makeTaskInfo('bash-1') });
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-1', since: 100 }]);
    expect(updates().at(-1)?.background).toHaveLength(1);

    bus.publish({ type: 'task.terminated', info: makeTaskInfo('bash-1') });
    expect(view.state().background).toEqual([]);
    expect(updates().at(-1)?.background).toHaveLength(0);
  });

  it('seeds the background slice from the task registry on creation', () => {
    const { view } = harness([makeTaskInfo('bash-9')]);
    expect(view.state().background).toEqual([{ kind: 'process', id: 'bash-9', since: 100 }]);
  });

  it('folds full compaction into the background slice', () => {
    const { bus, view } = harness();

    bus.publish({ type: 'compaction.started', trigger: 'manual' });
    expect(view.state().background).toEqual([
      expect.objectContaining({ kind: 'compaction', id: 'full-compaction' }),
    ]);

    bus.publish({ type: 'compaction.cancelled' });
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

    bus.publish({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });
    expect(view.state().turn?.turnId).toBe(1);

    bus.publish({ type: 'turn.ended', turnId: 1, reason: 'completed' });
    expect(view.state().turn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the previous outcome when a new turn starts', () => {
    const { bus, view } = harness();

    bus.publish({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });
    bus.publish({ type: 'turn.ended', turnId: 1, reason: 'cancelled' });
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'cancelled' });

    // While the next turn runs there is no current outcome; turn.ended
    // publishes the fresh one.
    bus.publish({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } });
    expect(view.state().lastTurn).toBeUndefined();

    bus.publish({ type: 'turn.ended', turnId: 2, reason: 'completed' });
    expect(view.state().lastTurn).toMatchObject({ turnId: 2, reason: 'completed' });
  });
});
