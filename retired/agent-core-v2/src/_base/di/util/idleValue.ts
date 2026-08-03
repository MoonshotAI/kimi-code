/**
 * `di` domain (L0) — `GlobalIdleValue` lazy-initializer backing delayed DI services.
 */

import type { IDisposable } from '../lifecycle';

interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

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
    let disposed = false;
    const handle = setTimeout(() => {
      if (disposed) {
        return;
      }
      const end = Date.now() + 15;
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
