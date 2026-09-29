export interface TowerRateLimitSnapshot {
  readonly budget: number;
  readonly inflight: number;
  readonly blockedUntil: number | null;
}

export interface TowerRateLimiter {
  reportRateLimited(): void;
  reportSuccess(): void;
  budget(): number;
  acquire(): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  release(): void;
  snapshot(): TowerRateLimitSnapshot;
  reset(): void;
}

export const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2_000;
export const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 180_000;
export const TOWER_SPAWN_PAUSE_MS = 60_000;
export const TOWER_MAX_BUDGET = 16;

export class RateLimitCapacityGovernor {
  private capacity = Number.POSITIVE_INFINITY;
  private lastRateLimitAt: number | undefined;
  private lastShrinkAt: number | undefined;
  private lastRecoveryAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  getCapacity(): number {
    return this.capacity;
  }

  get inBackoff(): boolean {
    return this.lastRateLimitAt !== undefined;
  }

  get lastRateLimitedAt(): number | undefined {
    return this.lastRateLimitAt;
  }

  noteRateLimited(activeCount: number): void {
    const now = this.now();
    if (activeCount > 0) {
      if (this.capacity === Number.POSITIVE_INFINITY) {
        this.capacity = Math.max(1, activeCount - 1);
        this.lastShrinkAt = now;
      } else if (
        this.lastShrinkAt === undefined ||
        now - this.lastShrinkAt >= RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
      ) {
        this.capacity = Math.max(1, this.capacity - 1);
        this.lastShrinkAt = now;
      }
    }
    this.lastRateLimitAt = now;
  }

  maybeRecover(): boolean {
    const now = this.now();
    if (this.nextRecoveryAt() > now) return false;
    this.capacity += 1;
    this.lastRecoveryAt = now;
    return true;
  }

  nextRecoveryAt(): number {
    if (this.lastRateLimitAt === undefined) return Number.POSITIVE_INFINITY;
    return (
      Math.max(this.lastRateLimitAt, this.lastRecoveryAt ?? 0) +
      RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS
    );
  }

  reset(): void {
    this.capacity = Number.POSITIVE_INFINITY;
    this.lastRateLimitAt = undefined;
    this.lastShrinkAt = undefined;
    this.lastRecoveryAt = undefined;
  }
}

export function createTowerRateLimiter(now: () => number = Date.now): TowerRateLimiter {
  const governor = new RateLimitCapacityGovernor(now);
  let inflight = 0;
  let blockedUntil: number | null = null;

  const budget = (): number => {
    governor.maybeRecover();
    return Math.max(1, Math.min(TOWER_MAX_BUDGET, governor.getCapacity()));
  };

  return {
    reportRateLimited(): void {
      governor.noteRateLimited(inflight);
      blockedUntil = now() + TOWER_SPAWN_PAUSE_MS;
    },
    reportSuccess(): void {
      blockedUntil = null;
      governor.maybeRecover();
    },
    budget,
    acquire() {
      const at = now();
      if (blockedUntil !== null) {
        if (at < blockedUntil) {
          const retryAfterS = Math.ceil((blockedUntil - at) / 1000);
          return {
            ok: false as const,
            reason:
              `provider rate limit hit — new tower spawns paused for ~${String(retryAfterS)}s. ` +
              'Successful requests lift the pause early; wait and retry, or let running agents finish first.',
          };
        }
        blockedUntil = null;
      }
      const current = budget();
      if (inflight >= current) {
        return {
          ok: false as const,
          reason:
            `tower concurrency budget exhausted (${String(inflight)}/${String(current)} agents running). ` +
            'Wait for a running agent to complete, then retry.',
        };
      }
      inflight += 1;
      return { ok: true as const };
    },
    release(): void {
      inflight = Math.max(0, inflight - 1);
    },
    snapshot(): TowerRateLimitSnapshot {
      return {
        budget: budget(),
        inflight,
        blockedUntil,
      };
    },
    reset(): void {
      governor.reset();
      inflight = 0;
      blockedUntil = null;
    },
  };
}
