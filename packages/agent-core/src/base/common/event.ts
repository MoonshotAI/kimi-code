/**
 * VSCode-style `Event<T>` / `Emitter<T>` for the agent-core base layer.
 *
 * `Event<T>` is the subscriber-side type — it's a callable that takes a
 * listener, optional `thisArg`, and an optional `disposables` collector
 * (either a raw `IDisposable[]` or a `DisposableStore`). The call returns
 * an `IDisposable` whose `dispose()` removes the listener.
 *
 * `Emitter<T>` is the publisher-side primitive. It owns a set of
 * listeners; `fire(value)` invokes each one via `safelyCallListener` so
 * listener exceptions route through `onUnexpectedError` (plan §1.6 / §2.5)
 * instead of being swallowed or aborting the fire loop. `dispose()` clears
 * the listener set and makes subsequent `fire()` calls no-op while
 * `event(...)` returns `Disposable.None`.
 *
 * Storage uses a `Set<Listener>` for simplicity — VSCode's `LinkedList` is
 * a perf optimisation that isn't load-bearing for the daemon-scale services
 * touched in this phase. Documented in STATUS Decisions.
 */

import { onUnexpectedError, safelyCallListener } from '../../errors/unexpectedError';
import { Disposable, DisposableStore, type IDisposable } from '../../di/lifecycle';

/**
 * Subscriber-side event signature. Calling the event subscribes a listener;
 * the returned `IDisposable` removes it on `dispose()`.
 *
 * The optional `disposables` collector pushes the returned subscription
 * disposable into either an array or a `DisposableStore` so callers can
 * batch-cleanup multiple subscriptions through a single owner.
 */
export interface Event<T> {
  (
    listener: (e: T) => unknown,
    thisArg?: unknown,
    disposables?: IDisposable[] | DisposableStore,
  ): IDisposable;
}

interface ListenerEntry<T> {
  listener: (e: T) => unknown;
  thisArg: unknown;
}

/**
 * Publisher-side emitter. Construct an instance, expose `emitter.event` as
 * the public `Event<T>` surface, and call `emitter.fire(value)` to deliver
 * the value to every subscribed listener.
 */
export class Emitter<T> {
  private _listeners: Set<ListenerEntry<T>> | undefined;
  private _disposed = false;
  private _event: Event<T> | undefined;

  /**
   * Public `Event<T>` surface. Each call subscribes a new listener.
   */
  get event(): Event<T> {
    if (this._event === undefined) {
      this._event = (listener, thisArg, disposables) => {
        if (this._disposed) {
          return Disposable.None;
        }
        if (this._listeners === undefined) {
          this._listeners = new Set();
        }
        const entry: ListenerEntry<T> = { listener, thisArg };
        this._listeners.add(entry);

        let removed = false;
        const subscription: IDisposable = {
          dispose: () => {
            if (removed) return;
            removed = true;
            if (this._disposed) return;
            this._listeners?.delete(entry);
          },
        };

        if (disposables !== undefined) {
          if (disposables instanceof DisposableStore) {
            disposables.add(subscription);
          } else {
            disposables.push(subscription);
          }
        }
        return subscription;
      };
    }
    return this._event;
  }

  /**
   * Deliver `value` to every subscribed listener. Each listener invocation
   * is wrapped via `safelyCallListener`, so a throwing listener does not
   * interrupt siblings — the exception is routed through `onUnexpectedError`.
   *
   * A snapshot of the listener set is taken before iteration so listeners
   * adding/removing themselves during `fire` don't corrupt the loop.
   */
  fire(value: T): void {
    if (this._disposed || this._listeners === undefined) {
      return;
    }
    const snapshot = Array.from(this._listeners);
    for (const entry of snapshot) {
      safelyCallListener(() => {
        entry.listener.call(entry.thisArg, value);
      });
    }
  }

  /**
   * Dispose the emitter: clear all listeners. Subsequent `fire()` calls
   * are no-ops; subsequent `event(...)` subscriptions return
   * `Disposable.None`. Idempotent.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._listeners?.clear();
    this._listeners = undefined;
  }

  /**
   * True iff `dispose()` has been called.
   */
  get isDisposed(): boolean {
    return this._disposed;
  }
}

/**
 * `Event` namespace — helpers for transforming and composing events.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Event {
  /**
   * A non-firing event. Subscribing returns `Disposable.None`.
   */
  export const None: Event<unknown> = () => Disposable.None;

  /**
   * Wrap an event so the first fire delivers to the listener and then
   * disposes the subscription automatically.
   */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener, thisArg, disposables) => {
      let fired = false;
      const subscription = event(
        (e) => {
          if (fired) return;
          fired = true;
          // Dispose first so the listener can re-fire safely if it
          // synchronously triggers the same emitter.
          subscription.dispose();
          try {
            listener.call(thisArg, e);
          } catch (err) {
            onUnexpectedError(err);
          }
        },
        undefined,
        disposables,
      );
      // Edge case: if `event` is `Event.None` (already returned
      // Disposable.None) the subscription handle is harmless.
      return subscription;
    };
  }

  /**
   * Project values of one event through `map` to produce another.
   */
  export function map<I, O>(event: Event<I>, map: (i: I) => O): Event<O> {
    return (listener, thisArg, disposables) =>
      event(
        (i) => listener.call(thisArg, map(i)),
        undefined,
        disposables,
      );
  }

  /**
   * Drop values that don't pass `filter`.
   */
  export function filter<T>(event: Event<T>, filter: (e: T) => boolean): Event<T> {
    return (listener, thisArg, disposables) =>
      event(
        (e) => {
          if (filter(e)) listener.call(thisArg, e);
        },
        undefined,
        disposables,
      );
  }

  /**
   * Merge multiple events into one — any source firing fires the combined.
   */
  export function any<T>(...events: Event<T>[]): Event<T> {
    return (listener, thisArg, disposables) => {
      const subs = events.map((e) => e((value) => listener.call(thisArg, value)));
      const combined: IDisposable = {
        dispose: () => {
          for (const s of subs) {
            try {
              s.dispose();
            } catch (err) {
              onUnexpectedError(err);
            }
          }
        },
      };
      if (disposables !== undefined) {
        if (disposables instanceof DisposableStore) {
          disposables.add(combined);
        } else {
          disposables.push(combined);
        }
      }
      return combined;
    };
  }
}
