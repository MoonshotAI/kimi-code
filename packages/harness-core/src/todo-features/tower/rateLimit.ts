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
