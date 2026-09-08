import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IStateRegistry } from '#/_base/state/stateRegistry';
import type { ReplayableStateKey } from '#/state/state';

export interface IAgentStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
  replayableKeys(): readonly ReplayableStateKey<any>[];
  onDidContributeReplayable(
    listener: (key: ReplayableStateKey<any>) => void,
  ): IDisposable;
  onDidWithdrawReplayable(
    listener: (key: ReplayableStateKey<any>) => void,
  ): IDisposable;
}

export const IAgentStateService: ServiceIdentifier<IAgentStateService> =
  createDecorator<IAgentStateService>('agentStateService');
