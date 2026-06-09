/**
 * Lifecycle primitives for DI-managed services: `IDisposable` interface, a
 * `Disposable` base class, plus the helper primitives (`DisposableStore`,
 * `MutableDisposable`, `toDisposable`, `combinedDisposable`, `Disposable.None`)
 * that `Event<T>` / `Emitter<T>` (in `base/common/event.ts`) build on top of.
 *
 * Modelled after VSCode's `base/common/lifecycle.ts`. Children disposed by
 * `Disposable` / `DisposableStore` are torn down in reverse register order
 * (LIFO) and each `dispose()` is wrapped in try/catch so one failing child
 * does not skip its siblings.
 */

import { onUnexpectedError } from '../errors/unexpectedError';

export interface IDisposable {
  dispose(): void;
}

/**
 * Base class for services that own other disposables. Subclasses call
 * `this._register(child)` to take ownership; `dispose()` tears children down
 * in reverse register order (LIFO) and is idempotent.
 */
export abstract class Disposable implements IDisposable {
  private _disposed = false;
  protected _toDispose: IDisposable[] = [];

  /**
   * Take ownership of a child disposable. Returns the child for ergonomic
   * one-liner chaining (`const x = this._register(new Foo())`).
   */
  protected _register<T extends IDisposable>(d: T): T {
    if (this._disposed) {
      // Don't silently hold a reference after disposal; tear down immediately
      // so we don't leak the child if someone calls `_register` post-dispose.
      try {
        d.dispose();
      } catch {
        // Swallow: dispose() must be idempotent / forgiving.
      }
      return d;
    }
    this._toDispose.push(d);
    return d;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    // Reverse order: most-recently-registered tears down first (LIFO).
    while (this._toDispose.length > 0) {
      const child = this._toDispose.pop();
      if (!child) continue;
      try {
        child.dispose();
      } catch {
        // Continue tearing down siblings even if one throws.
      }
    }
  }

  protected get _isDisposed(): boolean {
    return this._disposed;
  }
}

/**
 * Static zero-value disposable. `Disposable.None.dispose()` is a no-op and
 * is safe to call repeatedly. The object is frozen so callers can't mutate
 * the shared instance. Modelled after VSCode `base/common/lifecycle.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Disposable {
  export const None: IDisposable = Object.freeze({
    dispose(): void {
      /* no-op */
    },
  });
}

/**
 * Wrap a function as an `IDisposable`. The returned object's `dispose()`
 * invokes `fn` at most once — repeated calls are a no-op (idempotent).
 */
export function toDisposable(fn: () => void): IDisposable {
  let called = false;
  return {
    dispose(): void {
      if (called) return;
      called = true;
      fn();
    },
  };
}

/**
 * Aggregate multiple disposables into a single `IDisposable`. The returned
 * object's `dispose()` invokes each child's `dispose()` — each call wrapped
 * in try/catch so one throwing child does not skip its siblings (mirrors
 * `Disposable.dispose()` semantics above). Idempotent: a second `dispose()`
 * is a no-op.
 */
export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const child of disposables) {
        try {
          child.dispose();
        } catch (err) {
          // Route to onUnexpectedError so the failure is visible, but keep
          // iterating siblings (consistent with Disposable.dispose()).
          onUnexpectedError(err);
        }
      }
    },
  };
}

/**
 * Mutable slot that owns a single `IDisposable`. Assigning a new value
 * disposes the previous one; assigning `undefined` disposes the current
 * value. After this store has itself been disposed any subsequent value
 * is disposed immediately on assignment (mirrors `Disposable._register`).
 *
 * Mirrors VSCode `base/common/lifecycle.ts MutableDisposable`.
 */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  private _value: T | undefined;
  private _isDisposed = false;

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value;
  }

  set value(value: T | undefined) {
    if (this._isDisposed) {
      // Once disposed, the slot can no longer hold a reference — tear
      // down the new value immediately and keep the slot empty.
      if (value !== undefined) {
        try {
          value.dispose();
        } catch (err) {
          onUnexpectedError(err);
        }
      }
      return;
    }
    if (this._value === value) {
      return;
    }
    const prev = this._value;
    this._value = value;
    if (prev !== undefined) {
      try {
        prev.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  /**
   * Dispose the held value (if any) and mark the slot as disposed.
   * Subsequent `value = ...` assignments dispose the incoming value
   * immediately. Idempotent.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    const prev = this._value;
    this._value = undefined;
    if (prev !== undefined) {
      try {
        prev.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  /**
   * Clear the held value (dispose if present) without disposing the store
   * itself — subsequent assignments still work.
   */
  clear(): void {
    if (this._isDisposed) return;
    const prev = this._value;
    this._value = undefined;
    if (prev !== undefined) {
      try {
        prev.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }
}

/**
 * Container that owns multiple `IDisposable`s. `add` returns the child for
 * chaining; `delete` removes (without disposing); `clear` disposes every
 * currently-held child; `dispose` disposes every child and marks the store
 * as disposed. Once disposed, subsequent `add(child)` calls dispose the
 * incoming child immediately (mirrors `Disposable._register`).
 *
 * Mirrors VSCode `base/common/lifecycle.ts DisposableStore`.
 */
export class DisposableStore implements IDisposable {
  private _toDispose = new Set<IDisposable>();
  private _isDisposed = false;

  /**
   * Take ownership of `d`. Returns `d` for ergonomic chaining
   * (`const x = store.add(new Foo())`). After the store has been disposed,
   * `add` disposes the incoming child immediately and still returns it.
   */
  add<T extends IDisposable>(d: T): T {
    if (this._isDisposed) {
      try {
        d.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
      return d;
    }
    this._toDispose.add(d);
    return d;
  }

  /**
   * Remove `d` from the store WITHOUT disposing it. No-op if `d` is not
   * currently tracked.
   */
  delete<T extends IDisposable>(d: T): void {
    if (this._isDisposed) return;
    this._toDispose.delete(d);
  }

  /**
   * Dispose every currently-held child but keep the store usable
   * (subsequent `add` calls still work).
   */
  clear(): void {
    if (this._isDisposed) return;
    if (this._toDispose.size === 0) return;
    const items = Array.from(this._toDispose);
    this._toDispose.clear();
    // Iterate in reverse so most-recently-added tears down first (LIFO),
    // matching `Disposable.dispose()` semantics.
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]!.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  /**
   * Dispose every currently-held child and mark the store as disposed.
   * Idempotent.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    const items = Array.from(this._toDispose);
    this._toDispose.clear();
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]!.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }
}
