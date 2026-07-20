/**
 * `os` test stubs — shared cross-process-lock pass-through for unit tests.
 *
 * `stubCrossProcessLock()` mirrors the real service's mutual-exclusion
 * semantics (a held path rejects further acquisitions) without touching the
 * filesystem, for tests whose suite is otherwise fully in-memory. Lives under
 * `test/` (not `src/`) so test-support code stays out of the production tree.
 * Import from a relative path (`./stubs` or `../os/stubs`).
 */

import {
  CrossProcessLockError,
  CrossProcessLockErrorCode,
  type CrossProcessLockInspection,
  type ICrossProcessLockHandle,
  type ICrossProcessLockService,
} from '#/os/interface/crossProcessLock';

export function stubCrossProcessLock(): ICrossProcessLockService {
  const held = new Set<string>();
  const acquireHandle = (lockPath: string): ICrossProcessLockHandle => {
    if (held.has(lockPath)) {
      throw new CrossProcessLockError(
        CrossProcessLockErrorCode.Held,
        `cross-process lock unavailable (held): ${lockPath}`,
        { details: { path: lockPath, reason: 'held' } },
      );
    }
    held.add(lockPath);
    let released = false;
    return {
      lockPath,
      lockId: 'stub-lock',
      checkHeld: () => !released,
      update: () => {},
      release: () => {
        if (released) return;
        released = true;
        held.delete(lockPath);
      },
    };
  };
  return {
    _serviceBrand: undefined,
    acquire: (lockPath) => Promise.resolve(acquireHandle(lockPath)),
    acquireWithWait: (lockPath) => Promise.resolve(acquireHandle(lockPath)),
    withLock: async <T>(
      lockPath: string,
      _options: Parameters<ICrossProcessLockService['withLock']>[1],
      fn: (handle: ICrossProcessLockHandle) => T | Promise<T>,
    ): Promise<T> => {
      const handle = acquireHandle(lockPath);
      try {
        return await fn(handle);
      } finally {
        handle.release();
      }
    },
    inspect: (lockPath): CrossProcessLockInspection =>
      held.has(lockPath) ? { state: 'held' } : { state: 'free' },
  };
}
