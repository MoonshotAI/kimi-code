/**
 * `wire` domain (L2) — the single Agent-scoped wire aggregate contract.
 *
 * The service owns one Agent's replayable model state and its journal as one
 * consistency boundary: restore reads, validates, migrates, rewrites, replays,
 * rehydrates, and then notifies restore participants. Live dispatch applies an
 * Op and appends its record. Callers do not coordinate journal and model state
 * through separate services.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type { DeepReadonly, DerivedModelDef, ModelDef } from './model';
import type { Op } from './op';

export interface IWireService {
  readonly _serviceBrand: undefined;

  dispatch(...ops: Op[]): void;
  restore(): Promise<void>;
  flush(): Promise<void>;

  getModel<S>(model: ModelDef<S>): DeepReadonly<S>;
  subscribe<S>(
    model: ModelDef<S> | DerivedModelDef<S>,
    handler: (state: DeepReadonly<S>, prev: DeepReadonly<S>) => void,
  ): IDisposable;
  onRestored(handler: () => void | Promise<void>): IDisposable;
}

export const IWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('wireService');
