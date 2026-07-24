/**
 * `state` domain (L1) — App-scope keyed state container contract.
 *
 * Defines `IStateService`, the App-scope state service: App-tier services
 * declare their plain-data state as typed keys (`defineState` from `_base`)
 * and read/write them through this container, so process-wide shared state
 * lives in one observable place instead of scattering across private fields.
 * Shares the `IStateRegistry` method set with its Session/Agent counterparts.
 * Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IStateService: ServiceIdentifier<IStateService> =
  createDecorator<IStateService>('stateService');
