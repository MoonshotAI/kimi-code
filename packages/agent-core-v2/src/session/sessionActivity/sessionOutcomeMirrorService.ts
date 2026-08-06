/**
 * `sessionActivity` domain — `ISessionOutcomeMirror` implementation.
 *
 * Persists the main agent's terminal turn outcomes through `ISessionMetadata`
 * (observed via `agentLifecycle` and the main agent's `eventBus`), so the
 * session index keeps reporting them across restarts. Persisted on turn end
 * (completed/failed, or a user's stop), cleared when a new turn starts, and
 * backfilled from a cold resume's restored outcome — backfills never bump
 * `updatedAt`, and programmatic aborts (including scope-teardown cancels)
 * are deliberately never persisted live (a close-induced abort produces no
 * write here), and backfills only apply to a pure resume (no turn started in
 * this process — a live turn end owns its write, recency bump included). Writes are deduped against the last value this
 * process persisted. Bound at Session scope.
 */

import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import type { SessionTurnOutcome } from './sessionActivity';
import { ISessionOutcomeMirror } from './sessionOutcomeMirror';

export class SessionOutcomeMirror extends Disposable implements ISessionOutcomeMirror {
  declare readonly _serviceBrand: undefined;

  private lastPersisted: SessionTurnOutcome | undefined;
  private adopted = false;
  private turnStartedHere = false;
  private mainSubscription: DisposableStore | undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    void this.metadata
      .read()
      .then((meta) => {
        if (!this.adopted) this.lastPersisted = meta.lastTurnReason;
      })
      .catch(() => {});
    this.attachMain();
    this._register(this.agents.onDidCreate((handle) => {
      if (handle.id === MAIN_AGENT_ID) this.attachMain();
    }));
    this._register(this.agents.onDidDispose((agentId) => {
      if (agentId !== MAIN_AGENT_ID) return;
      this.mainSubscription?.dispose();
      this.mainSubscription = undefined;
    }));
    this._register({
      dispose: () => {
        this.mainSubscription?.dispose();
        this.mainSubscription = undefined;
      },
    });
  }

  private attachMain(): void {
    if (this.mainSubscription !== undefined) return;
    const bus = this.agents.get(MAIN_AGENT_ID)?.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    const subscription = new DisposableStore();
    this.mainSubscription = subscription;
    subscription.add(
      bus.subscribe('turn.ended', (event) => {
        if (event.type !== 'turn.ended') return;
        const reason = (event as { reason?: unknown }).reason;
        const interruptReason = (event as { interruptReason?: unknown }).interruptReason;
        if (reason === 'completed') {
          this.write('completed');
          return;
        }
        if (reason === 'failed' || reason === 'blocked') {
          this.write('failed');
          return;
        }
        if (reason === 'cancelled' && interruptReason === 'user_cancelled') {
          this.write('cancelled');
        }
      }),
    );
    subscription.add(
      bus.subscribe('turn.started', () => {
        this.turnStartedHere = true;
        this.write(undefined);
      }),
    );
    subscription.add(
      bus.subscribe('agent.activity.updated', (event) => {
        if (this.turnStartedHere) return;
        if (this.lastPersisted !== undefined) return;
        const lastTurn = (event as { lastTurn?: { reason?: unknown } }).lastTurn;
        const reason = lastTurn?.reason;
        if (reason === 'completed' || reason === 'cancelled') {
          this.write(reason, { touchUpdatedAt: false });
        } else if (reason === 'failed' || reason === 'blocked') {
          this.write('failed', { touchUpdatedAt: false });
        }
      }),
    );
  }

  private write(
    outcome: SessionTurnOutcome | undefined,
    opts?: { readonly touchUpdatedAt?: boolean },
  ): void {
    if (outcome === this.lastPersisted) return;
    this.adopted = true;
    const previous = this.lastPersisted;
    this.lastPersisted = outcome;
    void this.metadata.update({ lastTurnReason: outcome }, opts).catch(() => {
      if (this.lastPersisted === outcome) this.lastPersisted = previous;
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOutcomeMirror,
  SessionOutcomeMirror,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
