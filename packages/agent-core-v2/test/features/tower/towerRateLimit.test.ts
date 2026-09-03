import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  ITowerRateLimitService,
  type TowerRateLimitSnapshot,
} from '#/features/tower/towerRateLimit';
import {
  RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS,
  TOWER_MAX_BUDGET,
  TOWER_SPAWN_PAUSE_MS,
  TowerRateLimitService,
} from '#/features/tower/towerRateLimitService';

describe('TowerRateLimitService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ITowerRateLimitService, new SyncDescriptor(TowerRateLimitService, [() => now]));
  });
  afterEach(() => disposables.dispose());

  function snapshot(): TowerRateLimitSnapshot {
    return ix.get(ITowerRateLimitService).snapshot();
  }

  it('starts uncapped at the tower max budget with no pause', () => {
    expect(snapshot()).toEqual({ budget: TOWER_MAX_BUDGET, inflight: 0, blockedUntil: null });
  });

  it('acquire / release track inflight agents', () => {
    const limiter = ix.get(ITowerRateLimitService);

    expect(limiter.acquire()).toEqual({ ok: true });
    expect(limiter.acquire()).toEqual({ ok: true });
    expect(snapshot().inflight).toBe(2);

    limiter.release();
    expect(snapshot().inflight).toBe(1);

    limiter.release();
    limiter.release();
    expect(snapshot().inflight).toBe(0);
  });

  it('anchors the budget to (inflight - 1) on the first 429 and pauses spawns', () => {
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);

    limiter.reportRateLimited();

    expect(snapshot()).toEqual({
      budget: 2,
      inflight: 3,
      blockedUntil: now + TOWER_SPAWN_PAUSE_MS,
    });
  });

  it('refuses new spawns while the post-429 pause is in effect', () => {
    const limiter = ix.get(ITowerRateLimitService);
    limiter.reportRateLimited();

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('new tower spawns paused');

    now += TOWER_SPAWN_PAUSE_MS;
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('lifts the spawn pause early once a request succeeds', () => {
    const limiter = ix.get(ITowerRateLimitService);
    limiter.reportRateLimited();
    expect(snapshot().blockedUntil).not.toBeNull();

    limiter.reportSuccess();

    expect(snapshot().blockedUntil).toBeNull();
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('refuses spawns when the inflight count reaches the budget', () => {
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.acquire().ok).toBe(true);

    limiter.reportRateLimited();
    now += TOWER_SPAWN_PAUSE_MS;

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('tower concurrency budget exhausted (1/1');

    limiter.release();
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('recovers capacity by one per quiet window without 429s', () => {
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.acquire().ok).toBe(true);
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();
    expect(snapshot().budget).toBe(1);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(2);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(3);
  });

  it('never recovers beyond the tower max budget', () => {
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();

    for (let i = 0; i < TOWER_MAX_BUDGET + 4; i += 1) {
      now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
      limiter.budget();
    }

    expect(snapshot().budget).toBe(TOWER_MAX_BUDGET);
  });

  it('reset restores the pristine state', () => {
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();

    limiter.reset();

    expect(snapshot()).toEqual({ budget: TOWER_MAX_BUDGET, inflight: 0, blockedUntil: null });
  });
});
