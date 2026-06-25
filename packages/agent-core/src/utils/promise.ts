const NEVER = new Promise<never>(() => {});

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
          timeout = setTimeout(() => {
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

export type ResettableTimeoutPromise<Outcome> = Promise<Outcome> & {
  /** Restart the timer from now with a new duration; the same promise resolves when it fires. */
  reset(timeoutMs: number | undefined): void;
  clear(): void;
};

/**
 * Like `timeoutOutcome`, but the timer can be restarted via `reset()` while the
 * returned promise stays the same — so a `Promise.race` that already captured it
 * observes the new deadline. Used to extend a task's timeout (e.g. when a
 * foreground command is detached to the background).
 */
export function resettableTimeoutOutcome<Outcome>(
  initialMs: number | undefined,
  outcome: Outcome,
): ResettableTimeoutPromise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (value: Outcome) => void;
  const promise = new Promise<Outcome>((resolve) => {
    resolvePromise = resolve;
  });
  const clear = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const reset = (timeoutMs: number | undefined): void => {
    clear();
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      resolvePromise(outcome);
    }, timeoutMs);
  };
  reset(initialMs);
  return Object.assign(promise, { reset, clear });
}
