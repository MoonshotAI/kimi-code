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
 * the simulated day. Every component in `tools/cron/` MUST take a
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
  /**
   * Wall-clock epoch milliseconds. May be overridden in tests / bench
   * via `KIMI_CRON_CLOCK`. Used for cron matching, `createdAt`, stale
   * judgment.
   */
  wallNow(): number;

  /**
   * Strictly monotonic millisecond counter. Never overridden. Used for
   * the 1-second poll cadence and the lock-heartbeat liveness window.
   */
  monoNowMs(): number;
}

const systemMonoNowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * Production default — `Date.now()` + `process.hrtime.bigint()`. Used
 * whenever `KIMI_CRON_CLOCK` is unset, set to `"system"`, or set to a
 * spec that fails to parse.
 */
export const SYSTEM_CLOCKS: ClockSources = {
  wallNow: () => Date.now(),
  monoNowMs: systemMonoNowMs,
};

/**
 * Resolve a `ClockSources` implementation from a spec string (typically
 * `process.env.KIMI_CRON_CLOCK`).
 *
 *   unset / `"system"`   → {@link SYSTEM_CLOCKS}
 *   `"file:<path>"`      → `wallNow` reads the first line of `<path>`
 *                          on every call (sync — the tick path is not
 *                          async) and parses it as `Number(...)`. A
 *                          missing file or bad parse falls back to
 *                          `Date.now()` for that call. Used so a
 *                          multi-process bench can share a single
 *                          file-backed simulated clock.
 *
 * `monoNowMs` ALWAYS uses `process.hrtime.bigint()`. No spec overrides
 * it — see file header.
 *
 * Each `wallNow()` call re-reads its source. We deliberately do NOT
 * cache, because a multi-process bench tick mutating the file must be
 * picked up by every reader immediately; a cache would silently lock
 * each process to its first observation.
 *
 * Unrecognised specs fall back to {@link SYSTEM_CLOCKS} (with a
 * debug-log on stderr). This is deliberate — bricking the agent on a
 * typoed bench env var would be worse than running with system time.
 */
export function resolveClockSources(spec?: string): ClockSources {
  if (spec === undefined || spec === '' || spec === 'system') {
    return SYSTEM_CLOCKS;
  }

  if (spec.startsWith('file:')) {
    const filePath = spec.slice('file:'.length);
    if (filePath === '') {
      debugInvalidSpec(spec, 'empty file path');
      return SYSTEM_CLOCKS;
    }
    return {
      wallNow: () => readFileWall(filePath),
      monoNowMs: systemMonoNowMs,
    };
  }

  debugInvalidSpec(spec, 'unrecognised scheme');
  return SYSTEM_CLOCKS;
}

// Epoch-ms is always under 20 characters in practice; 64 bytes leaves
// slack for a leading newline / `\r` and prevents OOM on a hostile or
// accidentally-huge clock file (e.g. a `/dev/zero` redirect).
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
      /* swallow close errors */
    }
  }
  const raw = buf.subarray(0, bytesRead).toString('utf8');
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return Date.now();
  const parsed = Number(firstLine);
  if (!Number.isFinite(parsed)) return Date.now();
  return parsed;
}

function debugInvalidSpec(spec: string, reason: string): void {
  // We do not pull in a logger here — `clock.ts` is the lowest layer of
  // the cron module and must stay dependency-free so it can be imported
  // from anywhere (including lint rules, type files). A stderr write
  // gated on KIMI_CRON_DEBUG is enough — production is silent.
  if (process.env['KIMI_CRON_DEBUG'] === '1') {
    process.stderr.write(
      `[cron/clock] invalid KIMI_CRON_CLOCK spec ${JSON.stringify(spec)}: ${reason} — falling back to system clock\n`,
    );
  }
}
