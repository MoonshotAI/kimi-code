/**
 * Timeout outcome promise — resolves with a fixed value after a delay.
 */

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

/**
 * Keyed promise-chain exclusion over a shared `id → tail promise` map: `op`
 * runs after every previously enqueued operation for `id` settles, a
 * rejection does not poison later operations for the same key, and the map
 * entry is dropped once the queue drains.
 */
export function enqueueKeyedOperation<T>(
  queues: Map<string, Promise<void>>,
  id: string,
  op: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const result = previous.then(op);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(id, tail);
  return result.finally(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
}
