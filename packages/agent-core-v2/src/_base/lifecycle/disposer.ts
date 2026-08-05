/**
 * `_base.lifecycle` — disposer types shared by the Ledger.
 *
 * A `Disposer` undoes one registered side effect. Disposers are dual-track
 * (sync / async), mirroring ES explicit resource management: a Ledger whose
 * entries are all synchronous tears down within a single tick; any async
 * entry suspends the teardown promise until it settles.
 */

/** Why the ledger is being torn down; threaded through to every disposer. */
export type TeardownReason = 'scope-close' | 'cascade' | 'unload';

export type Disposer = (reason: TeardownReason) => void | Promise<void>;

/**
 * The four return forms accepted from an effect body:
 * - `void` — nothing to roll back (the entry still exists for introspection);
 * - `Disposer` — a single rollback action;
 * - `Promise<Disposer | void>` — an asynchronously produced rollback action;
 * - sync / async iterator of `Disposer`s — each yielded value is one rollback
 *   action; if iteration throws partway, the already-yielded disposers are
 *   rolled back in reverse before the error propagates.
 */
export type EffectResult =
  | void
  | Disposer
  | Promise<Disposer | void>
  | Iterable<Disposer | void>
  | AsyncIterable<Disposer | void>;

export type EffectBody = () => EffectResult;

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function isSyncIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      'function'
  );
}
