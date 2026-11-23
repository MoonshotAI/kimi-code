import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedQuota } from '../src/api/types';
import {
  MAX_USER_LEVEL,
  formatQuotaLabel,
  formatResetAt,
  isFreePlan,
  moneyParts,
  monthlyBreakdown,
  quotaUsageRows,
  shouldShowUpgrade,
  usagePercent,
  usageSeverity,
} from '../src/lib/planUsage';

const zhStrings: Record<string, string> = {
  'settings.planUsage.weekLimit': '每周限额',
  'settings.planUsage.hourLimit': '{n} 小时限额',
  'settings.planUsage.monthlyLimit': '每月上限',
  'settings.planUsage.resetsIn': '{duration}后重置',
  'settings.planUsage.resetDone': '已重置',
  'settings.planUsage.durationDay': '{n} 天',
  'settings.planUsage.durationHour': '{n} 小时',
  'settings.planUsage.durationMinute': '{n} 分钟',
  'settings.planUsage.durationSecond': '{n} 秒',
};

function t(key: string, params?: Record<string, unknown>): string {
  let out = zhStrings[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) out = out.replace(`{${k}}`, String(v));
  return out;
}

function quota(partial: Partial<ManagedQuota>): ManagedQuota {
  return { usages: {}, extraUsage: null, ...partial };
}

describe('quotaUsageRows', () => {
  it('renders one row per window the backend served, in payload order', () => {
    const rows = quotaUsageRows(
      quota({
        usages: {
          limit5h: { usedRatio: 0.3, resetAt: '2026-09-11T18:00:00Z' },
          limit7d: { usedRatio: 0.2, resetAt: '2026-09-17T00:00:00Z' },
          monthTotal: { usedRatio: 0.4, resetAt: '2026-10-01T00:00:00Z' },
          monthCode: { usedRatio: 0.25 },
        },
      }),
    );
    expect(rows).toEqual([
      { key: 'limit5h', entry: { usedRatio: 0.3, resetAt: '2026-09-11T18:00:00Z' } },
      { key: 'limit7d', entry: { usedRatio: 0.2, resetAt: '2026-09-17T00:00:00Z' } },
      { key: 'monthTotal', entry: { usedRatio: 0.4, resetAt: '2026-10-01T00:00:00Z' } },
    ]);
  });

  it('skips entries the backend omitted', () => {
    expect(quotaUsageRows(quota({}))).toEqual([]);
    expect(
      quotaUsageRows(quota({ usages: { monthTotal: { usedRatio: 0.4 } } })).map((r) => r.key),
    ).toEqual(['monthTotal']);
  });
});

describe('monthlyBreakdown', () => {
  it('splits the monthly total into kimi and code shares', () => {
    expect(
      monthlyBreakdown(
        quota({
          usages: { monthTotal: { usedRatio: 0.4 }, monthCode: { usedRatio: 0.25 } },
        }),
      ),
    ).toEqual({ totalRatio: 0.4, codeRatio: 0.25, kimiRatio: 0.15 });
  });

  it('returns null when the monthly window is missing', () => {
    expect(monthlyBreakdown(quota({}))).toBeNull();
    expect(monthlyBreakdown(quota({ usages: { limit7d: { usedRatio: 0.2 } } }))).toBeNull();
  });

  it('clamps the kimi share against float noise and over-100 code shares', () => {
    expect(
      monthlyBreakdown(
        quota({
          usages: { monthTotal: { usedRatio: 0.2 }, monthCode: { usedRatio: 1.4 } },
        }),
      ),
    ).toEqual({ totalRatio: 0.2, codeRatio: 1, kimiRatio: 0 });
  });
});

describe('formatQuotaLabel', () => {
  it('localizes each quota window', () => {
    expect(formatQuotaLabel('limit5h', t)).toBe('5 小时限额');
    expect(formatQuotaLabel('limit7d', t)).toBe('每周限额');
    expect(formatQuotaLabel('monthTotal', t)).toBe('每月上限');
  });
});

describe('formatResetAt', () => {
  const NOW = Date.UTC(2026, 6, 28, 0, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function after(ms: number): string {
    return new Date(NOW + ms).toISOString();
  }

  it('breaks the remaining time down like the TUI duration format', () => {
    expect(formatResetAt(after((5 * 86400 + 12 * 3600 + 57 * 60) * 1000), t)).toBe('5 天 12 小时 57 分钟后重置');
    expect(formatResetAt(after((3 * 3600 + 8 * 60) * 1000), t)).toBe('3 小时 8 分钟后重置');
    expect(formatResetAt(after(30 * 60 * 1000), t)).toBe('30 分钟后重置');
    expect(formatResetAt(after(45 * 1000), t)).toBe('45 秒后重置');
  });

  it('reads an already-passed timestamp as reset', () => {
    expect(formatResetAt(after(-1000), t)).toBe('已重置');
    expect(formatResetAt(after(0), t)).toBe('已重置');
  });

  it('returns an empty string for unparseable timestamps', () => {
    expect(formatResetAt('not-a-date', t)).toBe('');
  });
});

describe('usageSeverity / usagePercent', () => {
  it('applies the TUI thresholds (50% warn, 85% danger)', () => {
    expect(usageSeverity(0.12)).toBe('ok');
    expect(usageSeverity(0.5)).toBe('warn');
    expect(usageSeverity(0.85)).toBe('danger');
    expect(usageSeverity(Number.NaN)).toBe('ok');
  });

  it('computes a clamped percentage', () => {
    expect(usagePercent(0.12)).toBe(12);
    expect(usagePercent(1.5)).toBe(100);
    expect(usagePercent(Number.NaN)).toBe(0);
  });
});

describe('shouldShowUpgrade', () => {
  it('shows below the top level and hides at/above it', () => {
    expect(shouldShowUpgrade(0)).toBe(true);
    expect(shouldShowUpgrade(MAX_USER_LEVEL - 1)).toBe(true);
    expect(shouldShowUpgrade(MAX_USER_LEVEL)).toBe(false);
    expect(shouldShowUpgrade(MAX_USER_LEVEL + 1)).toBe(false);
  });

  it('hides when the level is unknown', () => {
    expect(shouldShowUpgrade(undefined)).toBe(false);
  });
});

describe('isFreePlan', () => {
  it('treats level 10 and below as free on the v1 plan (and when the version is unknown)', () => {
    expect(isFreePlan(10)).toBe(true);
    expect(isFreePlan(10, 1)).toBe(true);
    expect(isFreePlan(11, 1)).toBe(false);
    expect(isFreePlan(10, undefined)).toBe(true);
    expect(isFreePlan(11, undefined)).toBe(false);
  });

  it('raises the free boundary to level 15 on the v2 plan', () => {
    expect(isFreePlan(15, 2)).toBe(true);
    expect(isFreePlan(11, 2)).toBe(true);
    expect(isFreePlan(16, 2)).toBe(false);
    expect(isFreePlan(30, 2)).toBe(false);
  });
});

describe('moneyParts', () => {
  it('uses currency symbols for CNY/USD and embeds the ISO code otherwise', () => {
    expect(moneyParts(325, 'CNY')).toEqual({ symbol: '¥', number: '3.25' });
    expect(moneyParts(1000, 'USD')).toEqual({ symbol: '$', number: '10.00' });
    expect(moneyParts(250, 'EUR')).toEqual({ symbol: '', number: '2.50 EUR' });
  });
});
