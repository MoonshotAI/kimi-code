import type { Writable } from 'node:stream';

import { HEADLESS_FORCE_EXIT_GRACE_MS, HEADLESS_STDIO_DRAIN_TIMEOUT_MS } from '#/constant/app';

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

/** Resolve once a stream's currently-buffered writes have flushed to its sink. */
function flushStream(stream: Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      // An empty write's callback fires after all previously-queued writes have
      // been flushed (writes are ordered), which is the documented way to know a
      // stream's buffer has drained.
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Wait for buffered output on the given streams to flush, bounded by `timeoutMs`.
 *
 * A slow or piped consumer that hasn't read all of stdout/stderr yet leaves the
 * pipe as a legitimate ref'd handle keeping the loop alive. Flushing before any
 * force-exit prevents truncating output from an otherwise-successful run. The
 * wait is bounded so a permanently-stuck consumer can't re-introduce the hang.
 */
export async function drainStdio(
  streams: readonly Writable[],
  timeoutMs: number = HEADLESS_STDIO_DRAIN_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all(streams.map(flushStream)).then(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Finalize a completed headless run: flush stdio, then arm the force-exit
 * backstop.
 *
 * Draining first means in-flight legitimate output is fully written before the
 * backstop can fire, and — since drained stdio no longer holds the loop — only a
 * genuinely leaked handle can keep it alive afterwards, which is exactly what
 * the backstop is for.
 */
export async function finalizeHeadlessRun(
  proc: ExitableProcess,
  streams: readonly Writable[],
  getExitCode: () => number,
  options: { drainTimeoutMs?: number; graceMs?: number } = {},
): Promise<void> {
  await drainStdio(streams, options.drainTimeoutMs ?? HEADLESS_STDIO_DRAIN_TIMEOUT_MS);
  scheduleHeadlessForceExit(proc, getExitCode, options.graceMs);
}
