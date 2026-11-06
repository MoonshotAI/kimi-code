export const AUTH_RATE_LIMIT_CODE = 42901;
export const AUTH_RATE_LIMIT_MSG = 'Too many failed auth attempts';

export interface AuthFailureLimiterOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly banMs?: number;
  readonly logger?: { warn(obj: unknown, msg: string): void };
}

export interface AuthFailureLimiter {
  recordFailure(ip: string): void;
  isBanned(ip: string): boolean;
  reserve(ip: string): (() => void) | undefined;
  dispose(): void;
}

interface Entry {
  count: number;
  windowStart: number;
  bannedUntil: number;
  pending: number;
}

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BAN_MS = 60_000;

export function createAuthFailureLimiter(
  opts?: AuthFailureLimiterOptions,
): AuthFailureLimiter {
  const maxFailures = opts?.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const banMs = opts?.banMs ?? DEFAULT_BAN_MS;
  const entries = new Map<string, Entry>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of entries) {
      const banned = entry.bannedUntil > now;
      const windowLive = now - entry.windowStart <= windowMs;
      if (!banned && !windowLive && entry.pending === 0) {
        entries.delete(ip);
      }
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') {
    sweep.unref();
  }

  function currentEntry(ip: string, now: number): Entry {
    const entry = entries.get(ip);
    if (entry === undefined) {
      const fresh = { count: 0, windowStart: now, bannedUntil: 0, pending: 0 };
      entries.set(ip, fresh);
      return fresh;
    }
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
      entry.bannedUntil = 0;
    }
    return entry;
  }

  return {
    recordFailure(ip: string): void {
      const now = Date.now();
      const entry = currentEntry(ip, now);
      entry.count += 1;
      if (entry.count >= maxFailures) {
        const wasBanned = entry.bannedUntil > now;
        entry.bannedUntil = now + banMs;
        if (!wasBanned) {
          opts?.logger?.warn(
            { ip, bannedUntil: entry.bannedUntil },
            'too many failed auth attempts; source temporarily banned',
          );
        }
      }
    },
    isBanned(ip: string): boolean {
      const entry = entries.get(ip);
      if (entry === undefined) return false;
      return entry.bannedUntil > Date.now();
    },
    reserve(ip: string): (() => void) | undefined {
      const now = Date.now();
      const entry = currentEntry(ip, now);
      if (entry.bannedUntil > now || entry.count + entry.pending >= maxFailures) return undefined;
      entry.pending += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.pending -= 1;
      };
    },
    dispose(): void {
      clearInterval(sweep);
      entries.clear();
    },
  };
}
