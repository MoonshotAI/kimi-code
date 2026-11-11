import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import {
  ITowerRateLimitService,
  type TowerRateLimitSnapshot,
} from '#/features/tower/towerRateLimit';
import {
  RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS,
  TOWER_SPAWN_PAUSE_MS,
  TowerRateLimitService,
} from '#/features/tower/towerRateLimitService';

import { StubConfigService } from '../../stubs';

describe('TowerRateLimitService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let config: StubConfigService;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    config = new StubConfigService();
    ix.stub(IConfigService, config);
    ix.set(ITowerRateLimitService, new SyncDescriptor(TowerRateLimitService));
  });
  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
  });

  function snapshot(): TowerRateLimitSnapshot {
    return ix.get(ITowerRateLimitService).snapshot();
  }

  it('starts with a 256-agent budget and no pause', () => {
    expect(snapshot()).toEqual({
      budget: 256,
      inflight: 0,
      blockedUntil: null,
    });
  });

  it('refuses new spawns above the default budget', () => {
    const limiter = ix.get(ITowerRateLimitService);
    for (let index = 0; index < 256; index += 1) {
      expect(limiter.acquire()).toEqual({ ok: true });
    }

    const gate = limiter.acquire();
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('expected acquire to be refused');
    expect(gate.reason).toContain('tower concurrency budget exhausted (256/256');
  });

  it('ignores a legacy maxRunningTasks value above the default budget', () => {
    config.setSilent('task', { maxRunningTasks: 300 });

    expect(snapshot().budget).toBe(256);
  });

  it('ignores a lower legacy task maxRunningTasks for the budget and new acquisitions', () => {
    config.setSilent('task', { maxRunningTasks: 2 });
    const limiter = ix.get(ITowerRateLimitService);

    expect(snapshot().budget).toBe(256);
    expect(limiter.acquire()).toEqual({ ok: true });
    expect(limiter.acquire()).toEqual({ ok: true });
    expect(limiter.acquire()).toEqual({ ok: true });
  });

  it('ignores the legacy background maxRunningTasks value', () => {
    config.setSilent('background', { maxRunningTasks: 3 });

    expect(snapshot().budget).toBe(256);
  });

  it('ignores legacy maxRunningTasks in both task and background sections', () => {
    config.setSilent('background', { maxRunningTasks: 2 });
    config.setSilent('task', { maxRunningTasks: 5 });

    expect(snapshot().budget).toBe(256);
  });

  it('keeps the default budget when the task configuration changes', () => {
    config.setSilent('task', { maxRunningTasks: 2 });
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.budget()).toBe(256);

    config.setSilent('task', { maxRunningTasks: 4 });
    expect(limiter.budget()).toBe(256);

    config.setSilent('task', undefined);
    expect(limiter.budget()).toBe(256);
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

  it('caps 429 recovery at the default budget', () => {
    const limiter = ix.get(ITowerRateLimitService);
    for (let index = 0; index < 256; index += 1) {
      expect(limiter.acquire().ok).toBe(true);
    }
    limiter.reportRateLimited();
    expect(snapshot().budget).toBe(255);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(256);

    now += RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    expect(limiter.budget()).toBe(256);
  });

  it('reset restores the pristine state', () => {
    const limiter = ix.get(ITowerRateLimitService);
    expect(limiter.acquire().ok).toBe(true);
    limiter.reportRateLimited();

    limiter.reset();

    expect(snapshot()).toEqual({
      budget: 256,
      inflight: 0,
      blockedUntil: null,
    });
  });
});
