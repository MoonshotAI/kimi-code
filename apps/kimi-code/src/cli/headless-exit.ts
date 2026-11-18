import type { Writable } from 'node:stream';

import { HEADLESS_FORCE_EXIT_GRACE_MS, HEADLESS_STDIO_DRAIN_TIMEOUT_MS } from '#/constant/app';

export interface ExitableProcess {
  exit(code?: number): void;
}

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

function flushStream(stream: Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

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

export async function finalizeHeadlessRun(
  proc: ExitableProcess,
  streams: readonly Writable[],
  getExitCode: () => number,
  options: { drainTimeoutMs?: number; graceMs?: number } = {},
): Promise<void> {
  await drainStdio(streams, options.drainTimeoutMs ?? HEADLESS_STDIO_DRAIN_TIMEOUT_MS);
  scheduleHeadlessForceExit(proc, getExitCode, options.graceMs);
}
