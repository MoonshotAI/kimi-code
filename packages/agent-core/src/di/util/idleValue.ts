/**
 * `GlobalIdleValue<T>` — defers an executor until the first `value` access
 * (or the next browser idle callback / `setTimeout` fallback). Used by
 * `InstantiationService._createServiceInstance` to back
 * `supportsDelayedInstantiation: true` services: the Proxy returned to
 * callers triggers `idle.value` on first non-`onDid*` access, which runs
 * the real construction.
 *
 * Vendored from krow `packages/core/src/base/async.ts:57-97` (which is the
 * VSCode original). Node-safe: falls back to `setTimeout` when
 * `requestIdleCallback` is unavailable (the typical Node environment).
 *
 * Only `GlobalIdleValue` is exported — `runWhenGlobalIdle` is internal to
 * this module because the DI subsystem is the only consumer; if another
 * package later needs it, lift it then.
 */

import type { IDisposable } from '../lifecycle';

interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

/**
 * Run `callback` the next time the host is idle. Returns a disposable that
 * cancels the pending callback if disposed before it fires. Uses
 * `requestIdleCallback` when available; otherwise schedules a `setTimeout`
 * polyfill that simulates a one-frame deadline (15 ms).
 */
function runWhenGlobalIdle(
  callback: (idle: IdleDeadline) => void,
  timeout?: number,
): IDisposable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeGlobal: any = globalThis;

  if (
    typeof safeGlobal.requestIdleCallback === 'function' &&
    typeof safeGlobal.cancelIdleCallback === 'function'
  ) {
    const handle: number = safeGlobal.requestIdleCallback(
      callback,
      typeof timeout === 'number' ? { timeout } : undefined,
    );
    let disposed = false;
    return {
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        safeGlobal.cancelIdleCallback(handle);
      },
    };
  } else {
    // Polyfill for environments without requestIdleCallback (e.g. Node.js).
    let disposed = false;
    const handle = setTimeout(() => {
      if (disposed) {
        return;
      }
      const end = Date.now() + 15; // one frame at ~64fps
      const deadline: IdleDeadline = {
        didTimeout: true,
        timeRemaining() {
          return Math.max(0, end - Date.now());
        },
      };
      callback(Object.freeze(deadline));
    });
    return {
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        clearTimeout(handle);
      },
    };
  }
}

/**
 * Lazy box around an executor `() => T`. The executor is scheduled to run on
 * the next idle tick, but reading `.value` BEFORE the idle tick fires
 * cancels the schedule and runs the executor synchronously — then caches
 * the result (or rethrows the captured error) on every subsequent access.
 *
 * `isInitialized` lets the Proxy distinguish "real instance exists" from
 * "still pending" so `onDid*`/`onWill*` event subscriptions can be parked
 * in an early-listener list and replayed on materialisation.
 */
export class GlobalIdleValue<T> {
  private readonly _executor: () => void;
  private readonly _handle: IDisposable;

  private _didRun: boolean = false;
  private _value?: T;
  private _error: unknown;

  constructor(executor: () => T) {
    this._executor = () => {
      try {
        this._value = executor();
      } catch (err) {
        this._error = err;
      } finally {
        this._didRun = true;
      }
    };
    this._handle = runWhenGlobalIdle(() => this._executor());
  }

  dispose(): void {
    this._handle.dispose();
  }

  get value(): T {
    if (!this._didRun) {
      this._handle.dispose();
      this._executor();
    }
    if (this._error) {
      if (this._error instanceof Error) {
        throw this._error;
      }
      throw new Error('Lazy value initialization failed');
    }
    return this._value!;
  }

  get isInitialized(): boolean {
    return this._didRun;
  }
}
