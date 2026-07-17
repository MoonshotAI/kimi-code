// apps/kimi-web/src/lib/usageFormat.test.ts
import { describe, expect, it } from 'vitest';

import {
  buildUsageRows,
  formatUsageDuration,
  formatUsageMoney,
  localizedResetHint,
  usageRowPct,
} from './usageFormat';

/** Recording stub for the injected translator — returns "key{json}". */
function makeT() {
  const calls: Array<{ key: string; named: Record<string, unknown> }> = [];
  const t = (key: string, named: Record<string, unknown>): string => {
    calls.push({ key, named });
    return Object.keys(named).length > 0 ? `${key} ${JSON.stringify(named)}` : key;
  };
  return { t, calls };
}

describe('usageRowPct', () => {
  it('computes a clamped 0-100 percentage', () => {
    expect(usageRowPct({ used: 30, limit: 100 })).toBe(30);
    expect(usageRowPct({ used: 1, limit: 3 })).toBe(33);
    expect(usageRowPct({ used: 150, limit: 100 })).toBe(100);
    expect(usageRowPct({ used: 0, limit: 100 })).toBe(0);
  });

  it('returns 0 for a missing/zero limit', () => {
    expect(usageRowPct({ used: 5, limit: 0 })).toBe(0);
    expect(usageRowPct({ used: 5, limit: -1 })).toBe(0);
  });
});

describe('formatUsageDuration', () => {
  const { t } = makeT();

  it('renders day/hour/minute parts in order', () => {
    expect(formatUsageDuration(6 * 86400 + 13 * 3600 + 29 * 60, t)).toBe(
      'status.usageDurationDay {"n":6} status.usageDurationHour {"n":13} status.usageDurationMinute {"n":29}',
    );
  });

  it('omits zero parts and falls back to seconds', () => {
    expect(formatUsageDuration(3600, t)).toBe('status.usageDurationHour {"n":1}');
    expect(formatUsageDuration(59, t)).toBe('status.usageDurationSecond {"n":59}');
    expect(formatUsageDuration(0, t)).toBe('status.usageDurationSecond {"n":0}');
  });

  it('clamps invalid input to 0 seconds', () => {
    expect(formatUsageDuration(-10, t)).toBe('status.usageDurationSecond {"n":0}');
    expect(formatUsageDuration(Number.NaN, t)).toBe('status.usageDurationSecond {"n":0}');
    expect(formatUsageDuration(90.9, t)).toBe('status.usageDurationMinute {"n":1}');
  });
});

describe('localizedResetHint', () => {
  const { t } = makeT();
  const now = Date.parse('2026-07-17T00:00:00Z');

  it('renders a relative hint for a future ISO timestamp', () => {
    expect(localizedResetHint({ resetAt: '2026-07-17T02:30:00Z' }, t, now)).toBe(
      'status.usageResetsIn {"duration":"status.usageDurationHour {\\"n\\":2} status.usageDurationMinute {\\"n\\":30}"}',
    );
  });

  it('renders the reset-now copy for a past timestamp', () => {
    expect(localizedResetHint({ resetAt: '2026-07-16T23:00:00Z' }, t, now)).toBe(
      'status.usageResetNow',
    );
  });

  it('falls back to the server hint when resetAt is missing or unparseable', () => {
    expect(localizedResetHint({ resetHint: 'resets in 2d' }, t, now)).toBe('resets in 2d');
    expect(localizedResetHint({ resetAt: 'not-a-date', resetHint: 'resets in 2d' }, t, now)).toBe(
      'resets in 2d',
    );
    expect(localizedResetHint({}, t, now)).toBeUndefined();
  });
});

describe('formatUsageMoney', () => {
  it('formats cents with the ISO currency', () => {
    expect(formatUsageMoney(1050, 'USD', 'en')).toBe('$10.50');
    expect(formatUsageMoney(0, 'USD', 'en')).toBe('$0.00');
  });

  it('falls back to plain text for an unknown currency code', () => {
    expect(formatUsageMoney(1234, 'NOT_A_CCY', 'en')).toBe('12.34 NOT_A_CCY');
  });
});

describe('buildUsageRows', () => {
  it('localizes the summary label and window-based limit labels', () => {
    const { t } = makeT();
    const rows = buildUsageRows(
      {
        summary: { label: 'Weekly limit', used: 30, limit: 100, resetAt: '2026-07-24T00:00:00Z' },
        limits: [
          { label: '5h limit', used: 10, limit: 100, windowSeconds: 5 * 3600 },
          { label: 'raw scope label', used: 1, limit: 2 },
        ],
      },
      t,
    );
    expect(rows.map((r) => r.label)).toEqual([
      'status.usageWeekly',
      'status.usageWindowLimit {"duration":"status.usageDurationHour {\\"n\\":5}"}',
      'raw scope label',
    ]);
    expect(rows.map((r) => r.key)).toEqual(['summary', 'limit:0', 'limit:1']);
    expect(rows.map((r) => r.pct)).toEqual([30, 10, 50]);
  });

  it('assigns stable unique keys when rows have duplicate labels', () => {
    const { t } = makeT();
    const rows = buildUsageRows(
      {
        summary: null,
        limits: [
          { label: '5h limit', used: 10, limit: 100 },
          { label: '5h limit', used: 20, limit: 100 },
        ],
      },
      t,
    );
    expect(rows.map((r) => r.key)).toEqual(['limit:0', 'limit:1']);
  });

  it('returns no rows when summary is null and limits are empty', () => {
    const { t } = makeT();
    expect(buildUsageRows({ summary: null, limits: [] }, t)).toEqual([]);
  });
});
