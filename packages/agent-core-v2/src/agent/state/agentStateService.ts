/**
 * `state` domain — `IAgentStateService` implementation.
 *
 * Thin per-scope binding over the `_base` `StateRegistry`; the container owns
 * construction and disposal, so registered state dies with the scope. At
 * construction it materializes the static built-in replayable state keys
 * (`REPLAYABLE_STATE_KEYS`, filled at import time through
 * `defineState(...).replayable(...)`), so every replayable value is readable
 * through `get` before the event dispatcher runs its first fold or restore.
 * Injects the Session-tier state service as its `inspect()` cascade parent
 * (the parameter is optional so tests can construct a bare container; DI
 * always injects). Bound at Agent scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { StateRegistry, type StateKey } from '#/_base/state/stateRegistry';
import { ISessionStateService } from '#/session/state/sessionState';
import type { ReplayableStateKey } from '#/state/state';

import { IAgentStateService } from './agentState';

export class AgentStateService extends StateRegistry implements IAgentStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'agent';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly replayables: ReplayableStateKey<any>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly contributeListeners = new Set<(key: ReplayableStateKey<any>) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly withdrawListeners = new Set<(key: ReplayableStateKey<any>) => void>();

  constructor(@ISessionStateService sessionState?: ISessionStateService) {
    super();
    this.inspectParent = sessionState;
  }

  override contributeState<T>(key: StateKey<T>): IDisposable {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (key as Partial<ReplayableStateKey<any>>).replayable;
    if (typeof meta !== 'object' || meta === null) {
      return super.contributeState(key);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replayableKey = key as unknown as ReplayableStateKey<any>;
    const registration = this.contributeKey(key);
    this.replayables.push(replayableKey);
    try {
      for (const listener of this.contributeListeners) {
        listener(replayableKey);
      }
    } catch (error) {
      registration.dispose();
      const index = this.replayables.indexOf(replayableKey);
      if (index !== -1) this.replayables.splice(index, 1);
      for (const listener of this.withdrawListeners) {
        listener(replayableKey);
      }
      throw error;
    }
    return toDisposable(() => {
      registration.dispose();
      const index = this.replayables.indexOf(replayableKey);
      if (index !== -1) this.replayables.splice(index, 1);
      for (const listener of this.withdrawListeners) {
        listener(replayableKey);
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replayableKeys(): readonly ReplayableStateKey<any>[] {
    return [...this.replayables];
  }

  onDidContributeReplayable(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (key: ReplayableStateKey<any>) => void,
  ): IDisposable {
    this.contributeListeners.add(listener);
    return toDisposable(() => {
      this.contributeListeners.delete(listener);
    });
  }

  onDidWithdrawReplayable(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (key: ReplayableStateKey<any>) => void,
  ): IDisposable {
    this.withdrawListeners.add(listener);
    return toDisposable(() => {
      this.withdrawListeners.delete(listener);
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStateService,
  AgentStateService,
  ScopeActivation.OnScopeCreated,
  'state',
);
