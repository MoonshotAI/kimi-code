import { describe, expect, it } from 'vitest';

import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
} from '#/app/cron/cron-expr';

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

function localParts(ts: number): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly dow: number;
} {
  const d = new Date(ts);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    dow: d.getDay(),
  };
}

describe('parseCronExpression', () => {
  it('parses wildcards', () => {
    const parsed = parseCronExpression('* * * * *');

    expect(parsed.minutes.size).toBe(60);
    expect(parsed.hours.size).toBe(24);
    expect(parsed.daysOfMonth.size).toBe(31);
    expect(parsed.months.size).toBe(12);
    expect(parsed.daysOfWeek.size).toBe(7);
    expect(parsed.daysOfMonthWildcard).toBe(true);
    expect(parsed.daysOfWeekWildcard).toBe(true);
  });

  it('parses single integers', () => {
    const parsed = parseCronExpression('5 9 1 6 3');

    expect([...parsed.minutes]).toEqual([5]);
    expect([...parsed.hours]).toEqual([9]);
    expect([...parsed.daysOfMonth]).toEqual([1]);
    expect([...parsed.months]).toEqual([6]);
    expect([...parsed.daysOfWeek]).toEqual([3]);
    expect(parsed.daysOfMonthWildcard).toBe(false);
    expect(parsed.daysOfWeekWildcard).toBe(false);
  });

  it('parses ranges, lists, and steps', () => {
    expect([...parseCronExpression('0 9-17 * * 1-5').hours].toSorted((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect([...parseCronExpression('0 9,12,17 * * *').hours].toSorted((a, b) => a - b)).toEqual([
      9, 12, 17,
    ]);
    expect([...parseCronExpression('*/5 * * * *').minutes].toSorted((a, b) => a - b)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
    expect([...parseCronExpression('0-30/10 * * * *').minutes].toSorted((a, b) => a - b)).toEqual([
      0, 10, 20, 30,
    ]);
  });

  it('folds day-of-week 7 to Sunday', () => {
    expect([...parseCronExpression('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('throws on malformed field counts and empty input', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(/5 fields/);
    expect(() => parseCronExpression('* * * * * *')).toThrow(/5 fields/);
    expect(() => parseCronExpression('')).toThrow(/empty/);
    expect(() => parseCronExpression('   ')).toThrow(/empty/);
  });

  it('throws on out-of-range fields', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow(/minute/);
    expect(() => parseCronExpression('0 24 * * *')).toThrow(/hour/);
    expect(() => parseCronExpression('0 0 32 * *')).toThrow(/day-of-month/);
    expect(() => parseCronExpression('0 0 * 13 *')).toThrow(/month/);
    expect(() => parseCronExpression('0 0 * * 8')).toThrow(/day-of-week/);
  });

  it('throws on malformed steps, ranges, and lists', () => {
    expect(() => parseCronExpression('*/x * * * *')).toThrow(/step/);
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCronExpression('5-1 * * * *')).toThrow(/range/);
    expect(() => parseCronExpression('1,,3 * * * *')).toThrow(/empty term/);
  });

  it('rejects numeric tokens that are not plain non-negative integers', () => {
    expect(() => parseCronExpression('-5 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('1e1 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('0x10 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('+5 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('*/1e1 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('*/0x10 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('1-1e1 * * * *')).toThrow(/digits only|non-negative integer/);
    expect(() => parseCronExpression('1e1-5 * * * *')).toThrow(/digits only|non-negative integer/);
  });

  it('still accepts plain integers, ranges, lists, and steps', () => {
    expect(() => parseCronExpression('5 * * * *')).not.toThrow();
    expect(() => parseCronExpression('1-5 * * * *')).not.toThrow();
    expect(() => parseCronExpression('1,5,10 * * * *')).not.toThrow();
    expect(() => parseCronExpression('*/5 * * * *')).not.toThrow();
    expect(() => parseCronExpression('1-30/5 * * * *')).not.toThrow();
  });
});

describe('computeNextCronRun', () => {
  it('advances to the next matching minute for a step expression', () => {
    const expr = parseCronExpression('*/5 * * * *');
    const next = computeNextCronRun(expr, localDate(2024, 5, 1, 12, 0, 30));

    expect(next).not.toBeNull();
    expect(localParts(next!)).toMatchObject({
      year: 2024,
      month: 6,
      day: 1,
      hour: 12,
      minute: 5,
      second: 0,
    });
  });

  it('returns a time strictly greater than fromMs', () => {
    const expr = parseCronExpression('*/5 * * * *');
    const from = localDate(2024, 5, 1, 12, 0, 0);
    const next = computeNextCronRun(expr, from);

    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
    expect(localParts(next!).minute).toBe(5);
  });

  it('advances daily expressions on the same day when possible', () => {
    const expr = parseCronExpression('0 9 * * *');
    const next = computeNextCronRun(expr, localDate(2024, 5, 1, 8, 0, 0));

    expect(localParts(next!)).toMatchObject({
      day: 1,
      hour: 9,
      minute: 0,
    });
  });

  it('advances weekday expressions to the next allowed weekday', () => {
    const expr = parseCronExpression('0 9 * * 1-5');
    const saturday = new Date(2024, 5, 1, 9, 0, 0, 0);
    expect(saturday.getDay()).toBe(6);

    const next = computeNextCronRun(expr, saturday.getTime());

    expect(localParts(next!)).toMatchObject({
      dow: 1,
      day: 3,
      hour: 9,
      minute: 0,
    });
  });

  it('advances yearly expressions across the year boundary', () => {
    const expr = parseCronExpression('0 12 1 1 *');
    const next = computeNextCronRun(expr, localDate(2024, 5, 1, 0, 0, 0));

    expect(localParts(next!)).toMatchObject({
      year: 2025,
      month: 1,
      day: 1,
      hour: 12,
    });
  });

  it('returns null for legal expressions that cannot fire inside the search window', () => {
    const expr = parseCronExpression('0 0 31 2 *');
    expect(computeNextCronRun(expr, localDate(2024, 0, 1, 0, 0, 0))).toBeNull();
  });

  it('finds leap-year February 29 fires', () => {
    const expr = parseCronExpression('0 0 29 2 *');
    const next = computeNextCronRun(expr, localDate(2023, 0, 1, 0, 0, 0));

    expect(localParts(next!)).toMatchObject({
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  it('uses cron OR semantics when day-of-month and day-of-week are restricted', () => {
    const expr = parseCronExpression('0 0 1 * 1');
    let cursor = localDate(2024, 5, 1, 0, 0, 0) - 1;
    const fires: Array<{ readonly dow: number; readonly dom: number }> = [];

    for (let i = 0; i < 12; i++) {
      const next = computeNextCronRun(expr, cursor);
      expect(next).not.toBeNull();
      const d = new Date(next!);
      fires.push({ dow: d.getDay(), dom: d.getDate() });
      cursor = next!;
    }

    for (const fire of fires) {
      expect(fire.dow === 1 || fire.dom === 1).toBe(true);
    }
    expect(fires.some((fire) => fire.dow === 1 && fire.dom !== 1)).toBe(true);
    expect(fires.some((fire) => fire.dom === 1)).toBe(true);
  });

  it('keeps advancing monotonically across DST-adjacent dates', () => {
    const expr = parseCronExpression('0 * * * *');
    let cursor = localDate(2024, 2, 10, 0, 0, 0);
    let prev = cursor;

    for (let i = 0; i < 48; i++) {
      const next = computeNextCronRun(expr, cursor);
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(prev);
      prev = cursor;
      cursor = next!;
    }
  });
});

describe('hasFireWithinYears', () => {
  it('returns false for never-firing expressions', () => {
    const expr = parseCronExpression('0 0 31 2 *');
    expect(hasFireWithinYears(expr, 5, localDate(2024, 0, 1))).toBe(false);
  });

  it('returns true for expressions with a fire inside the window', () => {
    const yearly = parseCronExpression('0 12 1 1 *');
    const everyMinute = parseCronExpression('* * * * *');

    expect(hasFireWithinYears(yearly, 5, localDate(2024, 0, 1))).toBe(true);
    expect(hasFireWithinYears(everyMinute, 1, localDate(2024, 0, 1))).toBe(true);
  });

  it('returns quickly for never-firing February dates', () => {
    const expr = parseCronExpression('0 0 30 2 *');
    const start = performance.now();
    const result = hasFireWithinYears(expr, 5, localDate(2024, 0, 1));
    const elapsedMs = performance.now() - start;

    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('respects custom year windows around fire boundaries', () => {
    const expr = parseCronExpression('0 0 1 1 *');
    const fromInsideYear = localDate(2024, 5, 1);

    expect(hasFireWithinYears(expr, 5, fromInsideYear)).toBe(true);
    expect(hasFireWithinYears(expr, 0.5, fromInsideYear)).toBe(false);
  });
});

describe('cronToHuman', () => {
  it('renders common schedules', () => {
    expect(cronToHuman(parseCronExpression('* * * * *'))).toBe('every minute');
    expect(cronToHuman(parseCronExpression('*/5 * * * *'))).toBe('every 5 minutes');
    expect(cronToHuman(parseCronExpression('0 9 * * *'))).toBe('at 09:00 every day');
    expect(cronToHuman(parseCronExpression('30 14 * * *'))).toBe('at 14:30 every day');
    expect(cronToHuman(parseCronExpression('0 */6 * * *'))).toBe('every 6 hours at minute 00');
  });

  it('renders day restrictions and pinned month days', () => {
    expect(cronToHuman(parseCronExpression('0 9 * * 1-5'))).toBe('at 09:00 on weekdays');
    expect(cronToHuman(parseCronExpression('0 10 * * 0,6'))).toBe('at 10:00 on weekends');
    expect(cronToHuman(parseCronExpression('0 12 1 1 *'))).toBe(
      'at 12:00 on day 1 of January',
    );
  });

  it('falls back to the raw expression for unrecognized shapes', () => {
    expect(cronToHuman(parseCronExpression('1,7,23 5,17 * * *'))).toBe('1,7,23 5,17 * * *');
  });
});
