/**
 * `sessionActivity` domain — `ISessionOutcomeRecorder` implementation.
 *
 * Subscribes to the main agent's `turn.ended` facts (through `agentLifecycle`
 * creation and the agent's `eventBus`) and persists the terminal outcome
 * through `ISessionMetadata`, so the session index (and therefore cold
 * listings) keeps the latest outcome across restarts. A programmatic abort —
 * including the cancel every in-flight turn suffers during scope disposal —
 * is never written, since a metadata write mid-teardown races the host's
 * home-dir removal; user stops ('user_cancelled') are persisted like any
 * other terminal state. Writes are deduped against the last value this
 * process persisted. Bound at Session scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
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
  private mainSubscription: IDisposable | undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this.attachMain();
    this._register(this.agents.onDidCreate((handle) => {
      if (handle.id === MAIN_AGENT_ID) this.attachMain();
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
    this.mainSubscription = bus.subscribe('turn.ended', (event) => {
      if (event.type !== 'turn.ended') return;
      const reason = (event as { reason?: unknown }).reason;
      const interruptReason = (event as { interruptReason?: unknown }).interruptReason;
      if (reason === 'completed') {
        this.persist('completed');
        return;
      }
      if (reason === 'failed' || reason === 'blocked') {
        this.persist('failed');
        return;
      }
      if (reason === 'cancelled' && interruptReason === 'user_cancelled') {
        this.persist('cancelled');
      }
    });
  }

  private persist(outcome: SessionTurnOutcome): void {
    if (outcome === this.lastPersisted) return;
    this.lastPersisted = outcome;
    void this.metadata
      .update({ lastTurnOutcome: outcome })
      .catch(() => {});
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOutcomeRecorder,
  SessionOutcomeRecorder,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
