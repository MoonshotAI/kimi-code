/**
 * `sessionActivity` domain — `ISessionOutcomeRecorder` implementation.
 *
 * Persists the main agent's terminal turn outcomes through `ISessionMetadata`
 * (observed via `agentLifecycle` and the main agent's `eventBus`), so the
 * session index keeps reporting them across restarts. A new turn start clears
 * the stored outcome, and programmatic aborts — including scope-teardown
 * cancels — are deliberately never persisted. Bound at Session scope.
 */

import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import type { SessionTurnOutcome } from './sessionActivity';
import { ISessionOutcomeRecorder } from './sessionOutcomeRecorder';

export class SessionOutcomeRecorder extends Disposable implements ISessionOutcomeRecorder {
  declare readonly _serviceBrand: undefined;

  private lastPersisted: SessionTurnOutcome | undefined;
  private adopted = false;
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
      // A failed bootstrap still fired onDidCreate; drop the dead bus so a
      // later main creation reattaches.
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
        if (this.lastPersisted !== undefined) this.write(undefined);
      }),
    );
    subscription.add(
      bus.subscribe('agent.activity.updated', (event) => {
        // The restored lastTurn (wire replay on cold resume) never gets a
        // turn.ended fact, so backfill it into the metadata when nothing is
        // persisted yet — otherwise pre-field sessions stay blank in cold
        // listings even after a resume restored their outcome.
        if (this.lastPersisted !== undefined) return;
        const lastTurn = (event as { lastTurn?: { reason?: unknown } }).lastTurn;
        const reason = lastTurn?.reason;
        // 'cancelled' is never backfilled: a restored cancel cannot be told
        // apart from a programmatic abort, and those are never persisted.
        if (reason === 'completed') this.write('completed');
        else if (reason === 'failed' || reason === 'blocked') this.write('failed');
      }),
    );
  }

  private write(outcome: SessionTurnOutcome | undefined): void {
    if (outcome === this.lastPersisted) return;
    this.adopted = true;
    const previous = this.lastPersisted;
    this.lastPersisted = outcome;
    void this.metadata.update({ lastTurnReason: outcome }).catch(() => {
      if (this.lastPersisted === outcome) this.lastPersisted = previous;
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOutcomeRecorder,
  SessionOutcomeRecorder,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
