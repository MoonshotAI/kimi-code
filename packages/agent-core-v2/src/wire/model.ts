/**
 * `wire` domain (L2) — Model definition primitive (`ModelDef` / `defineModel`),
 * `DeepReadonly<T>` (the compile-time half of immutability), and the
 * `ModelRehydrateFn` / `PartsRehydrator` types that let a model declare how to
 * rehydrate blob references in its state after replay.
 *
 * A `ModelDef` is a stateless descriptor: it names a model and manufactures its
 * initial state via `initial`. It never holds state itself — per-scope state
 * instances are owned by `IWireService`, and domain services read them through
 * `wire.getModel(model)`. The optional `rehydrate` function declares how to
 * traverse the model's state and replace blob references with inline data after
 * replay — only models whose state contains `ContentPart[]` (e.g. ContextModel)
 * need it; all others leave it undefined (no-op). `WireService.replay` applies
 * all records first (blobref URLs enter the model state as-is, zero I/O), then
 * calls `rehydrate` on each model that declares it — so only the *surviving*
 * state is rehydrated, skipping data that was later removed by compaction.
 *
 * `PartsRehydrator` uses `readonly unknown[]` rather than `ContentPart[]` so
 * this file stays free of `app/llmProtocol` imports (L2 → L3 boundary); the
 * cast happens once inside `WireService.rehydrateModels`.
 *
 * `DeepReadonly<T>` recursively maps a state type to its deeply-readonly view
 * for the references returned by `getModel` / `subscribe`: functions pass
 * through, `Map` / `Set` widen to `ReadonlyMap` / `ReadonlySet`, arrays and
 * tuples widen to `ReadonlyArray`, plain objects become a readonly mapped type,
 * and primitives are unchanged. It pairs with the runtime `Object.freeze`
 * applied by `WireService` after every `apply`. Scope-agnostic.
 */

export type PartsRehydrator = (parts: readonly unknown[]) => Promise<readonly unknown[]>;

export type ModelRehydrateFn<S> = (
  state: S,
  rehydrateParts: PartsRehydrator,
) => S | Promise<S>;

export interface ModelDef<S> {
  readonly name: string;
  readonly initial: () => S;
  readonly rehydrate?: ModelRehydrateFn<S>;
}

export function defineModel<S>(
  name: string,
  initial: () => S,
  opts?: { rehydrate?: ModelRehydrateFn<S> },
): ModelDef<S> {
  return { name, initial, rehydrate: opts?.rehydrate };
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
