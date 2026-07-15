/**
 * `wire` domain (L2) — Model definition primitive (`ModelDef` / `defineModel`),
 * `DeepReadonly<T>` (the compile-time half of immutability), and the
 * `ModelBlobCodec` / `PartsTransformer` types that let a model declare how to
 * dehydrate large inline media before persistence and rehydrate blob references
 * in its state after replay.
 *
 * A `ModelDef` is a stateless descriptor: it names a model, manufactures its
 * initial state via `initial`, and declares the model's Ops through
 * `defineOp` (the model-bound form of the primitive in `op.ts`). It never
 * holds state itself — per-scope state
 * instances are owned by `IWireService`, and domain services read them through
 * `wire.getModel(model)`. The optional `blobs` codec declares both directions
 * of the blob offload pipeline:
 * - `dehydrate(record, transform)`: called per-record at dispatch time; the
 *   model traverses its record structure, passes each `ContentPart[]` through
 *   `transform` (which offloads oversized data URIs to blob storage and returns
 *   parts with `blobref:` URLs), and returns the transformed record.
 * - `rehydrate(state, transform)`: called once after replay; the model
 *   traverses the surviving final state, passes each `ContentPart[]` through
 *   `transform` (which loads blob references back to inline data URIs), and
 *   returns the transformed state. Only the *surviving* state is rehydrated,
 *   skipping data that was later removed by compaction.
 *
 * Both directions receive a `PartsTransformer` — the same function shape — so
 * the model owns the traversal logic and `WireService` owns the storage I/O.
 * `PartsTransformer` uses `readonly unknown[]` rather than `ContentPart[]` so
 * this file stays free of `app/llmProtocol` imports (L2 → L3 boundary); the
 * cast happens once inside `WireService`.
 *
 * A primary Model may register cross-model reducers keyed by foreign op types:
 * `WireService.execute` runs them on both dispatch and replay, so v1-derived
 * restore effects can stay replayable without persisting extra records.
 *
 * `DeepReadonly<T>` recursively maps a state type to its deeply-readonly view
 * for the references returned by `getModel` / `subscribe`: functions pass
 * through, `Map` / `Set` widen to `ReadonlyMap` / `ReadonlySet`, arrays and
 * tuples widen to `ReadonlyArray`, plain objects become a readonly mapped type,
 * and primitives are unchanged. It pairs with the runtime `Object.freeze`
 * applied by `WireService` after every `apply`. Scope-agnostic.
 */

import { bindDefineOp, type DefineOpFn } from '#/wire/op';
import type { ModelReducers } from '#/wire/types';
import type { PersistedRecord } from '#/wire/wireService';

export type PartsTransformer = (parts: readonly unknown[]) => Promise<readonly unknown[]>;

export interface ModelBlobCodec<S> {
  dehydrate(record: PersistedRecord, transform: PartsTransformer): PersistedRecord | Promise<PersistedRecord>;
  rehydrate(state: S, transform: PartsTransformer): S | Promise<S>;
}

export interface ModelDef<S> {
  readonly name: string;
  readonly initial: () => S;
  readonly blobs?: ModelBlobCodec<S>;
  readonly defineOp: DefineOpFn<S>;
}

export interface ModelCrossReducerEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly model: ModelDef<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly reducer: (state: any, payload: any) => any;
}

export const MODEL_CROSS_REDUCERS = new Map<string, ModelCrossReducerEntry[]>();

export function defineModel<S>(
  name: string,
  initial: () => S,
  opts?: {
    blobs?: ModelBlobCodec<S>;
    reducers?: ModelReducers<S>;
  },
): ModelDef<S> {
  const def: ModelDef<S> = {
    name,
    initial,
    blobs: opts?.blobs,
    defineOp: bindDefineOp(() => def),
  };
  if (opts?.reducers !== undefined) {
    for (const [opType, reducer] of Object.entries(opts.reducers)) {
      if (reducer === undefined) continue;
      let list = MODEL_CROSS_REDUCERS.get(opType);
      if (list === undefined) {
        list = [];
        MODEL_CROSS_REDUCERS.set(opType, list);
      }
      list.push({ model: def, reducer });
    }
  }
  return def;
}

export interface DerivedModelDef<S> {
  readonly name: string;
  readonly initial: () => S;
  readonly reducers: Readonly<ModelReducers<S>>;
  readonly blobs?: ModelBlobCodec<S>;
}

export function defineDerivedModel<S>(
  name: string,
  initial: () => S,
  reducers: ModelReducers<S>,
  opts?: { blobs?: ModelBlobCodec<S> },
): DerivedModelDef<S> {
  return { name, initial, reducers, blobs: opts?.blobs };
}

export type DeepReadonly<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends readonly (infer E)[]
        ? ReadonlyArray<DeepReadonly<E>>
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;
