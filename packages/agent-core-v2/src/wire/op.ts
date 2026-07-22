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
 * the post-apply state (published by `WireService` on live `dispatch`,
 * never during `restore`). A mandatory `schema` (zod, declared before `apply`) is the
 * payload's single source of truth: `P` is inferred from it, so Op authors
 * never restate payload interfaces, and it is stored on the descriptor for
 * payload validation at wire boundaries; the runtime paths (`dispatch` /
 * `restore`) never consult it. The descriptor's payload is erased
 * to `any` on `Op.descriptor` (mirroring `OP_REGISTRY`) so `Op` stays
 * covariant in `P` — a heterogeneous batch of Ops, each with a different
 * payload type, stays assignable to the single `dispatch(...ops: Op[])` rest
 * parameter, while the precise payload type survives on `Op.payload` for the
 * Op's own caller. Registering a duplicate `type` throws `DuplicateOpError` so
 * the global Op-type namespace stays unique. Payloads flow from each Op
 * definition into the `types.ts` registries (which map op types to `typeof`
 * the Op); registration constrains only the persistence policy — a registered
 * type must honor its map, an unregistered type keeps its free `persist`
 * option. Scope-agnostic.
 */

import type { z } from 'zod';

import type { ConflictingOpType, OpPersistenceOptions, OpType } from '#/wire/types';

import { WireError, WireErrors } from './errors';
import type { ModelDef } from './model';

export class DuplicateOpError extends WireError {
  constructor(readonly type: string) {
    super(WireErrors.codes.WIRE_DUPLICATE_OP, `Duplicate Op type registered: '${type}'`, {
      details: { type },
    });
    this.name = 'DuplicateOpError';
  }
}

/**
 * Context handed to `apply` / cross-model reducers alongside the payload.
 * `recordIndex` is the Op's own position in the journal (0-based over
 * NON-metadata records): assigned by `WireService` on live dispatch for
 * persisted Ops, and supplied from the replay cursor during restore. It is
 * `undefined` for transient (`persist: false`) Ops on the live path — they
 * never occupy a journal line. Ops that only transform state ignore it; Ops
 * that index journal positions (e.g. turn-boundary indexes feeding `log.cut`
 * targets) require it.
 */
export interface OpApplyContext {
  readonly recordIndex?: number;
}

export interface OpDescriptor<K extends string, S, P> {
  readonly type: K;
  readonly model: ModelDef<S>;
  readonly schema: z.ZodType<P>;
  readonly apply: (state: S, payload: P, ctx?: OpApplyContext) => S;
  readonly toEvent?: (payload: P, state: S) => unknown;
  readonly persist?: boolean;
}

export interface Op<K extends string = string, P = unknown> {
  readonly type: K;
  readonly payload: P;
  /**
   * Journal position of this Op's record, set only by `WireService` internals
   * (restore replay and, for persisted Ops, live dispatch). Never set by
   * callers of `dispatch`.
   */
  readonly recordIndex?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly descriptor: OpDescriptor<any, any, any>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const OP_REGISTRY = new Map<string, OpDescriptor<any, any, any>>();

interface OpBehaviorOptions<S, P> {
  readonly schema: z.ZodType<P>;
  readonly apply: (state: S, payload: P, ctx?: OpApplyContext) => S;
  readonly toEvent?: (payload: P, state: S) => unknown;
}

type RegisteredOpConstraint<K extends string> = K extends ConflictingOpType
  ? never
  : K extends OpType
    ? OpPersistenceOptions<K>
    : unknown;

type DefineOpOptions<K extends string, S, P> = OpBehaviorOptions<S, P> & {
  readonly persist?: boolean;
} & RegisteredOpConstraint<K>;

type DefinedOp<K extends string, S, P> = OpDescriptor<K, S, P> &
  ((payload: P) => Op<K, P>);

export interface DefineOpFn<S> {
  <const K extends string, P>(
    type: K & SingleStringLiteral<K>,
    opts: DefineOpOptions<NoInfer<K>, S, P>,
  ): DefinedOp<K, S, P>;
}

type SingleStringLiteral<K extends string, Whole extends string = K> = {} extends Record<K, never>
  ? never
  : K extends unknown
    ? [Whole] extends [K]
      ? K
      : never
    : never;

export function bindDefineOp<S>(getModel: () => ModelDef<S>): DefineOpFn<S> {
  const bound = (type: string, opts: unknown): unknown =>
    defineOp(getModel(), type as never, opts as never);
  return bound as DefineOpFn<S>;
}

export function defineOp<const K extends string, S, P>(
  model: ModelDef<S>,
  type: K & SingleStringLiteral<K>,
  opts: DefineOpOptions<NoInfer<K>, S, P>,
): DefinedOp<K, S, P> {
  if (OP_REGISTRY.has(type)) {
    throw new DuplicateOpError(type);
  }
  const behavior: OpBehaviorOptions<S, P> & {
    readonly persist?: boolean;
  } = opts;
  const descriptor: OpDescriptor<K, S, P> = {
    type,
    model,
    schema: behavior.schema,
    apply: behavior.apply,
    toEvent: behavior.toEvent,
    persist: behavior.persist,
  };
  OP_REGISTRY.set(type, descriptor);
  const factory = (payload: P): Op<K, P> => ({ type, payload, descriptor });
  return Object.assign(factory, descriptor);
}
