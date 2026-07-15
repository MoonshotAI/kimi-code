/**
 * `AgentActivityView` — the folded read model: turn slice, lastTurn memory,
 * and the background-task busy layer (seeded from the task registry, folded
 * from `task.started` / `task.terminated`).
 */

import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { DomainEvent, IEventBus } from '#/app/event/eventBus';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/types';
import { AgentActivityView } from '#/agent/activityView/activityViewService';
import type { AgentActivityState } from '#/agent/activityView/activityView';

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

function harness(seedTasks: readonly AgentTaskInfo[] = []) {
  const bus = new FakeBus();
  const loop = {
    status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
  } as unknown as IAgentLoopService;
  const tasks = { list: () => seedTasks } as unknown as IAgentTaskService;
  const view = new AgentActivityView(bus as unknown as IEventBus, loop, tasks);
  const updates = (): AgentActivityState[] =>
    bus.published
      .filter((e) => e.type === 'agent.activity.updated')
      .map((e) => e as unknown as AgentActivityState);
  return { bus, view, updates };
}

describe('AgentActivityView', () => {
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

  it('folds turn boundaries into turn / lastTurn', () => {
    const { bus, view } = harness();

    bus.publish({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });
    expect(view.state().turn?.turnId).toBe(1);

    bus.publish({ type: 'turn.ended', turnId: 1, reason: 'completed' });
    expect(view.state().turn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });
});
