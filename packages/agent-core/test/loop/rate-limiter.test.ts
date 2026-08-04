import { beforeEach, describe, expect, it } from 'vitest';

import {
  RateLimitCapacityGovernor,
  RateLimiter,
  RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS,
} from '../../src/loop/rate-limiter';

describe('RateLimitCapacityGovernor (swarm capacity machine)', () => {
  let now: { current: number };
  let governor: RateLimitCapacityGovernor;

  beforeEach(() => {
    now = { current: 1_000_000 };
    governor = new RateLimitCapacityGovernor(() => now.current);
  });

  it('is uncapped until the first 429', () => {
    expect(governor.getCapacity()).toBe(Number.POSITIVE_INFINITY);
    expect(governor.inBackoff).toBe(false);
  });

  it('anchors capacity to (active - 1) on the first 429', () => {
    governor.noteRateLimited(5);
    expect(governor.getCapacity()).toBe(4);
  });

  it('floors at 1 even when nothing was running', () => {
    governor.noteRateLimited(0);
    expect(governor.getCapacity()).toBe(Number.POSITIVE_INFINITY); // outside signal: untouched
    governor.noteRateLimited(1);
    expect(governor.getCapacity()).toBe(1);
  });

  it('shaves one more per later 429, throttled so a burst is one episode', () => {
    governor.noteRateLimited(5);
    expect(governor.getCapacity()).toBe(4);

    now.current += 1_000;
    governor.noteRateLimited(5); // inside the 2s shrink window → ignored
    expect(governor.getCapacity()).toBe(4);

    now.current += 2_001;
    governor.noteRateLimited(5);
    expect(governor.getCapacity()).toBe(3);

    now.current += 2_001;
    governor.noteRateLimited(5);
    now.current += 2_001;
    governor.noteRateLimited(5);
    expect(governor.getCapacity()).toBe(1); // floored
  });

  it('recovers +1 per quiet window, once per window, restarted by a new 429', () => {
    governor.noteRateLimited(5);
    expect(governor.maybeRecover()).toBe(false);

    now.current += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS + 1;
    expect(governor.maybeRecover()).toBe(true);
    expect(governor.getCapacity()).toBe(5);

    // Same window: no second recovery.
    expect(governor.maybeRecover()).toBe(false);

    // A fresh 429 restarts the clock and re-shrinks.
    governor.noteRateLimited(5);
    expect(governor.getCapacity()).toBe(4);
    now.current += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS - 1;
    expect(governor.maybeRecover()).toBe(false);
  });
});

describe('RateLimiter (tower face: pause + inflight + ceiling)', () => {
  let now: { current: number };
  let limiter: RateLimiter;

  beforeEach(() => {
    now = { current: 1_000_000 };
    limiter = new RateLimiter({ maxBudget: 16, pauseMs: 60_000, now: () => now.current });
  });

  it('starts with the max budget and refuses only when inflight reaches it', () => {
    expect(limiter.snapshot().budget).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(limiter.acquire().ok).toBe(true);
    }
    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain('16/16');
  });

  it('release frees a slot', () => {
    for (let i = 0; i < 16; i++) limiter.acquire();
    limiter.release();
    expect(limiter.acquire().ok).toBe(true);
  });

  it('429 pauses new spawns and shrinks the budget around actual inflight', () => {
    limiter.acquire();
    limiter.acquire();
    limiter.acquire(); // inflight 3
    limiter.reportRateLimited();

    const snapshot = limiter.snapshot();
    expect(snapshot.budget).toBe(2); // 3 in flight − 1
    expect(snapshot.blockedUntil).not.toBeNull();

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain('paused');
  });

  it('a success lifts the pause early', () => {
    limiter.reportRateLimited();
    expect(limiter.snapshot().blockedUntil).not.toBeNull();

    limiter.reportSuccess();
    expect(limiter.snapshot().blockedUntil).toBeNull();
    expect(limiter.acquire().ok).toBe(true);
  });

  it('the pause expires on its own after the cooldown', () => {
    limiter.reportRateLimited();
    now.current += 61_000;
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.snapshot().blockedUntil).toBeNull();
  });

  it('recovers through quiet windows but never past the max budget', () => {
    limiter.acquire();
    limiter.acquire();
    limiter.reportRateLimited();
    expect(limiter.snapshot().budget).toBe(1);

    for (let round = 0; round < 20; round++) {
      now.current += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS + 1;
      limiter.reportSuccess();
    }
    expect(limiter.snapshot().budget).toBe(16);
  });
});
