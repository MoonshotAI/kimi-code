import { closeSync, openSync, readSync } from 'node:fs';

export interface ClockSources {
  wallNow(): number;

  monoNowMs(): number;
}

export function resolveClockSources(
  spec: string | undefined,
  debug: boolean,
  system: ClockSources,
): ClockSources {
  if (spec === undefined || spec === '' || spec === 'system') {
    return system;
  }

  if (spec.startsWith('file:')) {
    const filePath = spec.slice('file:'.length);
    if (filePath === '') {
      debugInvalidSpec(spec, 'empty file path', debug);
      return system;
    }
    return {
      wallNow: () => readFileWall(filePath, system.wallNow),
      monoNowMs: system.monoNowMs,
    };
  }

  debugInvalidSpec(spec, 'unrecognised scheme', debug);
  return system;
}

const MAX_CLOCK_FILE_BYTES = 64;

function readFileWall(filePath: string, fallback: () => number): number {
  let bytesRead = 0;
  const buf = Buffer.alloc(MAX_CLOCK_FILE_BYTES);
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return fallback();
  }
  try {
    bytesRead = readSync(fd, buf, 0, MAX_CLOCK_FILE_BYTES, 0);
  } catch {
    return fallback();
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
  const raw = buf.subarray(0, bytesRead).toString('utf8');
  const firstLine = raw.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return fallback();
  const parsed = Number(firstLine);
  if (!Number.isFinite(parsed)) return fallback();
  return parsed;
}

function debugInvalidSpec(spec: string, reason: string, debug: boolean): void {
  if (debug) {
    process.stderr.write(
      `[cron/clock] invalid KIMI_CRON_CLOCK spec ${JSON.stringify(spec)}: ${reason} — falling back to system clock\n`,
    );
  }
}
