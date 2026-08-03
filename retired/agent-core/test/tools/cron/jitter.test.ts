/**
 * Tests for `tools/cron/jitter.ts`. Fire times are constructed via
 * `new Date(y, m, d, h, mn, s)` so minute-of-hour assertions are
 * TZ-stable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCronExpression } from '../../../src/tools/cron/cron-expr';
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from '../../../src/tools/cron/jitter';

function localDate(
  y: number,
  monthIndex: number,
  d: number,
  h = 0,
  m = 0,
  s = 0,
): number {
  return new Date(y, monthIndex, d, h, m, s, 0).getTime();
}

/**
 * Two distinct 8-hex ids that produce visibly different jitter
 * fractions. `aaaaaaaa` ≈ 0.667, `11111111` ≈ 0.067, so any cap > a
 * few ms yields a separable offset for the "two distinct ids" test.
 */
const ID_A = 'aaaaaaaa';
const ID_B = '11111111';

describe('jitteredNextCronRunMs — recurring', () => {
  it('offset for */5 * * * * is within [0, 30s] (10% of 5min period)', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const ideal = localDate(2024, 5, 1, 12, 5, 0); // 12:05 local
    const jittered = jitteredNextCronRunMs(
      { id: ID_A, cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );
    expect(jittered).toBeGreaterThanOrEqual(ideal);
    expect(jittered - ideal).toBeLessThanOrEqual(30_000);
  });

  it('offset for daily 0 9 * * * is capped at 15min (NOT 10% of 1 day)', () => {
    const parsed = parseCronExpression('0 9 * * *');
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const jittered = jitteredNextCronRunMs(
      { id: ID_A, cron: '0 9 * * *', recurring: true },
      parsed,
      ideal,
    );
    expect(jittered).toBeGreaterThanOrEqual(ideal);
    // 10% of 1 day = 2.4h = 8 640 000 ms, but cap is 15 min.
    expect(jittered - ideal).toBeLessThanOrEqual(15 * 60_000);
    // And visibly bigger than the */5 case — long-period jobs spread
    // further (good for anti-herd at :00).
    expect(jittered - ideal).toBeGreaterThan(60_000);
  });

  it('different ids produce different offsets', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const ideal = localDate(2024, 5, 1, 12, 5, 0);
    const a = jitteredNextCronRunMs(
      { id: ID_A, cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );
    const b = jitteredNextCronRunMs(
      { id: ID_B, cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );
    expect(a).not.toBe(b);
  });

  it('deterministic: same inputs → same output across calls', () => {
    const parsed = parseCronExpression('0 9 * * *');
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const calls = Array.from({ length: 5 }, () =>
      jitteredNextCronRunMs(
        { id: ID_A, cron: '0 9 * * *', recurring: true },
        parsed,
        ideal,
      ),
    );
    for (const v of calls) {
      expect(v).toBe(calls[0]);
    }
  });

  it('respects KIMI_CRON_NO_JITTER=1 — no offset', () => {
    const prev = process.env['KIMI_CRON_NO_JITTER'];
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    try {
      const parsed = parseCronExpression('*/5 * * * *');
      const ideal = localDate(2024, 5, 1, 12, 5, 0);
      const jittered = jitteredNextCronRunMs(
        { id: ID_A, cron: '*/5 * * * *', recurring: true },
        parsed,
        ideal,
      );
      expect(jittered).toBe(ideal);
    } finally {
      if (prev === undefined) delete process.env['KIMI_CRON_NO_JITTER'];
      else process.env['KIMI_CRON_NO_JITTER'] = prev;
    }
  });
});

describe('oneShotJitteredNextCronRunMs', () => {
  it(':00 → offset within [-90s, 0)', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);
    expect(jittered - ideal).toBeLessThanOrEqual(0);
    expect(jittered - ideal).toBeGreaterThanOrEqual(-90_000);
    // ID_A's fraction ≈ 0.667 → expect ~ -60s, not 0.
    expect(jittered).toBeLessThan(ideal);
  });

  it(':30 → offset within [-90s, 0)', () => {
    const ideal = localDate(2024, 5, 1, 14, 30, 0);
    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);
    expect(jittered - ideal).toBeLessThanOrEqual(0);
    expect(jittered - ideal).toBeGreaterThanOrEqual(-90_000);
    expect(jittered).toBeLessThan(ideal);
  });

  it(':07 → passthrough, offset = 0', () => {
    const ideal = localDate(2024, 5, 1, 14, 7, 0);
    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);
    expect(jittered).toBe(ideal);
  });

  it(':15 → passthrough, offset = 0', () => {
    const ideal = localDate(2024, 5, 1, 14, 15, 0);
    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);
    expect(jittered).toBe(ideal);
  });

  it('mid-minute (non-zero seconds component baked into idealMs) → passthrough', () => {
    // Sub-minute granularity means the model didn't pick a round
    // wall-clock minute — leave it alone.
    const ideal = localDate(2024, 5, 1, 14, 0, 12);
    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);
    expect(jittered).toBe(ideal);
  });

  it('deterministic: same id + same ideal → same output', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    const calls = Array.from({ length: 5 }, () =>
      oneShotJitteredNextCronRunMs({ id: ID_A }, ideal),
    );
    for (const v of calls) {
      expect(v).toBe(calls[0]);
    }
  });

  it('respects KIMI_CRON_NO_JITTER=1', () => {
    const prev = process.env['KIMI_CRON_NO_JITTER'];
    process.env['KIMI_CRON_NO_JITTER'] = '1';
    try {
      const ideal = localDate(2024, 5, 1, 14, 0, 0);
      const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);
      expect(jittered).toBe(ideal);
    } finally {
      if (prev === undefined) delete process.env['KIMI_CRON_NO_JITTER'];
      else process.env['KIMI_CRON_NO_JITTER'] = prev;
    }
  });

  it('skips jitter when budget insufficient — returns idealMs, never earlier', () => {
    // Schedule a one-shot at 08:59:30 for `0 9 * * *` with a high-hash
    // id. The unclamped pull-forward lands at 08:58:30. A previous
    // version clamped to `createdAt` (08:59:30), but the scheduler
    // condition `now >= nextFireAt` then fires on the next tick —
    // ~29 s before ideal. We skip jitter instead and return idealMs.
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const createdAt = ideal - 30_000; // 08:59:30
    const jittered = oneShotJitteredNextCronRunMs(
      { id: 'ffffffff', createdAt },
      ideal,
    );
    expect(jittered).toBeGreaterThanOrEqual(createdAt);
    expect(jittered).toBeLessThanOrEqual(ideal);
    expect(jittered).toBe(ideal);
  });

  it('still pulls forward when createdAt leaves enough room', () => {
    // 5-minute gap between createdAt and ideal — well past the 90 s
    // oneShotMaxMs cap, so the budget is sufficient and the jitter
    // applies normally. Regression: the budget-insufficient branch
    // must not poison the happy path.
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const createdAt = ideal - 5 * 60_000;
    const jittered = oneShotJitteredNextCronRunMs(
      { id: 'ffffffff', createdAt },
      ideal,
    );
    expect(jittered).toBeGreaterThanOrEqual(createdAt);
    expect(jittered).toBeLessThan(ideal);
    expect(ideal - jittered).toBeLessThanOrEqual(90_000);
  });

  it('passes through unchanged when createdAt is not provided (legacy callers)', () => {
    // Backward-compat: existing test fixtures and external callers
    // that don't carry a `createdAt` must keep getting the original
    // unclamped behaviour.
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    const jittered = oneShotJitteredNextCronRunMs({ id: 'ffffffff' }, ideal);
    expect(jittered).toBeLessThanOrEqual(ideal);
    expect(ideal - jittered).toBeLessThanOrEqual(90_000);
  });
});

describe('config knobs', () => {
  it('default config is the documented constants', () => {
    expect(DEFAULT_CRON_JITTER_CONFIG.recurringMaxFractionOfPeriod).toBe(0.1);
    expect(DEFAULT_CRON_JITTER_CONFIG.recurringMaxMs).toBe(15 * 60_000);
    expect(DEFAULT_CRON_JITTER_CONFIG.oneShotMaxMs).toBe(90_000);
  });

  it('custom oneShotMaxMs caps the pull-forward', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    const jittered = oneShotJitteredNextCronRunMs(
      { id: ID_A },
      ideal,
      { ...DEFAULT_CRON_JITTER_CONFIG, oneShotMaxMs: 10_000 },
    );
    expect(jittered - ideal).toBeGreaterThanOrEqual(-10_000);
    expect(jittered - ideal).toBeLessThanOrEqual(0);
  });

  it('custom recurringMaxMs caps the forward shift', () => {
    const parsed = parseCronExpression('0 9 * * *');
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const jittered = jitteredNextCronRunMs(
      { id: ID_A, cron: '0 9 * * *', recurring: true },
      parsed,
      ideal,
      { ...DEFAULT_CRON_JITTER_CONFIG, recurringMaxMs: 5_000 },
    );
    expect(jittered - ideal).toBeGreaterThanOrEqual(0);
    expect(jittered - ideal).toBeLessThanOrEqual(5_000);
  });
});

describe('id hashing fallback', () => {
  it('non-hex id still produces a stable fraction', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const ideal = localDate(2024, 5, 1, 12, 5, 0);
    const a1 = jitteredNextCronRunMs(
      { id: 'non-hex-id!', cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );
    const a2 = jitteredNextCronRunMs(
      { id: 'non-hex-id!', cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );
    expect(a1).toBe(a2);
    expect(a1).toBeGreaterThanOrEqual(ideal);
    expect(a1 - ideal).toBeLessThanOrEqual(30_000);
  });
});

// Belt-and-suspenders: ensure env state we touched is clean after the
// suite (in case a future test in the same vitest worker reads it).
beforeEach(() => {
  delete process.env['KIMI_CRON_NO_JITTER'];
});
afterEach(() => {
  delete process.env['KIMI_CRON_NO_JITTER'];
});
