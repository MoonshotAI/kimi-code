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

export async function raceOutcome(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<'done' | 'timeout'> {
  const expiry = timeoutOutcome(timeoutMs, 'timeout' as const);
  try {
    return await Promise.race([work.then(() => 'done' as const), expiry]);
  } finally {
    expiry.clear();
  }
}
