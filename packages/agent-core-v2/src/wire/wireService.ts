/**
 * `wire` domain (L2) — `IWireService` contract and its supporting types
 * (`PersistedRecord`, `OpGroup`, `ModelChange`).
 *
 * The scope-agnostic state-machine engine: `dispatch` persists + applies +
 * notifies (OpGroup `{ silent: false }`), `replay` (async — rehydrates blob
 * references via `ModelDef.blobs` first) applies only (`{ silent: true }`);
 * `flush` drains the serialized persist queue. Reads go through `getModel` /
 * `subscribe`; the live append-log record stream streams via `onEmission`,
 * restore completion via `onRestored`, and Op-derived facts flow out through
 * `IEventBus` (see `op.ts` `toEvent`). A single implementation serves every
 * scope — instances are isolated per scope through the distinct DI tokens in
 * `tokens`, each seeded with its own persistence key. `PersistedRecord` is the
 * on-the-wire append-log shape (`wire.jsonl`): intentionally flat
 * (`{ type, ...payload }`, optional `time`) so it stays byte-compatible with the
 * existing wire journal (`{ type, time?, ...fields }`) — payload fields
 * sit at the top level next to `type`, never nested under a `payload` key; the
 * index signature keeps it scope-agnostic and domains narrow via their Op
 * payload types. Scope-agnostic.
 */

import type { IDisposable } from '#/_base/di/lifecycle';

import type { DeepReadonly, DerivedModelDef, ModelDef } from './model';
import type { Op } from './op';

export interface PersistedRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

export interface OpGroup {
  readonly ops: readonly Op[];
  readonly silent: boolean;
}

export interface ModelChange<S> {
  readonly state: S;
  readonly prev: S;
}

/**
 * Outcome of a `replay`: how many records were skipped because their Op type
 * is absent from `OP_REGISTRY`. Skips are also reported individually through
 * `onUnexpectedError` (`wire.unknown_record`); the count lets callers detect a
 * lossy restore without subscribing to the global error hook.
 */
export interface ReplayResult {
  readonly unknownRecords: number;
}

/**
 * Live append-log observation: `dispatch` emits each persisted record here so
 * observers (the test harness's `[wire]` capture, audit tooling) see the record
 * stream as it happens. Op-derived *facts* (`toEvent`) go to `IEventBus`
 * instead — they are not records and are not emitted here. The `signal`
 * variant that used to share this channel was retired in favor of `IEventBus`.
 */
export interface WireEmission {
  readonly type: 'record';
  readonly record: PersistedRecord;
}

export interface IWireService {
  readonly _serviceBrand: undefined;

  dispatch(...ops: Op[]): void;
  replay(...records: PersistedRecord[]): Promise<ReplayResult>;
  flush(): Promise<void>;

  attach<S>(model: DerivedModelDef<S>): IDisposable;
  getModel<S>(model: ModelDef<S> | DerivedModelDef<S>): DeepReadonly<S>;
  subscribe<S>(
    model: ModelDef<S> | DerivedModelDef<S>,
    handler: (state: DeepReadonly<S>, prev: DeepReadonly<S>) => void,
  ): IDisposable;
  onEmission(handler: (emission: WireEmission) => void): IDisposable;
  onRestored(handler: () => void | Promise<void>): IDisposable;
}
