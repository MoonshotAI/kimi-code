/**
 * `wire` domain (L2) — augmentable Op registries and their derived
 * compile-time vocabulary.
 *
 * Domains contribute their defined Ops to `PersistedOpMap` or `TransientOpMap`
 * via module augmentation (`'my.op': typeof myOp`). The selected map
 * classifies whether a live dispatch writes the Op, while `OpPayload` recovers
 * each Op's payload from the Op's own type: the payload flows from the Op
 * definition into the registry, never the reverse, so Op authoring stays free
 * of registry cycles. Persisted input remains an open wire boundary so replay
 * can continue to tolerate historical and newer record types. Scope-agnostic.
 */

export interface PersistedOpMap {}

export interface TransientOpMap {}

type StringKey<T> = Extract<keyof T, string>;

type PersistedOpKey = StringKey<PersistedOpMap>;
type TransientOpKey = StringKey<TransientOpMap>;

export type ConflictingOpType = Extract<PersistedOpKey, TransientOpKey>;
export type PersistedOpType = Exclude<PersistedOpKey, ConflictingOpType>;
export type TransientOpType = Exclude<TransientOpKey, ConflictingOpType>;
export type OpType = PersistedOpType | TransientOpType;

export type PayloadOf<T> = T extends (payload: infer P) => unknown ? P : never;

export type OpPayload<K extends OpType> = K extends PersistedOpType
  ? PayloadOf<PersistedOpMap[K]>
  : K extends TransientOpType
    ? PayloadOf<TransientOpMap[K]>
    : never;

export type ModelReducers<S> = {
  [K in OpType]?: (state: S, payload: OpPayload<K>) => S;
};

export type OpPersistenceOptions<K extends OpType> = K extends PersistedOpType
  ? { readonly persist?: true }
  : { readonly persist: false };
