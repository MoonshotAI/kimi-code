import { setClampedTimeout } from './timer';

const NEVER = new Promise<never>(() => {});

export class AsyncSerialQueue {
  constructor(private tail: Promise<void> = Promise.resolve()) {}

  get settled(): Promise<void> {
    return this.tail;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export type TimeoutOutcomePromise<Outcome> = Promise<Outcome> & {
  clear(): void;
};

export function timeoutOutcome<Outcome>(
  timeoutMs: number | undefined,
  outcome: Outcome,
): TimeoutOutcomePromise<Outcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise: Promise<Outcome> =
    timeoutMs === undefined || timeoutMs <= 0
      ? NEVER
      : new Promise((resolve) => {
          timeout = setClampedTimeout(() => {
            timeout = undefined;
            resolve(outcome);
          }, timeoutMs);
        });

  return Object.assign(promise, {
    clear() {
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
    },
  });
}
