import { describe, expect, it } from 'vitest';

import type { Event } from '#/_base/event';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';
import type { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import type {
  ITurnService,
  TurnEndEvent,
  TurnStartEvent,
  TurnStepEvent,
  TurnToolEvent,
} from '#/turn/turn';

import { SessionActivity } from '#/session-activity/sessionActivityService';

const noneEvent = (<T>(): Event<T> => () => ({ dispose: () => {} }))();

function stubTurn(active: boolean): ITurnService {
  return {
    _serviceBrand: undefined,
    onWillStartTurn: noneEvent as Event<TurnStartEvent>,
    onWillExecuteTool: noneEvent as Event<TurnToolEvent>,
    onDidFinalizeTool: noneEvent as Event<TurnToolEvent>,
    onDidEndStep: noneEvent as Event<TurnStepEvent>,
    onDidEndTurn: noneEvent as Event<TurnEndEvent>,
    get hasActiveTurn() {
      return active;
    },
    get currentId() {
      return active ? 't' : undefined;
    },
    prompt: () => Promise.resolve(),
    steer: () => {},
    retry: () => Promise.resolve(),
    cancel: () => {},
  };
}

function lifecycle(handles: readonly IScopeHandle[]): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    create: () => Promise.resolve(handles[0]!),
    createMain: () => Promise.resolve(handles[0]!),
    getHandle: () => undefined,
    list: () => handles,
    remove: () => Promise.resolve(),
  };
}

describe('SessionActivity', () => {
  it('idle when no agents', () => {
    const a = new SessionActivity(lifecycle([]));
    expect(a.isIdle()).toBe(true);
  });

  it('idle when all agents idle', () => {
    const h: IScopeHandle = { id: 'a', kind: 2, accessor: { get: () => stubTurn(false) } as ServicesAccessor };
    expect(new SessionActivity(lifecycle([h])).isIdle()).toBe(true);
  });

  it('not idle when any agent has an active turn', () => {
    const idle: IScopeHandle = { id: 'a', kind: 2, accessor: { get: () => stubTurn(false) } as ServicesAccessor };
    const busy: IScopeHandle = { id: 'b', kind: 2, accessor: { get: () => stubTurn(true) } as ServicesAccessor };
    expect(new SessionActivity(lifecycle([idle, busy])).isIdle()).toBe(false);
  });
});
