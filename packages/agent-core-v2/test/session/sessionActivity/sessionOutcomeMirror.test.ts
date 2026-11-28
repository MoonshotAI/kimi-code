import { CLOSED, STEERED, type LoopEmitted, type TurnOutcome } from '@moonshot-ai/core/loop/index';
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
import { abortError, userCancellationReason } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { CoreLoopEvent } from '#/agent/loop/coreLoopEvent';
import { turnKey, type TurnModelState } from '#/agent/loop/turnOps';
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
  remove(): Promise<void> {
    throw new Error('not implemented');
  }
  broadcastPermissionMode(): void {
    throw new Error('not implemented');
  }
  adopt(): AgentContext {
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

  const emit = (event: LoopEmitted, target = lifecycle) =>
    target.bus.publish(new CoreLoopEvent({ agentId: 'main', event }));
  const started = (turnId = 1, target = lifecycle) =>
    emit({ type: 'step.started', turnId, step: 1, stepId: `step-${turnId}-1` }, target);
  const ended = (outcome: TurnOutcome, turnId = 1, target = lifecycle) =>
    emit({ type: 'turn.ended', turnId, outcome }, target);

  it('persists completed/failed/user-cancelled, never programmatic aborts', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'done' }, 1);
    started(2);
    ended({ type: 'failed', error: new Error('boom') }, 2);
    started(3);
    ended({ type: 'blocked', at: 'step.starting', cause: { by: 'step', reason: 'blocked' } }, 3);
    started(4);
    ended({ type: 'aborted', reason: userCancellationReason() }, 4);
    started(5);
    ended({ type: 'aborted', reason: abortError('parent aborted') }, 5);
    started(6);
    ended({ type: 'aborted', reason: CLOSED }, 6);
    started(7);
    ended({ type: 'aborted' }, 7);
    expect(writes).toEqual([
      'completed',
      undefined,
      'failed',
      undefined,
      'failed',
      undefined,
      'cancelled',
      undefined,
    ]);
  });

  it('persists steered and promptOnly turns as completed', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'done', cause: STEERED }, 1);
    emit({ type: 'turn.started', turnId: 2, trigger: 'notify', promptOnly: true });
    ended({ type: 'done', cause: { by: 'loop', reason: 'prompt_only' } }, 2);
    expect(writes).toEqual(['completed', undefined, 'completed']);
  });

  it('ignores gate-blocked pseudo-turns without clearing the stored outcome', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'done' }, 1);
    emit({ type: 'turn.started', turnId: 2, trigger: 'normal' });
    ended({ type: 'blocked', at: 'turn.starting', cause: { by: 'prompt', reason: 'blocked' } }, 2);
    expect(writes).toEqual(['completed']);
  });

  it('clears the stored outcome when a new turn starts', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'failed', error: new Error('boom') }, 1);
    expect(writes).toEqual(['failed']);
    started(2);
    expect(writes).toEqual(['failed', undefined]);
    started(2);
    expect(writes).toEqual(['failed', undefined]);
  });

  it('retries the write when a persist fails', async () => {
    lifecycle.addMain();
    await tick();
    failNextWrite = true;
    started(1);
    ended({ type: 'failed', error: new Error('boom') }, 1);
    await tick();
    started(2);
    ended({ type: 'failed', error: new Error('boom') }, 2);
    expect(writes).toEqual(['failed']);
  });

  it('dedupes against the durable value adopted at startup', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'failed', error: new Error('boom') }, 1);
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
    secondLifecycle.lastEnded = { turnId: 1, reason: 'failed' };
    secondLifecycle.addMain();
    await tick();
    for (const hook of secondLifecycle.restoreHooks) await hook(undefined, async () => {});
    expect(writes).toEqual(['failed']);
    started(2, secondLifecycle);
    ended({ type: 'done' }, 2, secondLifecycle);
    expect(writes).toEqual(['failed', undefined, 'completed']);
  });

  it('a live turn ending writes with the recency bump, never the backfill channel', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'done' }, 1);
    lifecycle.lastEnded = { turnId: 1, reason: 'completed' };
    lifecycle.removeMain();
    lifecycle.addMain();
    await tick();
    expect(writes).toEqual(['completed']);
    expect(touches).toEqual([true]);
  });

  it('backfills a restored outcome that never got a turn.ended fact', async () => {
    lifecycle.lastEnded = { turnId: 3, reason: 'failed' };
    lifecycle.addMain();
    await tick();
    expect(writes).toEqual(['failed']);
    expect(touches).toEqual([false]);
    emit({ type: 'turn.started', turnId: 4, trigger: 'normal' });
    ended({ type: 'blocked', at: 'turn.starting', cause: { by: 'prompt', reason: 'blocked' } }, 4);
    expect(writes).toEqual(['failed']);
  });

  it('backfills a restored cancellation without touching recency', async () => {
    lifecycle.lastEnded = { turnId: 4, reason: 'cancelled' };
    lifecycle.addMain();
    await tick();
    expect(writes).toEqual(['cancelled']);
    expect(touches).toEqual([false]);
  });

  it('does not backfill over a newer persisted outcome', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'done' }, 1);
    lifecycle.lastEnded = { turnId: 9, reason: 'failed' };
    lifecycle.removeMain();
    lifecycle.addMain();
    await tick();
    expect(writes).toEqual(['completed']);
  });

  it('clears the persisted outcome when an undo rewinds the turn', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'aborted', reason: userCancellationReason() }, 1);
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
    started(1);
    ended({ type: 'aborted', reason: userCancellationReason() }, 1);
    expect(writes).toEqual(['cancelled']);
    lifecycle.bus.publish(new ContextUndone({ agentId: 'main', turns: 1, fromTurnId: 2 }));
    expect(writes).toEqual(['cancelled']);
  });

  it('tracks the narrated turn across equal outcomes for the undo range check', async () => {
    lifecycle.addMain();
    await tick();
    started(1);
    ended({ type: 'done' }, 1);
    started(2);
    ended({ type: 'done' }, 2);
    expect(writes).toEqual(['completed', undefined, 'completed']);
    lifecycle.bus.publish(new ContextUndone({ agentId: 'main', turns: 1, fromTurnId: 2 }));
    expect(writes).toEqual(['completed', undefined, 'completed', undefined]);
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
    started(1);
    ended({ type: 'failed', error: new Error('boom') }, 1);
    expect(writes).toEqual(['failed']);
    lifecycle.removeMain();
    lifecycle.addMain();
    started(2);
    ended({ type: 'done' }, 2);
    expect(writes).toEqual(['failed', undefined, 'completed']);
  });
});
