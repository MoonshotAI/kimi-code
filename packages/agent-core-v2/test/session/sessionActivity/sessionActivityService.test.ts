import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
  type IAgentScopeHandle,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IAgentActivityView, type AgentActivityState } from '#/agent/activityView/activityView';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import {
  ISessionActivityView,
  type SessionActivityChangedEvent,
} from '#/session/sessionActivity/sessionActivity';
import { SessionActivityView } from '#/session/sessionActivity/sessionActivityService';

class FakeBus implements IEventBus {
  declare readonly _serviceBrand: undefined;
  private readonly handlers = new Set<{ type?: string; fn: (event: DomainEvent) => void }>();

  publish(event: DomainEvent): void {
    for (const h of [...this.handlers]) {
      if (h.type === undefined || h.type === event.type) h.fn(event);
    }
  }

  subscribe(arg1: unknown, arg2?: unknown): IDisposable {
    const entry =
      typeof arg1 === 'string'
        ? { type: arg1, fn: arg2 as (event: DomainEvent) => void }
        : { fn: arg1 as (event: DomainEvent) => void };
    this.handlers.add(entry);
    return { dispose: () => this.handlers.delete(entry) };
  }
}

class FakeAgentHandle {
  readonly kind = LifecycleScope.Agent;
  readonly bus = new FakeBus();
  activity: AgentActivityState = { lifecycle: 'ready', background: [] };
  private readonly view = { state: () => this.activity };
  readonly accessor;

  constructor(readonly id: string) {
    this.accessor = {
      get: (token: unknown) => {
        if (token === IEventBus) return this.bus;
        if (token === IAgentActivityView) return this.view;
        return undefined;
      },
    };
  }

  emitActivity(): void {
    this.bus.publish({ type: 'agent.activity.updated', ...this.activity } as DomainEvent);
  }

  dispose(): void {}
}

class FakeAgentLifecycle implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly createEmitter = new Emitter<IAgentScopeHandle>();
  private readonly disposeEmitter = new Emitter<string>();
  readonly onDidCreate = this.createEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;
  readonly handles: FakeAgentHandle[] = [];

  list(): readonly IAgentScopeHandle[] {
    return this.handles as unknown as IAgentScopeHandle[];
  }

  get(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.find((h) => h.id === agentId) as unknown as IAgentScopeHandle | undefined;
  }

  addAgent(id: string): FakeAgentHandle {
    const handle = new FakeAgentHandle(id);
    this.handles.push(handle);
    this.createEmitter.fire(handle as unknown as IAgentScopeHandle);
    return handle;
  }

  removeAgent(id: string): void {
    const index = this.handles.findIndex((h) => h.id === id);
    if (index >= 0) this.handles.splice(index, 1);
    this.disposeEmitter.fire(id);
  }

  create(): Promise<IAgentScopeHandle> {
    throw new Error('not implemented');
  }
  fork(): Promise<IAgentScopeHandle> {
    throw new Error('not implemented');
  }
  remove(): Promise<void> {
    throw new Error('not implemented');
  }
  broadcastPermissionMode(): void {
    throw new Error('not implemented');
  }
}

function turnActive(turnId: number, phase: 'running' | 'streaming' = 'running'): AgentActivityState {
  return {
    lifecycle: 'ready',
    turn: {
      turnId,
      origin: { kind: 'user' },
      phase,
      step: 0,
      ending: false,
      pendingApprovals: [],
      activeToolCalls: [],
      since: 0,
    },
    background: [],
  };
}

function turnEnded(turnId: number, reason: string): AgentActivityState {
  return {
    lifecycle: 'ready',
    lastTurn: { turnId, reason, at: 0 },
    background: [],
  } as AgentActivityState;
}

describe('ISessionActivityView (Session scope aggregate of agent activity + interactions)', () => {
  let disposables: DisposableStore;
  let host: ScopedTestHost;
  let session: Scope;
  let lifecycle: FakeAgentLifecycle;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, ISessionInteractionService, SessionInteractionService, InstantiationType.Delayed, 'interaction');
    registerScopedService(LifecycleScope.Session, IAgentLifecycleService, FakeAgentLifecycle, InstantiationType.Delayed, 'agentLifecycle');
    registerScopedService(LifecycleScope.Session, ISessionActivityView, SessionActivityView, InstantiationType.Delayed, 'sessionActivity');

    disposables = new DisposableStore();
    host = createScopedTestHost();
    session = host.child(LifecycleScope.Session, 'session-a');
    lifecycle = session.accessor.get(IAgentLifecycleService) as unknown as FakeAgentLifecycle;
  });

  afterEach(() => {
    disposables.dispose();
    host.dispose();
  });

  function viewWithChanges(): {
    view: ISessionActivityView;
    changes: SessionActivityChangedEvent[];
  } {
    const changes: SessionActivityChangedEvent[] = [];
    const view = session.accessor.get(ISessionActivityView);
    // The SUT is Delayed: event subscriptions alone do not construct it.
    // Force construction so the fold is live before the test drives events.
    view.state();
    disposables.add(view.onDidChange((change) => changes.push(change)));
    return { view, changes };
  }

  it('starts idle when no agent has work', () => {
    lifecycle.addAgent(MAIN_AGENT_ID);
    const { view } = viewWithChanges();
    expect(view.state()).toEqual({
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      lastTurnReason: undefined,
    });
  });

  it('seeds the aggregate from agents already active at construction', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    main.activity = turnActive(1);
    const { view } = viewWithChanges();
    expect(view.state().busy).toBe(true);
    expect(view.state().mainTurnActive).toBe(true);
  });

  it('fires turn_started when the main agent begins a turn', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.activity = turnActive(1);
    main.emitActivity();

    expect(changes).toEqual([
      {
        state: { busy: true, mainTurnActive: true, pendingInteraction: 'none', lastTurnReason: undefined },
        cause: 'turn_started',
      },
    ]);
  });

  it('fires turn_ended with the mapped outcome when the main agent ends a turn', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.activity = turnActive(1);
    main.emitActivity();
    main.activity = turnEnded(1, 'completed');
    main.emitActivity();

    expect(changes.at(-1)).toEqual({
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'completed' },
      cause: 'turn_ended',
    });
  });

  it('maps non-completed non-cancelled outcomes to failed', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.activity = turnActive(1);
    main.emitActivity();
    main.activity = turnEnded(1, 'blocked');
    main.emitActivity();

    expect(changes.at(-1)?.state.lastTurnReason).toBe('failed');
  });

  it('tracks subagent turns in busy without touching the main-agent slices', () => {
    const sub = lifecycle.addAgent('agent-0');
    const { view, changes } = viewWithChanges();

    sub.activity = turnActive(1);
    sub.emitActivity();

    expect(view.state().busy).toBe(true);
    expect(view.state().mainTurnActive).toBe(false);
    expect(view.state().lastTurnReason).toBeUndefined();

    sub.activity = turnEnded(1, 'completed');
    sub.emitActivity();

    expect(changes).toHaveLength(2);
    expect(view.state().busy).toBe(false);
    expect(view.state().lastTurnReason).toBeUndefined();
  });

  it('fires background when live background work changes without a turn', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.activity = {
      lifecycle: 'ready',
      background: [{ kind: 'task', id: 't1', since: 0 }],
    };
    main.emitActivity();

    expect(changes).toEqual([
      {
        state: { busy: true, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: undefined },
        cause: 'background',
      },
    ]);
  });

  it('does not fire when the aggregate is unchanged (phase churn inside a turn)', () => {
    const main = lifecycle.addAgent(MAIN_AGENT_ID);
    const { changes } = viewWithChanges();

    main.activity = turnActive(1);
    main.emitActivity();
    main.activity = turnActive(1, 'streaming');
    main.emitActivity();

    expect(changes).toHaveLength(1);
  });

  it('fires interaction when the pending set flips the session slice', () => {
    lifecycle.addAgent(MAIN_AGENT_ID);
    const interactions = session.accessor.get(ISessionInteractionService);
    const { changes } = viewWithChanges();

    interactions.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: MAIN_AGENT_ID } });
    expect(changes.at(-1)).toEqual({
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'approval', lastTurnReason: undefined },
      cause: 'interaction',
    });

    // A question joining an already-pending approval does not change the slice.
    interactions.enqueue({ id: 'q1', kind: 'question', payload: {}, origin: { agentId: MAIN_AGENT_ID } });
    expect(changes).toHaveLength(1);

    interactions.respond('a1', { approved: true });
    expect(changes.at(-1)?.state.pendingInteraction).toBe('question');
  });

  it('treats user_tool pending as none', () => {
    lifecycle.addAgent(MAIN_AGENT_ID);
    const interactions = session.accessor.get(ISessionInteractionService);
    const { changes } = viewWithChanges();

    interactions.enqueue({ id: 'u1', kind: 'user_tool', payload: {}, origin: { agentId: MAIN_AGENT_ID } });
    expect(changes).toHaveLength(0);
  });

  it('drops a disposed agent from the aggregate with agent_lifecycle cause', () => {
    const sub = lifecycle.addAgent('agent-0');
    const { view, changes } = viewWithChanges();

    sub.activity = turnActive(1);
    sub.emitActivity();
    expect(view.state().busy).toBe(true);

    lifecycle.removeAgent('agent-0');
    expect(changes.at(-1)).toEqual({
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: undefined },
      cause: 'agent_lifecycle',
    });
  });

  it('seeds agents created after construction through onDidCreate', () => {
    const { view, changes } = viewWithChanges();

    const sub = lifecycle.addAgent('agent-0');
    sub.activity = turnActive(1);
    sub.emitActivity();

    expect(view.state().busy).toBe(true);
    expect(changes.at(-1)?.cause).toBe('turn_started');
  });
});
