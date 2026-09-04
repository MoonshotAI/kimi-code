/**
 * `process.kill(pid, 0)` liveness probe for a persisted task pid. True if the
 * pid exists, false on `ESRCH`. `EPERM` (process exists, different owner) and
 * any other errno report alive, so an ambiguous probe never causes a live
 * task to be reclassified as lost. Mirrors the probe in
 * `packages/kap-server/src/instanceRegistry.ts`.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}
