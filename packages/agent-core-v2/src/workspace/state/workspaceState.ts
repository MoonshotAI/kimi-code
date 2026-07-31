/**
 * `state` domain — Workspace-scope keyed state container contract.
 *
 * Defines `IWorkspaceStateService`, the Workspace-scope state service:
 * Workspace-tier services declare their plain-data state as typed keys
 * (`defineState`) and read/write them through this container, so
 * per-handler shared state lives in one observable place and dies with the
 * workspace handler. Shares the `IStateRegistry` method set with its
 * App/Session/Agent counterparts; its `inspect()` cascade continues into the
 * App tier. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IWorkspaceStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceStateService: ServiceIdentifier<IWorkspaceStateService> =
  createDecorator<IWorkspaceStateService>('workspaceStateService');
