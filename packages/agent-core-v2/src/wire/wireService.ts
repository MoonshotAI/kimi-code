/**
 * `wire` domain (L2) — `IWireService` contract and its supporting types
 * (`PersistedRecord`, `OpGroup`, `ModelChange`, `WireEmission`).
 *
 * The scope-agnostic state-machine engine: `dispatch` persists + applies +
 * notifies (OpGroup `{ silent: false }`), `replay` (async — rehydrates blob
 * references first) applies only (`{ silent: true }`), and `signal` broadcasts
 * transiently without an OpGroup; `flush` drains the serialized persist queue.
 * Reads go through `getModel` / `subscribe`; emissions and restore completion
 * stream via `onEmission` / `onRestored`. A single implementation serves every
 * scope — instances are isolated per scope through the distinct DI tokens in
 * `tokens`, each seeded with its own persistence key. `PersistedRecord` is the
 * on-the-wire append-log shape (`wire.jsonl`): intentionally flat
 * (`{ type, ...payload }`, optional `time`) so it stays byte-compatible with the
 * existing `WireRecord` journal (`{ type, time?, ...fields }`) — payload fields
 * sit at the top level next to `type`, never nested under a `payload` key; the
 * index signature keeps it scope-agnostic and domains narrow via their Op
 * payload types. Scope-agnostic.
 */

import type { IDisposable } from '#/_base/di/lifecycle';

import type { DeepReadonly, ModelDef } from './model';
import type { Op } from './op';
import type { Signal } from './signal';

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

export type WireEmission =
  | { readonly type: 'record'; readonly record: PersistedRecord }
  | { readonly type: 'signal'; readonly signal: Signal };

export interface IWireService {
  readonly _serviceBrand: undefined;

  dispatch(...ops: Op[]): void;
  replay(...records: PersistedRecord[]): Promise<void>;
  signal(signal: Signal): void;
  flush(): Promise<void>;

  getModel<S>(model: ModelDef<S>): DeepReadonly<S>;
  subscribe<S>(
    model: ModelDef<S>,
    handler: (state: DeepReadonly<S>, prev: DeepReadonly<S>) => void,
  ): IDisposable;
  onEmission(handler: (emission: WireEmission) => void): IDisposable;
  onRestored(handler: () => void): IDisposable;
}
