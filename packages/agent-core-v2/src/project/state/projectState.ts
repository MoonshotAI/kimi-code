import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IProjectStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IProjectStateService: ServiceIdentifier<IProjectStateService> =
  createDecorator<IProjectStateService>('workspaceStateService');
