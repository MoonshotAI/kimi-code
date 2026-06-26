import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { ISessionActivity } from '#/session-activity/sessionActivity';
import { SessionActivity } from '#/session-activity/sessionActivityService';
import { ITurnService, type Turn } from '#/turn';
import { stubTurn } from '../turn/stubs';

function makeTurn(id: number): Turn {
  return {
    id,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

function makeTurnService(active: boolean): ITurnService {
  const base = stubTurn();
  const activeTurn = active ? makeTurn(1) : undefined;
  return {
    ...base,
    getActiveTurn: () => activeTurn,
  };
}

function makeAccessor(turn: ITurnService): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      if (id === (ITurnService as unknown as ServiceIdentifier<T>)) {
        return turn as unknown as T;
      }
      throw new Error(`unexpected service request: ${String(id)}`);
    },
  };
}

function handle(id: string, active: boolean): IScopeHandle {
  const turn = makeTurnService(active);
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: makeAccessor(turn),
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
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionActivity, new SyncDescriptor(SessionActivity));
  });
  afterEach(() => disposables.dispose());

  it('idle when no agents', () => {
    ix.stub(IAgentLifecycleService, lifecycle([]));
    expect(ix.get(ISessionActivity).isIdle()).toBe(true);
  });

  it('idle when all agents idle', () => {
    ix.stub(IAgentLifecycleService, lifecycle([handle('a', false)]));
    expect(ix.get(ISessionActivity).isIdle()).toBe(true);
  });

  it('not idle when any agent has an active turn', () => {
    ix.stub(
      IAgentLifecycleService,
      lifecycle([handle('a', false), handle('b', true)]),
    );
    expect(ix.get(ISessionActivity).isIdle()).toBe(false);
  });
});
