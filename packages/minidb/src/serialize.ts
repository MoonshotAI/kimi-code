// src/serialize.ts
//
// A promise-chain mutex, extracted from what used to be two private copies of
// the same pattern (MiniDb.withUniqueWriteLock, LockFile.serialized): each
// queued function's whole body — across every await — completes before the
// next one starts, in issue order. Mutual exclusion for async critical
// sections without blocking the event loop.
//
// Current users: the LockFile lifecycle ops (acquire/renew/release), the
// unique-index write path, and the per-sidecar index-definition mutation
// chains (plan 10).
//
// Internal to the package — NOT re-exported from the root entry point.

/** Create a serializing executor: functions submitted to it run strictly one
 *  at a time, in submission order. The executor itself never rejects; each
 *  call settles with its own function's result or error. */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return async function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let done!: () => void;
    chain = new Promise<void>((resolve) => {
      done = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      done();
    }
  };
}
