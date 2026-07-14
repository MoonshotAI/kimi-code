/**
 * Clock sources for the cron scheduler.
 *
 * Two distinct notions of time are kept apart on purpose:
 *
 *   1. wall-clock — what the user perceives as "the current time". Used
 *      for cron expression matching, `createdAt`, and the 7-day stale
 *      judgment. May be overridden in tests / multi-process benches so
 *      that scenarios can run in simulated time without `setTimeout`.
 *
 *   2. monotonic ms — a strictly non-decreasing counter that never
 *      jumps backwards across NTP adjustments, suspend/resume, or
 *      simulated-clock injection. Used for the poll cadence and the
 *      lock heartbeat — anything where "did 5 seconds elapse since we
 *      last looked" must hold even when the wall clock is frozen.
 *
 * Mixing the two pollutes test reproducibility: a heartbeat tied to
 * `wallNow()` will appear stuck when the test clock is frozen; a cron
 * fire tied to `monoNowMs()` will not advance when the bench rewinds
 * the simulated day. Every component in the cron domain MUST take a
 * `ClockSources` and route every time read through it.
 *
 * `monoNowMs` is ALWAYS `process.hrtime.bigint()` (converted to ms).
 * It is not overridable — accepting an external monotonic clock would
 * defeat the safety net the lock heartbeat depends on.
 *
 * `wallNow` resolution is driven by the `KIMI_CRON_CLOCK` env var; see
 * `resolveClockSources` below. Defaults to `Date.now()`.
 */
import { closeSync, openSync, readSync } from 'node:fs';

export interface ClockSources {
  wallNow(): number;

  monoNowMs(): number;
}

const systemMonoNowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

export const SYSTEM_CLOCKS: ClockSources = {
  wallNow: () => Date.now(),
  monoNowMs: systemMonoNowMs,
};

export function resolveClockSources(spec?: string, debug = false): ClockSources {
  if (spec === undefined || spec === '' || spec === 'system') {
    return SYSTEM_CLOCKS;
  }

  if (spec.startsWith('file:')) {
    const filePath = spec.slice('file:'.length);
    if (filePath === '') {
      debugInvalidSpec(spec, 'empty file path', debug);
      return SYSTEM_CLOCKS;
    }
    return {
      wallNow: () => readFileWall(filePath),
      monoNowMs: systemMonoNowMs,
    };
  }

  debugInvalidSpec(spec, 'unrecognised scheme', debug);
  return SYSTEM_CLOCKS;
}

const MAX_CLOCK_FILE_BYTES = 64;

function readFileWall(filePath: string): number {
  let bytesRead = 0;
  const buf = Buffer.alloc(MAX_CLOCK_FILE_BYTES);
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return Date.now();
  }
  try {
    bytesRead = readSync(fd, buf, 0, MAX_CLOCK_FILE_BYTES, 0);
  } catch {
    return Date.now();
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
  const raw = buf.subarray(0, bytesRead).toString('utf8');
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return Date.now();
  const parsed = Number(firstLine);
  if (!Number.isFinite(parsed)) return Date.now();
  return parsed;
}

function debugInvalidSpec(spec: string, reason: string, debug: boolean): void {
  if (debug) {
    process.stderr.write(
      `[cron/clock] invalid KIMI_CRON_CLOCK spec ${JSON.stringify(spec)}: ${reason} — falling back to system clock\n`,
    );
  }
}
