import { describe, expect, it } from 'vitest';

import { parseCronExpression } from '#/app/cron/cron-expr';
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from '#/app/cron/jitter';

function localDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return new Date(year, monthIndex, day, hour, minute, second, 0).getTime();
}

const ID_A = 'aaaaaaaa';
const ID_B = '11111111';

describe('jitteredNextCronRunMs recurring jobs', () => {
  it('keeps */5 offsets inside 10 percent of the 5 minute period', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const ideal = localDate(2024, 5, 1, 12, 5, 0);

    const jittered = jitteredNextCronRunMs(
      { id: ID_A, cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );

    expect(jittered).toBeGreaterThanOrEqual(ideal);
    expect(jittered - ideal).toBeLessThanOrEqual(30_000);
  });

  it('caps daily offsets at 15 minutes', () => {
    const parsed = parseCronExpression('0 9 * * *');
    const ideal = localDate(2024, 5, 1, 9, 0, 0);

    const jittered = jitteredNextCronRunMs(
      { id: ID_A, cron: '0 9 * * *', recurring: true },
      parsed,
      ideal,
    );

    expect(jittered).toBeGreaterThanOrEqual(ideal);
    expect(jittered - ideal).toBeLessThanOrEqual(15 * 60_000);
    expect(jittered - ideal).toBeGreaterThan(60_000);
  });

  it('uses task id to produce distinct deterministic offsets', () => {
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
    expect(
      jitteredNextCronRunMs({ id: ID_A, cron: '*/5 * * * *', recurring: true }, parsed, ideal),
    ).toBe(a);
  });

  it('returns the ideal time when noJitter is true', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const ideal = localDate(2024, 5, 1, 12, 5, 0);

    const jittered = jitteredNextCronRunMs(
      { id: ID_A, cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
      undefined,
      true,
    );

    expect(jittered).toBe(ideal);
  });
});

describe('oneShotJitteredNextCronRunMs', () => {
  it('pulls round-hour one-shots earlier by at most 90 seconds', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);

    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);

    expect(jittered - ideal).toBeLessThanOrEqual(0);
    expect(jittered - ideal).toBeGreaterThanOrEqual(-90_000);
    expect(jittered).toBeLessThan(ideal);
  });

  it('pulls half-hour one-shots earlier by at most 90 seconds', () => {
    const ideal = localDate(2024, 5, 1, 14, 30, 0);

    const jittered = oneShotJitteredNextCronRunMs({ id: ID_A }, ideal);

    expect(jittered - ideal).toBeLessThanOrEqual(0);
    expect(jittered - ideal).toBeGreaterThanOrEqual(-90_000);
    expect(jittered).toBeLessThan(ideal);
  });

  it('passes through non-round minutes and mid-minute synthetic values', () => {
    expect(oneShotJitteredNextCronRunMs({ id: ID_A }, localDate(2024, 5, 1, 14, 7, 0))).toBe(
      localDate(2024, 5, 1, 14, 7, 0),
    );
    expect(oneShotJitteredNextCronRunMs({ id: ID_A }, localDate(2024, 5, 1, 14, 15, 0))).toBe(
      localDate(2024, 5, 1, 14, 15, 0),
    );
    expect(oneShotJitteredNextCronRunMs({ id: ID_A }, localDate(2024, 5, 1, 14, 0, 12))).toBe(
      localDate(2024, 5, 1, 14, 0, 12),
    );
  });

  it('is deterministic for the same id and ideal time', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    const calls = Array.from({ length: 5 }, () =>
      oneShotJitteredNextCronRunMs({ id: ID_A }, ideal),
    );

    for (const value of calls) {
      expect(value).toBe(calls[0]);
    }
  });

  it('returns the ideal time when noJitter is true', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    expect(oneShotJitteredNextCronRunMs({ id: ID_A }, ideal, undefined, true)).toBe(ideal);
  });

  it('skips pull-forward jitter when the createdAt budget is insufficient', () => {
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const createdAt = ideal - 30_000;

    const jittered = oneShotJitteredNextCronRunMs({ id: 'ffffffff', createdAt }, ideal);

    expect(jittered).toBe(ideal);
  });

  it('still pulls forward when createdAt leaves enough budget', () => {
    const ideal = localDate(2024, 5, 1, 9, 0, 0);
    const createdAt = ideal - 5 * 60_000;

    const jittered = oneShotJitteredNextCronRunMs({ id: 'ffffffff', createdAt }, ideal);

    expect(jittered).toBeGreaterThanOrEqual(createdAt);
    expect(jittered).toBeLessThan(ideal);
    expect(ideal - jittered).toBeLessThanOrEqual(90_000);
  });

  it('keeps legacy no-createdAt callers on the original pull-forward behavior', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);

    const jittered = oneShotJitteredNextCronRunMs({ id: 'ffffffff' }, ideal);

    expect(jittered).toBeLessThanOrEqual(ideal);
    expect(ideal - jittered).toBeLessThanOrEqual(90_000);
  });
});

describe('cron jitter config', () => {
  it('exports the documented defaults', () => {
    expect(DEFAULT_CRON_JITTER_CONFIG.recurringMaxFractionOfPeriod).toBe(0.1);
    expect(DEFAULT_CRON_JITTER_CONFIG.recurringMaxMs).toBe(15 * 60_000);
    expect(DEFAULT_CRON_JITTER_CONFIG.oneShotMaxMs).toBe(90_000);
  });

  it('honors a custom one-shot cap', () => {
    const ideal = localDate(2024, 5, 1, 14, 0, 0);
    const jittered = oneShotJitteredNextCronRunMs(
      { id: ID_A },
      ideal,
      { ...DEFAULT_CRON_JITTER_CONFIG, oneShotMaxMs: 10_000 },
    );

    expect(jittered - ideal).toBeGreaterThanOrEqual(-10_000);
    expect(jittered - ideal).toBeLessThanOrEqual(0);
  });

  it('honors a custom recurring cap', () => {
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

describe('cron jitter id hashing fallback', () => {
  it('keeps non-hex ids stable', () => {
    const parsed = parseCronExpression('*/5 * * * *');
    const ideal = localDate(2024, 5, 1, 12, 5, 0);

    const a = jitteredNextCronRunMs(
      { id: 'non-hex-id', cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );
    const b = jitteredNextCronRunMs(
      { id: 'non-hex-id', cron: '*/5 * * * *', recurring: true },
      parsed,
      ideal,
    );

    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(ideal);
    expect(a - ideal).toBeLessThanOrEqual(30_000);
  });
});
