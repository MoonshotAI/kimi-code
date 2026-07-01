/**
 * Auth-failure rate limiter for non-loopback auth.
 */

export const AUTH_RATE_LIMIT_CODE = 42901;
export const AUTH_RATE_LIMIT_MSG = 'Too many failed auth attempts';

export interface AuthFailureLimiterOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly banMs?: number;
}

export interface AuthFailureLimiter {
  recordFailure(ip: string): void;
  isBanned(ip: string): boolean;
  dispose(): void;
}

interface Entry {
  count: number;
  windowStart: number;
  bannedUntil: number;
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
      if (!banned && !windowLive) {
        entries.delete(ip);
      }
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') {
    sweep.unref();
  }

  return {
    recordFailure(ip: string): void {
      const now = Date.now();
      let entry = entries.get(ip);
      if (entry === undefined || now - entry.windowStart > windowMs) {
        entry = { count: 0, windowStart: now, bannedUntil: 0 };
        entries.set(ip, entry);
      }
      entry.count += 1;
      if (entry.count >= maxFailures) {
        entry.bannedUntil = now + banMs;
      }
    },
    isBanned(ip: string): boolean {
      const entry = entries.get(ip);
      if (entry === undefined) return false;
      return entry.bannedUntil > Date.now();
    },
    dispose(): void {
      clearInterval(sweep);
      entries.clear();
    },
  };
}
