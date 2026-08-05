/**
 * `sessionActivity` domain — `ISessionOutcomeRecorder` implementation.
 *
 * Subscribes to the session activity aggregate's (`ISessionActivityView`)
 * `turn_ended` changes and persists the resulting main-turn outcome through
 * `ISessionMetadata`, so the session index (and therefore cold listings)
 * keeps the latest outcome across restarts. Only 'completed' and 'failed'
 * are persisted: a 'cancelled' outcome is also what an in-flight turn ends
 * with when the session scope is being disposed (server close aborts the
 * turn), and firing a metadata write mid-teardown races the host's home-dir
 * removal. Writes are further deduped against the last value this process
 * persisted. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import type { SessionTurnOutcome } from './sessionActivity';
import { ISessionActivityView } from './sessionActivity';
import { ISessionOutcomeRecorder } from './sessionOutcomeRecorder';

export class SessionOutcomeRecorder extends Disposable implements ISessionOutcomeRecorder {
  declare readonly _serviceBrand: undefined;

  private lastPersisted: SessionTurnOutcome | undefined;

  constructor(
    @ISessionActivityView activity: ISessionActivityView,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this._register(
      activity.onDidChange(({ state, cause }) => {
        if (cause !== 'turn_ended') return;
        const outcome = state.lastTurnReason;
        if (outcome !== 'completed' && outcome !== 'failed') return;
        if (outcome === this.lastPersisted) return;
        this.lastPersisted = outcome;
        void this.metadata
          .update({ lastTurnOutcome: outcome })
          .catch(() => {});
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOutcomeRecorder,
  SessionOutcomeRecorder,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
