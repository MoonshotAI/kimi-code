import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService, type Interaction, type InteractionKind } from '#/session/interaction/interaction';
import { ISessionActivity } from '#/session/sessionActivity/sessionActivity';
import { SessionActivity } from '#/session/sessionActivity/sessionActivityService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { stubLoopWithHooks } from '../../agent/loop/stubs';

function makeTurnService(active: boolean): IAgentLoopService {
  const base = stubLoopWithHooks({ hasActiveTurn: active });
  if (active) base.startTurn();
  return base;
}

function makeAccessor(turn: IAgentLoopService): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      if (id === (IAgentLoopService as unknown as ServiceIdentifier<T>)) {
        return turn as unknown as T;
      }
      throw new Error(`unexpected service request: ${String(id)}`);
    },
  };
}

function handle(id: string, active: boolean): IAgentScopeHandle {
  const turn = makeTurnService(active);
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: makeAccessor(turn),
    dispose: () => {},
  };
}

function lifecycle(handles: readonly IAgentScopeHandle[]): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    onDidCreateMain: () => ({ dispose: () => {} }),
    notifyMainCreated: () => {},
    notifyAgentTaskStopped: () => {},
    create: () => Promise.resolve(handles[0]!),
    ensureMcpReady: () => Promise.resolve(),
    fork: () => Promise.resolve(handles[0]!),
    run: () => {
      throw new Error('not implemented in test');
    },
    getHandle: () => undefined,
    whenReady: () => Promise.resolve(undefined),
    list: () => handles,
    remove: () => Promise.resolve(),
  };
}

function interactions(
  pending: { approval?: number; question?: number },
): Partial<ISessionInteractionService> {
  const items: Interaction[] = [];
  for (let i = 0; i < (pending.approval ?? 0); i++) {
    items.push({ id: `a${i}`, kind: 'approval', payload: {}, origin: {}, createdAt: 0 });
  }
  for (let i = 0; i < (pending.question ?? 0); i++) {
    items.push({ id: `q${i}`, kind: 'question', payload: {}, origin: {}, createdAt: 0 });
  }
  return {
    listPending: (kind?: InteractionKind) =>
      kind === undefined ? items : items.filter((i) => i.kind === kind),
  };
}

describe('SessionActivity', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionActivity, new SyncDescriptor(SessionActivity));
    ix.stub(ISessionInteractionService, interactions({}));
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

  describe('status', () => {
    it('idle when nothing is pending and no turn is active', () => {
      ix.stub(IAgentLifecycleService, lifecycle([handle('a', false)]));
      expect(ix.get(ISessionActivity).status()).toBe('idle');
    });

    it('running when an agent has an active turn', () => {
      ix.stub(IAgentLifecycleService, lifecycle([handle('a', true)]));
      expect(ix.get(ISessionActivity).status()).toBe('running');
    });

    it('awaiting_approval when an approval interaction is pending', () => {
      ix.stub(IAgentLifecycleService, lifecycle([handle('a', false)]));
      ix.stub(ISessionInteractionService, interactions({ approval: 1 }));
      expect(ix.get(ISessionActivity).status()).toBe('awaiting_approval');
    });

    it('awaiting_question when a question interaction is pending', () => {
      ix.stub(IAgentLifecycleService, lifecycle([handle('a', false)]));
      ix.stub(ISessionInteractionService, interactions({ question: 1 }));
      expect(ix.get(ISessionActivity).status()).toBe('awaiting_question');
    });

    it('approval takes priority over question', () => {
      ix.stub(IAgentLifecycleService, lifecycle([handle('a', false)]));
      ix.stub(ISessionInteractionService, interactions({ approval: 1, question: 1 }));
      expect(ix.get(ISessionActivity).status()).toBe('awaiting_approval');
    });

    it('question takes priority over running', () => {
      ix.stub(IAgentLifecycleService, lifecycle([handle('a', true)]));
      ix.stub(ISessionInteractionService, interactions({ question: 1 }));
      expect(ix.get(ISessionActivity).status()).toBe('awaiting_question');
    });
  });
});
