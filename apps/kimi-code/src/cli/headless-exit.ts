import { HEADLESS_FORCE_EXIT_GRACE_MS } from '#/constant/app';

/** Minimal process surface needed to force a headless run to terminate. */
export interface ExitableProcess {
  exit(code?: number): void;
}

/**
 * Schedule a best-effort force-exit for a completed headless (`kimi -p`) run.
 *
 * Print mode does not call `process.exit()`; it relies on the Node event loop
 * draining once the run is done. If a stray ref'd handle survives shutdown — a
 * lingering socket (e.g. a connection blackholed by a restrictive firewall, or
 * an HTTP/2 session kept alive by PING), an un-cleared timer, or a child whose
 * pipes stay open — the loop never empties and the process hangs until an
 * external timeout kills it.
 *
 * This arms an **unref'd** fallback timer: a healthy run drains and exits
 * naturally before it fires (so behaviour is unchanged), and the timer itself
 * never keeps the loop alive. It only force-exits a run whose loop is already
 * wedged. The exit code is read lazily at fire time so callers may set
 * `process.exitCode` after scheduling (e.g. a goal turn mapping its terminal
 * status to a non-zero code).
 *
 * Returns the timer handle so callers/tests can `clearTimeout` it.
 */
export function scheduleHeadlessForceExit(
  proc: ExitableProcess,
  getExitCode: () => number,
  graceMs: number = HEADLESS_FORCE_EXIT_GRACE_MS,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    proc.exit(getExitCode());
  }, graceMs);
  timer.unref?.();
  return timer;
}
