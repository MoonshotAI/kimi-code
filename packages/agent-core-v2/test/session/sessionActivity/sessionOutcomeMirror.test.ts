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
import { Emitter } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import { AgentActivityUpdated } from '#/agent/activityView/activityView';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionOutcomeMirror } from '#/session/sessionActivity/sessionOutcomeMirror';
import { SessionOutcomeMirror } from '#/session/sessionActivity/sessionOutcomeMirrorService';

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
  private readonly createEmitter = new Emitter<IAgentScopeHandle>();
  private readonly disposeEmitter = new Emitter<string>();
  readonly onDidCreate = this.createEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;
  private mainPresent = false;

  private readonly mainHandle = {
    id: MAIN_AGENT_ID,
    accessor: { get: (token: unknown) => (token === IEventBus ? this.bus : undefined) },
  } as unknown as IAgentScopeHandle;

  get(agentId: string): IAgentScopeHandle | undefined {
    return agentId === MAIN_AGENT_ID && this.mainPresent ? this.mainHandle : undefined;
  }

  list(): readonly IAgentScopeHandle[] {
    return this.mainPresent ? [this.mainHandle] : [];
  }

  addMain(): void {
    this.mainPresent = true;
    this.createEmitter.fire(this.mainHandle);
  }

  removeMain(): void {
    this.mainPresent = false;
    this.disposeEmitter.fire(MAIN_AGENT_ID);
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
    // Construct the scope-created recorder.
    session.accessor.get(ISessionOutcomeMirror);
  });

  afterEach(() => {
    disposables.dispose();
    host.dispose();
  });

  const started = (turnId = 1) =>
    lifecycle.bus.publish(new TurnStarted({ turnId, origin: { kind: 'user' } }));
  const ended = (reason: TurnEnded['reason'], interruptReason?: TurnEnded['interruptReason'], turnId = 1) =>
    lifecycle.bus.publish(new TurnEnded({ turnId, reason, interruptReason }));
  const activityBackfill = (turnId: number, reason: TurnEnded['reason']) =>
    lifecycle.bus.publish(
      new AgentActivityUpdated({
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
    // A second session scope (same metadata stub) adopts the persisted value
    // and skips the duplicate write.
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
    secondLifecycle.bus.publish(new TurnEnded({ turnId: 1, reason: 'failed' }));
    expect(writes).toEqual(['failed']);
    secondLifecycle.bus.publish(new TurnEnded({ turnId: 2, reason: 'completed' }));
    expect(writes).toEqual(['failed', 'completed']);
  });

  it('a live turn ending writes with the recency bump, never the backfill channel', async () => {
    lifecycle.addMain();
    await tick();
    started();
    ended('completed');
    activityBackfill(1, 'completed');
    // Nothing was persisted before, so the turn.started clear is a deduped
    // no-op; the single write is the bumped live outcome.
    expect(writes).toEqual(['completed']);
    expect(touches).toEqual([true]);
  });

  it('backfills a restored outcome that never got a turn.ended fact', async () => {
    lifecycle.addMain();
    await tick();
    // A cold resume restores the outcome through the wire seed and publishes
    // it as agent.activity.updated — no turn.ended ever fires.
    activityBackfill(3, 'failed');
    expect(writes).toEqual(['failed']);
    // The same outcome arriving live afterwards stays deduped.
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
