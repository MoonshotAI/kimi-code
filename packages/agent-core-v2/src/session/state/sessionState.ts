/**
 * `state` domain — Session-scope keyed state container contract.
 *
 * Defines `ISessionStateService`, the Session-scope state service:
 * Session-tier services declare their plain-data state as typed keys
 * (`defineState` from `_base`) and read/write them through this container, so
 * per-session shared state lives in one observable place and dies with the
 * session. Shares the `IStateRegistry` method set with its
 * App/Workspace/Agent counterparts; its `inspect()` cascade continues into
 * the Workspace tier. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface ISessionStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const ISessionStateService: ServiceIdentifier<ISessionStateService> =
  createDecorator<ISessionStateService>('sessionStateService');
