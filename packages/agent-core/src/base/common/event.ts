import { onUnexpectedError, safelyCallListener } from '../../errors/unexpectedError';
import {
  Disposable,
  DisposableStore,
  combinedDisposable,
  type IDisposable,
} from '../../di/lifecycle';

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
  private _listeners: Set<ListenerEntry<T>> | undefined;
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
