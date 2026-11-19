import { WaitTimeoutError } from '#/errors';
import { TIMEOUTS } from '#/fixtures/timeouts';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(reason: Error): void;
}

export function deferred<T = void>(): Deferred<T> {
  let settled = false;
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
  };
}

export interface Gate {
  readonly isOpen: boolean;
  wait(): Promise<void>;
  open(): void;
}

export function gate(): Gate {
  const opened = deferred();
  return {
    get isOpen() {
      return opened.settled;
    },
    wait: () => opened.promise,
    open: () => opened.resolve(),
  };
}

export interface UntilOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

type NotReady = undefined | null | false;

export async function until<T>(
  label: string,
  check: () => T | Promise<T>,
  options: UntilOptions = {},
): Promise<Exclude<T, NotReady>> {
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.wait;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) return value as Exclude<T, NotReady>;
      lastValue = value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const last = lastError === undefined ? `last value: ${describeValue(lastValue)}` : `last error: ${describeValue(lastError)}`;
      throw new WaitTimeoutError(`Timed out after ${timeoutMs} ms waiting for ${label} (${last})`, { cause: lastError });
    }
    await sleep(intervalMs);
  }
}

export interface EventWaitOptions {
  readonly timeoutMs: number;
  readonly describe: () => string;
}

export type Subscribe<T> = (settle: (value: T) => void, fail: (error: Error) => void) => () => void;

export function waitForEvent<T>(subscribe: Subscribe<T>, options: EventWaitOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      reject(new WaitTimeoutError(`Timed out after ${options.timeoutMs} ms waiting for ${options.describe()}`));
    }, options.timeoutMs);
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      return true;
    };
    unsubscribe = subscribe(
      (value) => {
        if (finish()) resolve(value);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
    if (done) unsubscribe();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
