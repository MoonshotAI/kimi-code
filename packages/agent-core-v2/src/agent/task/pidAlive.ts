/**
 * Liveness probe for persisted task pids.
 *
 * Task records keep the OS pid of the process they started, so a ghost task
 * restored from disk can be checked against the running system before it is
 * reclassified. Mirrors the probe the server-side instance registry uses
 * (`packages/kap-server/src/instanceRegistry.ts`).
 */

/** `process.kill(pid, 0)` probe — true if the pid exists, false on ESRCH. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM = process exists but we can't signal it (different user). Treat as alive.
    if (code === 'EPERM') return true;
    // Anything else: be safe, assume alive so we don't clobber a live task.
    return true;
  }
}
