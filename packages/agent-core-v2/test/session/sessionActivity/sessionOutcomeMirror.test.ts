import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  _clearScopedRegistryForTests,
  ScopeActivation,
  registerScopedService,
  type IAgentScopeHandle,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { Emitter, Event } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import { AgentActivityUpdated } from '#/agent/activityView/activityView';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, turnKey, type TurnModelState } from '#/agent/loop/turnOps';
import { ContextUndone } from '#/agent/undo/undoService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
  type AgentScopeCreatedEvent,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionOutcomeMirror } from '#/session/sessionActivity/sessionOutcomeMirror';
import { SessionOutcomeMirror } from '#/session/sessionActivity/sessionOutcomeMirrorService';
import { stubAgentContext } from '../../agent/agentContext/stubs';

class FakeBus {
  private readonly handlers = new Map<string, Array<(e: Event2) => void>>();

  publish(event: Event2): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }

  subscribe(typeOrClass: unknown, handler?: unknown) {
    const type =
      typeof typeOrClass === 'string' ? typeOrClass : (typeOrClass as Event2Class).type;
    const list = this.handlers.get(type) ?? [];
    const fn = handler as (e: Event2) => void;
    list.push(fn);
    this.handlers.set(type, list);
    return { dispose: () => this.handlers.set(type, list.filter((h) => h !== fn)) };
  }
}

class FakeAgentLifecycle implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  readonly bus = new FakeBus();
  readonly restoreHooks: Array<(ctx: undefined, next: () => Promise<void>) => Promise<void>> = [];
  lastEnded: TurnModelState['lastEnded'];
  private readonly context: AgentContext = stubAgentContext(MAIN_AGENT_ID, 1);
  private readonly createEmitter = new Emitter<AgentContext>();
  private readonly willCloseEmitter = new Emitter<AgentContext>();
  private readonly didCloseEmitter = new Emitter<AgentContext>();
  readonly onDidCreate = this.createEmitter.event;
  readonly onDidCreateScope = Event.None as Event<AgentScopeCreatedEvent>;
  readonly onWillClose = this.willCloseEmitter.event;
  readonly onDidClose = this.didCloseEmitter.event;
  private mainPresent = false;
  private readonly dispatcher = {
    hooks: {
      onDidRestore: {
        register: (_id: string, fn: (ctx: undefined, next: () => Promise<void>) => Promise<void>) => {
          this.restoreHooks.push(fn);
          return { dispose: () => {} };
        },
      },
    },
  };
  private readonly agentStates = {
    has: (key: unknown) => key === turnKey,
    get: (key: unknown) =>
      key === turnKey
        ? { nextTurnId: 1, cancelledTurnIds: [], anchorTurnIds: [], lastEnded: this.lastEnded }
        : undefined,
  };

  private readonly mainHandle = {
    id: MAIN_AGENT_ID,
    accessor: {
      get: (token: unknown) =>
        token === IEventBus
          ? this.bus
          : token === IEventDispatcher
            ? this.dispatcher
            : token === IAgentStateService
              ? this.agentStates
              : undefined,
    },
  } as unknown as IAgentScopeHandle;

  get(agentId: string): AgentContext | undefined {
    return agentId === MAIN_AGENT_ID && this.mainPresent ? this.context : undefined;
  }

  handleOf(agentId: string): IAgentScopeHandle | undefined {
    return agentId === MAIN_AGENT_ID && this.mainPresent ? this.mainHandle : undefined;
  }

  list(): readonly AgentContext[] {
    return this.mainPresent ? [this.context] : [];
  }

  addMain(): void {
    this.mainPresent = true;
    this.createEmitter.fire(this.context);
  }

  removeMain(): void {
    this.mainPresent = false;
    this.willCloseEmitter.fire(this.context);
    this.didCloseEmitter.fire(this.context);
  }

  create(): Promise<AgentContext> {
    throw new Error('not implemented');
  }
  fork(): Promise<AgentContext> {
    throw new Error('not implemented');
  }
  resolve(): never {
    throw new Error('not implemented');
  }
  inspect(): never {
    throw new Error('not implemented');
  }
  remove(): Promise<void> {
    throw new Error('not implemented');
  }
  broadcastPermissionMode(): void {
    throw new Error('not implemented');
  }
  adopt(): AgentContext {
    throw new Error('not implemented');
  }
  attachRuntimes(): void {
    throw new Error('not implemented');
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SessionOutcomeMirror (Session scope)', () => {
  let disposables: DisposableStore;
  let host: ScopedTestHost;
  let session: Scope;
  let lifecycle: FakeAgentLifecycle;
  let writes: (SessionMeta['lastTurnReason'])[];
  let touches: boolean[];
  let failNextWrite: boolean;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Session, IAgentLifecycleService, FakeAgentLifecycle, ScopeActivation.OnDemand, 'agentLifecycle');
    registerScopedService(LifecycleScope.Session, ISessionOutcomeMirror, SessionOutcomeMirror, ScopeActivation.OnScopeCreated, 'sessionActivity');

    writes = [];
    touches = [];
    failNextWrite = false;
    const metadata = {
      read: async () => ({ lastTurnReason: writes.at(-1) }) as SessionMeta,
      update: async (
        patch: { lastTurnReason?: SessionMeta['lastTurnReason'] },
        uopts?: { touchUpdatedAt?: boolean },
      ) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('write failed');
        }
        writes.push(patch.lastTurnReason);
        touches.push(uopts?.touchUpdatedAt !== false);
      },
    };

    disposables = new DisposableStore();
    host = createScopedTestHost();
    session = host.child(LifecycleScope.Session, 'session-a', [
      stubPair(ISessionMetadata, metadata as unknown as ISessionMetadata),
    ]);
    lifecycle = session.accessor.get(IAgentLifecycleService) as unknown as FakeAgentLifecycle;
    session.accessor.get(ISessionOutcomeMirror);
  });

  afterEach(() => {
    disposables.dispose();
    host.dispose();
  });

  const started = (turnId = 1) =>
    lifecycle.bus.publish(new TurnStarted({ agentId: 'main', turnId, origin: { kind: 'user' } }));
  const ended = (reason: TurnEnded['reason'], interruptReason?: TurnEnded['interruptReason'], turnId = 1) =>
    lifecycle.bus.publish(new TurnEnded({ agentId: 'main', turnId, reason, interruptReason }));
  const activityBackfill = (turnId: number, reason: TurnEnded['reason']) =>
    lifecycle.bus.publish(
      new AgentActivityUpdated({ agentId: 'main',
        lifecycle: 'ready',
        background: [],
        lastTurn: { turnId, reason, at: 0 },
      }),
    );

  it('persists completed/failed/user-cancelled, never programmatic aborts', async () => {
    lifecycle.addMain();
    await tick();
    ended('completed');
    ended('failed');
    ended('blocked');
    ended('cancelled', 'user_cancelled');
    ended('cancelled', 'aborted');
    expect(writes).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('clears the stored outcome when a new turn starts', async () => {
    lifecycle.addMain();
    await tick();
    ended('failed');
    expect(writes).toEqual(['failed']);
    started();
    expect(writes).toEqual(['failed', undefined]);
    started();
    expect(writes).toEqual(['failed', undefined]);
  });

  it('retries the write when a persist fails', async () => {
    lifecycle.addMain();
    await tick();
    failNextWrite = true;
    ended('failed');
    await tick();
    ended('failed');
    expect(writes).toEqual(['failed']);
  });

  it('dedupes against the durable value adopted at startup', async () => {
    lifecycle.addMain();
    await tick();
    ended('failed');
    expect(writes).toEqual(['failed']);
    const second = host.child(LifecycleScope.Session, 'session-b', [
      stubPair(ISessionMetadata, {
        read: async () => ({ lastTurnReason: 'failed' }) as SessionMeta,
        update: async (patch: { lastTurnReason?: SessionMeta['lastTurnReason'] }) => {
          writes.push(patch.lastTurnReason);
        },
      } as unknown as ISessionMetadata),
    ]);
    const secondLifecycle = second.accessor.get(IAgentLifecycleService) as unknown as FakeAgentLifecycle;
    second.accessor.get(ISessionOutcomeMirror);
    secondLifecycle.addMain();
    await tick();
    secondLifecycle.bus.publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'failed' }));
    expect(writes).toEqual(['failed']);
    secondLifecycle.bus.publish(new TurnEnded({ agentId: 'main', turnId: 2, reason: 'completed' }));
    expect(writes).toEqual(['failed', 'completed']);
  });

  it('a live turn ending writes with the recency bump, never the backfill channel', async () => {
    lifecycle.addMain();
    await tick();
    started();
    ended('completed');
    activityBackfill(1, 'completed');
    expect(writes).toEqual(['completed']);
    expect(touches).toEqual([true]);
  });

  it('backfills a restored outcome that never got a turn.ended fact', async () => {
    lifecycle.addMain();
    await tick();
    activityBackfill(3, 'failed');
    expect(writes).toEqual(['failed']);
    ended('failed');
    expect(writes).toEqual(['failed']);
  });

  it('backfills a restored cancellation without touching recency', async () => {
    lifecycle.addMain();
    await tick();
    activityBackfill(4, 'cancelled');
    expect(writes).toEqual(['cancelled']);
    expect(touches).toEqual([false]);
  });

  it('does not backfill over a newer persisted outcome', async () => {
    lifecycle.addMain();
    await tick();
    ended('completed');
    activityBackfill(9, 'failed');
    expect(writes).toEqual(['completed']);
  });

  it('clears the persisted outcome when an undo rewinds the turn', async () => {
    lifecycle.addMain();
    await tick();
    ended('cancelled', 'user_cancelled');
    expect(writes).toEqual(['cancelled']);
    lifecycle.bus.publish(new ContextUndone({ agentId: 'main', turns: 1, fromTurnId: 1 }));
    expect(writes).toEqual(['cancelled', undefined]);
  });

  it('an undo with no stored outcome writes nothing', async () => {
    lifecycle.addMain();
    await tick();
    lifecycle.bus.publish(new ContextUndone({ agentId: 'main', turns: 1 }));
    expect(writes).toEqual([]);
  });

  it('keeps the persisted outcome when an undo rewinds only a later turn', async () => {
    lifecycle.addMain();
    await tick();
    ended('cancelled', 'user_cancelled', 1);
    expect(writes).toEqual(['cancelled']);
    lifecycle.bus.publish(new ContextUndone({ agentId: 'main', turns: 1, fromTurnId: 2 }));
    expect(writes).toEqual(['cancelled']);
  });

  it('tracks the narrated turn across equal outcomes for the undo range check', async () => {
    lifecycle.addMain();
    await tick();
    ended('completed', undefined, 1);
    ended('completed', undefined, 2);
    expect(writes).toEqual(['completed']);
    lifecycle.bus.publish(new ContextUndone({ agentId: 'main', turns: 1, fromTurnId: 2 }));
    expect(writes).toEqual(['completed', undefined]);
  });

  it('clears a stale persisted outcome when the replayed wire has no ended turn', async () => {
    const stale = host.child(LifecycleScope.Session, 'session-stale', [
      stubPair(ISessionMetadata, {
        read: async () => ({ lastTurnReason: 'cancelled' }) as SessionMeta,
        update: async (
          patch: { lastTurnReason?: SessionMeta['lastTurnReason'] },
          uopts?: { touchUpdatedAt?: boolean },
        ) => {
          writes.push(patch.lastTurnReason);
          touches.push(uopts?.touchUpdatedAt !== false);
        },
      } as unknown as ISessionMetadata),
    ]);
    const staleLifecycle = stale.accessor.get(IAgentLifecycleService) as unknown as FakeAgentLifecycle;
    stale.accessor.get(ISessionOutcomeMirror);
    staleLifecycle.addMain();
    await tick();
    expect(writes).toEqual([]);
    for (const hook of staleLifecycle.restoreHooks) await hook(undefined, async () => {});
    expect(writes).toEqual([undefined]);
    expect(touches).toEqual([false]);
  });

  it('keeps the adopted outcome when the replayed wire still has its ended turn', async () => {
    const fresh = host.child(LifecycleScope.Session, 'session-fresh', [
      stubPair(ISessionMetadata, {
        read: async () => ({ lastTurnReason: 'cancelled' }) as SessionMeta,
        update: async (patch: { lastTurnReason?: SessionMeta['lastTurnReason'] }) => {
          writes.push(patch.lastTurnReason);
        },
      } as unknown as ISessionMetadata),
    ]);
    const freshLifecycle = fresh.accessor.get(IAgentLifecycleService) as unknown as FakeAgentLifecycle;
    fresh.accessor.get(ISessionOutcomeMirror);
    freshLifecycle.addMain();
    freshLifecycle.lastEnded = { turnId: 3, reason: 'cancelled', durationMs: 5 };
    await tick();
    for (const hook of freshLifecycle.restoreHooks) await hook(undefined, async () => {});
    expect(writes).toEqual([]);
  });

  it('reattaches when the main agent is disposed and recreated', async () => {
    lifecycle.addMain();
    await tick();
    ended('failed');
    expect(writes).toEqual(['failed']);
    lifecycle.removeMain();
    lifecycle.addMain();
    ended('completed');
    expect(writes).toEqual(['failed', 'completed']);
  });
});
