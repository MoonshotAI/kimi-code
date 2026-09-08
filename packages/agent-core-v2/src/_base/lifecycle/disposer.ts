export type TeardownReason = 'scope-close' | 'cascade' | 'unload';

export type Disposer = (reason: TeardownReason) => void | Promise<void>;

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
