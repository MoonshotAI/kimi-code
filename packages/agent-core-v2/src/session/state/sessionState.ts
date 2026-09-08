import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface ISessionStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const ISessionStateService: ServiceIdentifier<ISessionStateService> =
  createDecorator<ISessionStateService>('sessionStateService');
