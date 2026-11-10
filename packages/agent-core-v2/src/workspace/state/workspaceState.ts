import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IWorkspaceStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceStateService: ServiceIdentifier<IWorkspaceStateService> =
  createDecorator<IWorkspaceStateService>('workspaceStateService');
