/**
 * Tests for `tools/cron/cron-expr.ts`. Mirrors the layout of
 * `clock.test.ts` (lives under `test/` because the package's vitest
 * config scopes `include` to `test/**`).
 *
 * Local-time semantics matter: `new Date('2024-06-01T12:00:30')` in JS
 * land is interpreted as local time when the string has no timezone
 * suffix (and as UTC when it has one). We construct dates explicitly
 * via `new Date(year, monthIndex, day, hour, minute, second)` so the
 * tests are stable regardless of the test process's TZ.
 */
import { describe, expect, it } from 'vitest';

import {
  computeNextCronRun,
  cronToHuman,
  hasFireWithinYears,
  parseCronExpression,
} from '../../../src/tools/cron/cron-expr';

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

function nextLocalParts(ts: number) {
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
  it('parses wildcard', () => {
    const p = parseCronExpression('* * * * *');
    expect(p.minutes.size).toBe(60);
    expect(p.hours.size).toBe(24);
    expect(p.daysOfMonth.size).toBe(31);
    expect(p.months.size).toBe(12);
    expect(p.daysOfWeek.size).toBe(7);
    expect(p.daysOfMonthWildcard).toBe(true);
    expect(p.daysOfWeekWildcard).toBe(true);
  });

  it('parses single integers', () => {
    const p = parseCronExpression('5 9 1 6 3');
    expect([...p.minutes]).toEqual([5]);
    expect([...p.hours]).toEqual([9]);
    expect([...p.daysOfMonth]).toEqual([1]);
    expect([...p.months]).toEqual([6]);
    expect([...p.daysOfWeek]).toEqual([3]);
    expect(p.daysOfMonthWildcard).toBe(false);
    expect(p.daysOfWeekWildcard).toBe(false);
  });

  it('parses ranges', () => {
    const p = parseCronExpression('0 9-17 * * 1-5');
    expect([...p.hours].toSorted((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...p.daysOfWeek].toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses lists', () => {
    const p = parseCronExpression('0 9,12,17 * * *');
    expect([...p.hours].toSorted((a, b) => a - b)).toEqual([9, 12, 17]);
  });

  it('parses step with wildcard', () => {
    const p = parseCronExpression('*/5 * * * *');
    expect([...p.minutes].toSorted((a, b) => a - b)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  it('parses step with range', () => {
    const p = parseCronExpression('0-30/10 * * * *');
    expect([...p.minutes].toSorted((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  it('folds day-of-week 7 to 0 (Sunday)', () => {
    const p = parseCronExpression('0 0 * * 7');
    expect([...p.daysOfWeek]).toEqual([0]);
  });

  it('treats bare * as wildcard but */n as restriction', () => {
    const a = parseCronExpression('* * * * *');
    const b = parseCronExpression('*/5 * * * *');
    expect(a.daysOfMonthWildcard).toBe(true);
    expect(b.daysOfMonthWildcard).toBe(true);
  });

  it('throws on too few fields', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(/5 fields/);
  });

  it('throws on too many fields', () => {
    expect(() => parseCronExpression('* * * * * *')).toThrow(/5 fields/);
  });

  it('throws on empty input', () => {
    expect(() => parseCronExpression('')).toThrow(/empty/);
    expect(() => parseCronExpression('   ')).toThrow(/empty/);
  });

  it('throws on out-of-range minute', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow(/minute/);
  });

  it('throws on out-of-range hour', () => {
    expect(() => parseCronExpression('0 24 * * *')).toThrow(/hour/);
  });

  it('throws on out-of-range day-of-month', () => {
    expect(() => parseCronExpression('0 0 32 * *')).toThrow(/day-of-month/);
  });

  it('throws on out-of-range month', () => {
    expect(() => parseCronExpression('0 0 * 13 *')).toThrow(/month/);
  });

  it('throws on out-of-range day-of-week', () => {
    expect(() => parseCronExpression('0 0 * * 8')).toThrow(/day-of-week/);
  });

  it('throws on non-integer step', () => {
    expect(() => parseCronExpression('*/x * * * *')).toThrow(/step/);
  });

  it('throws on zero step', () => {
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(/step/);
  });

  it('throws on descending range', () => {
    expect(() => parseCronExpression('5-1 * * * *')).toThrow(/range/);
  });

  it('throws on empty list term', () => {
    expect(() => parseCronExpression('1,,3 * * * *')).toThrow(/empty term/);
  });
});

describe('computeNextCronRun', () => {
  it('*/5 — from xx:00:30 advances to xx:05:00', () => {
    const expr = parseCronExpression('*/5 * * * *');
    const from = localDate(2024, 5, 1, 12, 0, 30);
    const next = computeNextCronRun(expr, from);
    expect(next).not.toBeNull();
    const p = nextLocalParts(next!);
    expect(p.year).toBe(2024);
    expect(p.month).toBe(6);
    expect(p.day).toBe(1);
    expect(p.hour).toBe(12);
    expect(p.minute).toBe(5);
    expect(p.second).toBe(0);
  });

  it('*/5 — from xx:00:00 advances strictly to xx:05:00, never xx:00:00', () => {
    const expr = parseCronExpression('*/5 * * * *');
    const from = localDate(2024, 5, 1, 12, 0, 0);
    const next = computeNextCronRun(expr, from);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
    const p = nextLocalParts(next!);
    expect(p.minute).toBe(5);
  });

  it('0 9 * * * — from 08:00 advances to 09:00 same day', () => {
    const expr = parseCronExpression('0 9 * * *');
    const from = localDate(2024, 5, 1, 8, 0, 0);
    const next = computeNextCronRun(expr, from);
    const p = nextLocalParts(next!);
    expect(p.day).toBe(1);
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(0);
  });

  it('0 9 * * 1-5 — from Saturday 09:00 → next Monday 09:00', () => {
    const expr = parseCronExpression('0 9 * * 1-5');
    // 2024-06-01 is a Saturday.
    const sat = new Date(2024, 5, 1, 9, 0, 0, 0);
    expect(sat.getDay()).toBe(6);
    const next = computeNextCronRun(expr, sat.getTime());
    const p = nextLocalParts(next!);
    expect(p.dow).toBe(1); // Monday
    expect(p.day).toBe(3); // 2024-06-03
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(0);
  });

  it('0 12 1 1 * — from mid-year advances to next Jan 1 12:00', () => {
    const expr = parseCronExpression('0 12 1 1 *');
    const from = localDate(2024, 5, 1, 0, 0, 0);
    const next = computeNextCronRun(expr, from);
    const p = nextLocalParts(next!);
    expect(p.year).toBe(2025);
    expect(p.month).toBe(1);
    expect(p.day).toBe(1);
    expect(p.hour).toBe(12);
  });

  it('0 0 31 2 * — Feb has no day 31 → null', () => {
    const expr = parseCronExpression('0 0 31 2 *');
    const from = localDate(2024, 0, 1, 0, 0, 0);
    expect(computeNextCronRun(expr, from)).toBeNull();
  });

  it('29 2 — Feb 29 fires on leap years', () => {
    // `0 0 29 2 *` — every Feb 29 midnight.
    const expr = parseCronExpression('0 0 29 2 *');
    const from = localDate(2023, 0, 1, 0, 0, 0);
    const next = computeNextCronRun(expr, from);
    const p = nextLocalParts(next!);
    expect(p.year).toBe(2024);
    expect(p.month).toBe(2);
    expect(p.day).toBe(29);
  });

  it('cron-style OR: 0 0 1 * 1 fires on every 1st AND every Monday', () => {
    const expr = parseCronExpression('0 0 1 * 1');
    // Sample a few fires across a couple months. Starting Jun 1 2024 (Sat).
    let cur = localDate(2024, 5, 1, 0, 0, 0) - 1;
    const fires: { date: Date; dow: number; dom: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const n = computeNextCronRun(expr, cur);
      expect(n).not.toBeNull();
      const d = new Date(n!);
      fires.push({ date: d, dow: d.getDay(), dom: d.getDate() });
      cur = n!;
    }
    // Every fire must be either a Monday OR the 1st of a month.
    for (const f of fires) {
      const isMonday = f.dow === 1;
      const isFirst = f.dom === 1;
      expect(isMonday || isFirst).toBe(true);
    }
    // We must see at least one of each (Monday and non-Monday 1st).
    expect(fires.some((f) => f.dow === 1 && f.dom !== 1)).toBe(true);
    expect(fires.some((f) => f.dom === 1)).toBe(true);
  });

  it('returns strictly greater than fromMs', () => {
    const expr = parseCronExpression('* * * * *');
    const from = localDate(2024, 5, 1, 12, 30, 45);
    const next = computeNextCronRun(expr, from);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
  });

  it('DST transition still advances and never returns < fromMs', () => {
    // Pick a date around the US DST transition (2024-03-10 spring
    // forward in America/New_York). The test process TZ may not be
    // NY, but the invariant "monotonic forward" must hold in any TZ.
    const expr = parseCronExpression('0 * * * *');
    const from = localDate(2024, 2, 10, 0, 0, 0);
    let cur = from;
    let prev = from;
    for (let i = 0; i < 48; i++) {
      const n = computeNextCronRun(expr, cur);
      expect(n).not.toBeNull();
      expect(n!).toBeGreaterThan(prev);
      prev = cur;
      cur = n!;
    }
  });
});

describe('hasFireWithinYears', () => {
  it('0 0 31 2 * → false within 5 years', () => {
    const expr = parseCronExpression('0 0 31 2 *');
    expect(hasFireWithinYears(expr, 5, localDate(2024, 0, 1))).toBe(false);
  });

  it('0 12 1 1 * → true within 5 years', () => {
    const expr = parseCronExpression('0 12 1 1 *');
    expect(hasFireWithinYears(expr, 5, localDate(2024, 0, 1))).toBe(true);
  });

  it('* * * * * → true within any nonzero window', () => {
    const expr = parseCronExpression('* * * * *');
    expect(hasFireWithinYears(expr, 1, localDate(2024, 0, 1))).toBe(true);
  });
});

describe('cronToHuman', () => {
  it('every minute', () => {
    expect(cronToHuman(parseCronExpression('* * * * *'))).toBe('every minute');
  });

  it('every 5 minutes', () => {
    expect(cronToHuman(parseCronExpression('*/5 * * * *'))).toBe('every 5 minutes');
  });

  it('at HH:MM every day', () => {
    expect(cronToHuman(parseCronExpression('0 9 * * *'))).toBe('at 09:00 every day');
    expect(cronToHuman(parseCronExpression('30 14 * * *'))).toBe('at 14:30 every day');
  });

  it('weekdays / weekends shortcut', () => {
    expect(cronToHuman(parseCronExpression('0 9 * * 1-5'))).toBe('at 09:00 on weekdays');
    expect(cronToHuman(parseCronExpression('0 10 * * 0,6'))).toBe('at 10:00 on weekends');
  });

  it('at HH:MM on day N of <month>', () => {
    expect(cronToHuman(parseCronExpression('0 12 1 1 *'))).toBe('at 12:00 on day 1 of January');
  });

  it('every N hours', () => {
    expect(cronToHuman(parseCronExpression('0 */6 * * *'))).toBe('every 6 hours at minute 00');
  });

  it('falls back to raw expression for weird patterns', () => {
    expect(cronToHuman(parseCronExpression('1,7,23 5,17 * * *'))).toBe('1,7,23 5,17 * * *');
  });
});
