/**
 * `wire` domain (L2) — Op definition primitive (`Op`, `OpDescriptor`,
 * `defineOp`, the global `OP_REGISTRY`) and the `DuplicateOpError` fail-fast
 * guard.
 *
 * `defineOp` registers the descriptor into `OP_REGISTRY` at import time and
 * returns the descriptor fused with a payload factory, so a declared Op is both
 * callable (`goalCreate(payload)`) and inspectable (`goalCreate.apply`,
 * `goalCreate.type`). Every Op carries a mandatory pure `apply` and may carry
 * an optional `toEvent` that derives an `IEventBus` fact from the payload and
 * the post-apply state (published by `WireService` on `dispatch`, never on
 * `replay`). The descriptor's payload is erased to `any` on `Op.descriptor` (mirroring
 * `OP_REGISTRY`) so `Op` stays covariant in `P` — a heterogeneous batch of Ops,
 * each with a different payload type, stays assignable to the single
 * `dispatch(...ops: Op[])` rest parameter, while the precise payload type
 * survives on `Op.payload` for the Op's own caller. Registering a duplicate
 * `type` throws `DuplicateOpError` so the global Op-type namespace stays unique.
 * Descriptors may opt out of persistence (`persist: false`) for live-only
 * state, or opt out of timestamp stamping (`stamp: false`) for the metadata
 * envelope. Both default to the v1-compatible persisted, stamped path.
 * Scope-agnostic.
 */

import type { ModelDef } from './model';

export class DuplicateOpError extends Error {
  readonly code = 'ERR_DUPLICATE_OP' as const;

  constructor(readonly type: string) {
    super(`Duplicate Op type registered: '${type}'`);
    this.name = 'DuplicateOpError';
  }
}

export interface OpDescriptor<K extends string, S, P> {
  readonly type: K;
  readonly model: ModelDef<S>;
  readonly apply: (state: S, payload: P) => S;
  /**
   * Optional fact derivation: when present, `WireService` publishes the
   * returned event to `IEventBus` after the op is applied + persisted
   * (`dispatch` only — `replay` is silent and never derives events). `state`
   * is the post-apply model state, for ops whose event payload is read from
   * state (e.g. a snapshot). Returns `unknown` so generic `op.ts` stays
   * decoupled from `IEventBus`; the producer-side type safety comes from each
   * domain's `DomainEventMap` augmentation at the `defineOp` call site and the
   * `eventBus.publish` cast in `WireService`. Return `undefined` (or omit) to
   * derive no event.
   */
  readonly toEvent?: (payload: P, state: S) => unknown;
  readonly persist?: boolean;
  readonly stamp?: boolean;
}

export interface Op<K extends string = string, P = unknown> {
  readonly type: K;
  readonly payload: P;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly descriptor: OpDescriptor<K, any, any>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OP_REGISTRY = new Map<string, OpDescriptor<any, any, any>>();

export function defineOp<K extends string, S, P>(
  model: ModelDef<S>,
  type: K,
  opts: {
    apply: (state: S, payload: P) => S;
    toEvent?: (payload: P, state: S) => unknown;
    persist?: boolean;
    stamp?: boolean;
  },
): OpDescriptor<K, S, P> & ((payload: P) => Op<K, P>) {
  if (OP_REGISTRY.has(type)) {
    throw new DuplicateOpError(type);
  }
  const descriptor: OpDescriptor<K, S, P> = {
    type,
    model,
    apply: opts.apply,
    toEvent: opts.toEvent,
    persist: opts.persist,
    stamp: opts.stamp,
  };
  OP_REGISTRY.set(type, descriptor);
  const factory = (payload: P): Op<K, P> => ({ type, payload, descriptor });
  return Object.assign(factory, descriptor);
}
