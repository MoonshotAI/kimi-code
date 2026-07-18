/**
 * `event` domain (L0) — `Event` / `Emitter` primitives, the async
 * `AsyncEmitter` / `IWaitUntil` participation primitive (for interceptable
 * `onWill` events whose listeners register work via `waitUntil`), the
 * `handleVetos` helper (for `onBefore*` veto events whose listeners answer
 * with `veto(value, id)`), and event combinators (`once` / `map` / `filter`
 * / `any`).
 */

import { onUnexpectedError, safelyCallListener } from './errors/unexpectedError';
import {
  Disposable,
  DisposableStore,
  combinedDisposable,
  type IDisposable,
} from './di/lifecycle';
import { LinkedList } from './di/util/linkedList';

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

export class Emitter<T> {
  protected _listeners: Set<ListenerEntry<T>> | undefined;
  private _disposed = false;
  private _event: Event<T> | undefined;

  get event(): Event<T> {
    this._event ??= (listener, thisArg, disposables) => {
      if (this._disposed) {
        return Disposable.None;
      }
      this._listeners ??= new Set();
      const entry: ListenerEntry<T> = { listener, thisArg };
      this._listeners.add(entry);

      let removed = false;
      const subscription: IDisposable = {
        dispose: () => {
          if (removed) return;
          removed = true;
          if (this._disposed) {
            return;
          }
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
    return this._event;
  }

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

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._listeners?.clear();
    this._listeners = undefined;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }
}

export interface IWaitUntil {
  readonly signal: AbortSignal;
  waitUntil(thenable: Promise<unknown>): void;
}

export type IWaitUntilData<T> = Omit<T, 'waitUntil' | 'signal'>;

export class AsyncEmitter<T extends IWaitUntil> extends Emitter<T> {
  private _asyncDeliveryQueue?: LinkedList<[(event: T) => void, IWaitUntilData<T>]>;

  async fireAsync(data: IWaitUntilData<T>, signal: AbortSignal): Promise<void> {
    if (this.isDisposed || this._listeners === undefined) {
      return;
    }

    this._asyncDeliveryQueue ??= new LinkedList();
    for (const entry of this._listeners) {
      this._asyncDeliveryQueue.push([
        (event) => {
          entry.listener.call(entry.thisArg, event);
        },
        data,
      ]);
    }

    while (this._asyncDeliveryQueue.size > 0 && !signal.aborted) {
      const [deliver, eventData] = this._asyncDeliveryQueue.shift()!;
      const thenables: Promise<unknown>[] = [];

      const event = {
        ...eventData,
        signal,
        waitUntil: (p: Promise<unknown>): void => {
          if (Object.isFrozen(thenables)) {
            throw new Error('waitUntil can NOT be called asynchronously');
          }
          thenables.push(p);
        },
      } as T;

      try {
        deliver(event);
      } catch (error) {
        onUnexpectedError(error);
        continue;
      }

      void Object.freeze(thenables);
      const settled = await Promise.allSettled(thenables);
      for (const result of settled) {
        if (result.status === 'rejected') {
          onUnexpectedError(result.reason);
        }
      }
    }
  }
}

export function handleVetos(
  vetos: (boolean | Promise<boolean>)[],
  onError: (error: unknown) => void,
): Promise<boolean> {
  if (vetos.length === 0) {
    return Promise.resolve(false);
  }

  const promises: Promise<void>[] = [];
  let lazyValue = false;

  for (const valueOrPromise of vetos) {
    if (valueOrPromise === true) {
      return Promise.resolve(true);
    }
    if (typeof valueOrPromise === 'boolean') {
      continue;
    }
    promises.push(
      valueOrPromise.then(
        (value) => {
          if (value) {
            lazyValue = true;
          }
        },
        (error) => {
          onError(error);
          lazyValue = true;
        },
      ),
    );
  }

  return Promise.allSettled(promises).then(() => lazyValue);
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Event {
  export const None: Event<unknown> = () => Disposable.None;

  export function once<T>(event: Event<T>): Event<T> {
    return (listener, thisArg, disposables) => {
      let fired = false;
      const subscription = event(
        (e) => {
          if (fired) return;
          fired = true;
          subscription.dispose();
          try {
            listener.call(thisArg, e);
          } catch (error) {
            onUnexpectedError(error);
          }
        },
        undefined,
        disposables,
      );
      return subscription;
    };
  }

  export function map<I, O>(event: Event<I>, map: (i: I) => O): Event<O> {
    return (listener, thisArg, disposables) =>
      event(
        (i) => listener.call(thisArg, map(i)),
        undefined,
        disposables,
      );
  }

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

  export function any<T>(...events: Event<T>[]): Event<T> {
    return (listener, thisArg, disposables) => {
      const combined = combinedDisposable(
        ...events.map((e) => e((value) => listener.call(thisArg, value))),
      );
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
