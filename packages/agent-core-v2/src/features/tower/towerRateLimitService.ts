import { Disposable } from '#/_base/di/lifecycle';
import {
  ITowerRateLimitService,
  type TowerRateLimitSnapshot,
} from './towerRateLimit';

export const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2_000;
export const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 180_000;
/** Tower-only: how long new spawns stay paused after a 429 episode. */
export const TOWER_SPAWN_PAUSE_MS = 60_000;
/** Tower-only: ceiling the capacity may recover to. */
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

export class TowerRateLimitService extends Disposable implements ITowerRateLimitService {
  declare readonly _serviceBrand: undefined;

  private readonly governor: RateLimitCapacityGovernor;
  private readonly now: () => number;
  private inflight = 0;
  private blockedUntil: number | null = null;

  constructor(now: () => number = Date.now) {
    super();
    this.now = now;
    this.governor = new RateLimitCapacityGovernor(this.now);
  }

  reportRateLimited(): void {
    this.governor.noteRateLimited(this.inflight);
    this.blockedUntil = this.now() + TOWER_SPAWN_PAUSE_MS;
  }

  reportSuccess(): void {
    this.blockedUntil = null;
    this.governor.maybeRecover();
  }

  budget(): number {
    this.governor.maybeRecover();
    return Math.max(1, Math.min(TOWER_MAX_BUDGET, this.governor.getCapacity()));
  }

  acquire(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const now = this.now();
    if (this.blockedUntil !== null) {
      if (now < this.blockedUntil) {
        const retryAfterS = Math.ceil((this.blockedUntil - now) / 1000);
        return {
          ok: false,
          reason:
            `provider rate limit hit — new tower spawns paused for ~${String(retryAfterS)}s. ` +
            'Successful requests lift the pause early; wait and retry, or let running agents finish first.',
        };
      }
      this.blockedUntil = null;
    }
    const budget = this.budget();
    if (this.inflight >= budget) {
      return {
        ok: false,
        reason:
          `tower concurrency budget exhausted (${String(this.inflight)}/${String(budget)} agents running). ` +
          'Wait for a running agent to complete, then retry.',
      };
    }
    this.inflight += 1;
    return { ok: true };
  }

  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  snapshot(): TowerRateLimitSnapshot {
    return {
      budget: this.budget(),
      inflight: this.inflight,
      blockedUntil: this.blockedUntil,
    };
  }

  reset(): void {
    this.governor.reset();
    this.inflight = 0;
    this.blockedUntil = null;
  }
}

