/**
 * `state` domain — App-scope keyed state container contract.
 *
 * Defines `IAppStateService`, the App-scope state service: App-tier services
 * declare their plain-data state as typed keys (via `defineState`)
 * and read/write them through this container, so process-wide shared state
 * lives in one observable place instead of scattering across private fields.
 * Shares the `IStateRegistry` method set with its Workspace/Session/Agent
 * counterparts and is the root of the four-tier `inspect()` cascade (no
 * parent). Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IAppStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IAppStateService: ServiceIdentifier<IAppStateService> =
  createDecorator<IAppStateService>('appStateService');
