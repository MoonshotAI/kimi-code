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

  private readonly replayables: ReplayableStateKey<any>[] = [];
  private readonly contributeListeners = new Set<(key: ReplayableStateKey<any>) => void>();
  private readonly withdrawListeners = new Set<(key: ReplayableStateKey<any>) => void>();

  constructor(@ISessionStateService sessionState?: ISessionStateService) {
    super();
    this.inspectParent = sessionState;
  }

  override contributeState<T>(key: StateKey<T>): IDisposable {
    const meta = (key as Partial<ReplayableStateKey<any>>).replayable;
    if (typeof meta !== 'object' || meta === null) {
      return super.contributeState(key);
    }
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

  replayableKeys(): readonly ReplayableStateKey<any>[] {
    return [...this.replayables];
  }

  onDidContributeReplayable(
    listener: (key: ReplayableStateKey<any>) => void,
  ): IDisposable {
    this.contributeListeners.add(listener);
    return toDisposable(() => {
      this.contributeListeners.delete(listener);
    });
  }

  onDidWithdrawReplayable(
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
