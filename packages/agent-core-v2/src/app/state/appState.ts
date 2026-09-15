import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IAppStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IAppStateService: ServiceIdentifier<IAppStateService> =
  createDecorator<IAppStateService>('appStateService');
