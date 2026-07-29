// apps/kimi-web/test/usage-format.test.ts
// Unit tests for the /usage panel formatting helpers (src/lib/usageFormat.ts).
import { describe, expect, it } from 'vitest';
import {
  countdownSeconds,
  currencySymbol,
  formatCountdown,
  formatCurrency,
  usagePercent,
  usageRatio,
  usageWindowKind,
} from '../src/lib/usageFormat';

describe('usageRatio / usagePercent', () => {
  it('computes the used/limit ratio', () => {
    expect(usageRatio({ used: 15, limit: 100 })).toBeCloseTo(0.15);
    expect(usagePercent({ used: 15, limit: 100 })).toBe(15);
  });

  it('clamps over-usage to 100%', () => {
    expect(usageRatio({ used: 120, limit: 100 })).toBe(1);
    expect(usagePercent({ used: 120, limit: 100 })).toBe(100);
  });

  it('clamps negative usage to 0', () => {
    expect(usageRatio({ used: -5, limit: 100 })).toBe(0);
  });

  it('returns 0 for a non-positive limit', () => {
    expect(usageRatio({ used: 10, limit: 0 })).toBe(0);
    expect(usagePercent({ used: 10, limit: 0 })).toBe(0);
  });
});

describe('usageWindowKind', () => {
  it('maps a weekly window to the dedicated label kind', () => {
    expect(usageWindowKind({ window: { duration: 1, unit: 'week' } })).toEqual({ kind: 'week' });
  });

  it('carries the duration for hour/day/minute windows', () => {
    expect(usageWindowKind({ window: { duration: 5, unit: 'hour' } })).toEqual({
      kind: 'hour',
      n: 5,
    });
    expect(usageWindowKind({ window: { duration: 1, unit: 'day' } })).toEqual({
      kind: 'day',
      n: 1,
    });
  });

  it('falls back to the named kind without a window', () => {
    expect(usageWindowKind({})).toEqual({ kind: 'named' });
  });
});

describe('countdownSeconds', () => {
  const now = Date.parse('2026-07-29T06:00:00Z');

  it('returns whole seconds until the reset', () => {
    expect(countdownSeconds('2026-07-29T07:00:00Z', now)).toBe(3600);
  });

  it('is negative once the reset has passed', () => {
    expect(countdownSeconds('2026-07-29T05:00:00Z', now)).toBeLessThan(0);
  });

  it('returns null for missing or unparseable timestamps', () => {
    expect(countdownSeconds(undefined, now)).toBeNull();
    expect(countdownSeconds('not-a-date', now)).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('formats days and hours', () => {
    expect(formatCountdown(2 * 86400 + 3 * 3600)).toBe('2d 3h');
  });

  it('formats hours and minutes', () => {
    expect(formatCountdown(3 * 3600 + 4 * 60)).toBe('3h 4m');
  });

  it('formats bare minutes', () => {
    expect(formatCountdown(5 * 60)).toBe('5m');
  });
});

describe('currency formatting', () => {
  it('maps known currencies to symbols', () => {
    expect(currencySymbol('CNY')).toBe('¥');
    expect(currencySymbol('usd')).toBe('$');
    expect(currencySymbol('EUR')).toBe('');
  });

  it('formats cents with a symbol prefix', () => {
    expect(formatCurrency(5000, 'CNY')).toBe('¥50.00');
    expect(formatCurrency(1234, 'USD')).toBe('$12.34');
  });

  it('falls back to a currency-code suffix for unknown currencies', () => {
    expect(formatCurrency(1234, 'EUR')).toBe('12.34 EUR');
  });
});
