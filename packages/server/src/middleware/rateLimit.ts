/**
 * Auth-failure rate limiter (ROADMAP M6.4).
 *
 * A per-`remoteAddress` failure counter that temporarily bans a source after
 * too many failed authentication attempts. Wired into `createAuthHook` only on
 * non-loopback binds (`start.ts`), so the loopback default keeps its existing
 * "no rate limit" behavior while a public/LAN bind slows brute-force attempts.
 *
 * Policy: a source is banned when it accumulates `maxFailures` failures within
 * a sliding `windowMs` window; the ban lasts `banMs`. Once banned, every
 * request from that source is rejected with `429` until the ban expires — even
 * a request carrying a valid token — so a banned attacker cannot keep probing.
 */

/** Reserved daemon code for rate-limited auth (not in the protocol enum). */
export const AUTH_RATE_LIMIT_CODE = 42901;
export const AUTH_RATE_LIMIT_MSG = 'Too many failed auth attempts';

export interface AuthFailureLimiterOptions {
  /** Failures within {@link windowMs} that trigger a ban. Default `10`. */
  readonly maxFailures?: number;
  /** Rolling failure window in ms. Default `60_000`. */
  readonly windowMs?: number;
  /** Ban duration in ms once the threshold is hit. Default `60_000`. */
  readonly banMs?: number;
}

/** Minimal surface consumed by `createAuthHook`. */
export interface AuthFailureLimiter {
  /** Record one failed auth attempt for `ip`. */
  recordFailure(ip: string): void;
  /** True while `ip` is inside an active ban window. */
  isBanned(ip: string): boolean;
  /** Stop the periodic cleanup timer and drop all state (shutdown / tests). */
  dispose(): void;
}

interface Entry {
  /** Failures recorded since {@link windowStart}. */
  count: number;
  /** Start (ms epoch) of the current failure window. */
  windowStart: number;
  /** ms epoch until which the source is banned; `0` when not banned. */
  bannedUntil: number;
}

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BAN_MS = 60_000;

/**
 * Build a per-source auth-failure limiter.
 *
 * A periodic sweep drops entries that are neither banned nor within an active
 * failure window so the map does not grow without bound on a long-lived
 * public server. The timer is `unref`-ed so it never keeps the process alive.
 */
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
