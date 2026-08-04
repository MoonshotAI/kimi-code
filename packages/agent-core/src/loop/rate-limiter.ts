/**
 * Provider-concurrency governor — the swarm rate-limit capacity machine,
 * shared by every consumer in the process.
 *
 * The algorithm is the one proven in `SubagentBatch`: uncapped until the
 * first provider 429, then capacity snaps to (what was actually running − 1),
 * shrinks by one per subsequent 429 (throttled so a burst is one episode),
 * and recovers +1 per quiet window without 429s. `SubagentBatch` holds one
 * instance per batch; tower holds a process-wide singleton
 * (`towerRateLimiter`) fed by `chatWithRetry`, the single funnel for all
 * LLM calls, and adds two tower-only layers on top: an inflight
 * acquire/release counter and a short spawn pause after each 429.
 */

export const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2_000;
export const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 180_000;
/** Tower-only: how long new spawns stay paused after a 429 episode. */
export const TOWER_SPAWN_PAUSE_MS = 60_000;
/** Tower-only: ceiling the capacity may recover to. */
export const TOWER_MAX_BUDGET = 16;

/**
 * The extracted swarm capacity state machine. `activeCount` is always
 * caller-supplied — the governor deliberately does not know what it is
 * governing, which is what lets a batch and the tower singleton share it.
 */
export class RateLimitCapacityGovernor {
  private capacity = Number.POSITIVE_INFINITY;
  private lastRateLimitAt: number | undefined;
  private lastShrinkAt: number | undefined;
  private lastRecoveryAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Capacity before congestion: uncapped (the swarm normal-phase contract). */
  getCapacity(): number {
    return this.capacity;
  }

  get inBackoff(): boolean {
    return this.lastRateLimitAt !== undefined;
  }

  get lastRateLimitedAt(): number | undefined {
    return this.lastRateLimitAt;
  }

  /**
   * A provider 429. The first one anchors capacity to (active − 1) — what was
   * provably too much; later ones shave one more off, throttled to one shrink
   * per `RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS` so a burst is one episode.
   * `activeCount <= 0` means the signal came from outside the governed fleet:
   * mark the episode (recovery clock) but leave capacity alone.
   */
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

  /**
   * +1 per quiet window with no 429 — the swarm's time-driven recovery,
   * lazily evaluated. Returns true when capacity actually grew.
   */
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

export interface RateLimiterSnapshot {
  /** Effective tower spawn budget: governor capacity clamped to the max. */
  readonly budget: number;
  /** Tower agents currently running (acquired, not yet released). */
  readonly inflight: number;
  /** Epoch ms while which new spawns are refused; null when unblocked. */
  readonly blockedUntil: number | null;
}

/**
 * The tower face of the governor: a process-wide singleton with inflight
 * tracking, a post-429 spawn pause (lifted early by the next success), and a
 * recovery ceiling. Signal collection lives in `chatWithRetry`
 * (`./retry.ts`); enforcement lives in `TowerSpawn`.
 */
export class RateLimiter {
  private readonly governor: RateLimitCapacityGovernor;
  private readonly now: () => number;
  private inflight = 0;
  private blockedUntil: number | null = null;

  constructor(
    private readonly options: {
      readonly maxBudget?: number;
      readonly pauseMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.governor = new RateLimitCapacityGovernor(this.now);
  }

  private get maxBudget(): number {
    return this.options.maxBudget ?? TOWER_MAX_BUDGET;
  }

  private get pauseMs(): number {
    return this.options.pauseMs ?? TOWER_SPAWN_PAUSE_MS;
  }

  /** A retryable provider 429 from any agent in the process. */
  reportRateLimited(): void {
    this.governor.noteRateLimited(this.inflight);
    this.blockedUntil = this.now() + this.pauseMs;
  }

  /** A successful request from any agent: lift the pause, feed recovery. */
  reportSuccess(): void {
    this.blockedUntil = null;
    this.governor.maybeRecover();
  }

  /** The current spawn budget: governor capacity, clamped to the tower max. */
  budget(): number {
    this.governor.maybeRecover();
    return Math.max(1, Math.min(this.maxBudget, this.governor.getCapacity()));
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

  snapshot(): RateLimiterSnapshot {
    return {
      budget: this.budget(),
      inflight: this.inflight,
      blockedUntil: this.blockedUntil,
    };
  }

  /** Test hook: restore the pristine state. */
  reset(): void {
    this.governor.reset();
    this.inflight = 0;
    this.blockedUntil = null;
  }
}

/** Process-wide singleton: one CLI process shares one provider account. */
export const towerRateLimiter = new RateLimiter();
