import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRow } from '../../src/renderer/api/types';
import {
  MAX_USER_LEVEL,
  findUsageByWindow,
  formatResetAt,
  formatUsageLabel,
  moneyParts,
  shouldShowUpgrade,
  usagePercent,
  usageSeverity,
} from '../../src/renderer/lib/planUsage';

// Minimal zh-flavoured translator double: records params, renders readable keys.
const zhStrings: Record<string, string> = {
  'settings.planUsage.weekLimit': '每周限额',
  'settings.planUsage.genericLimit': '限额',
  'settings.planUsage.hourLimit': '{n} 小时限额',
  'settings.planUsage.dayLimit': '{n} 天限额',
  'settings.planUsage.minuteLimit': '{n} 分钟限额',
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

function row(partial: Partial<UsageRow>): UsageRow {
  return { used: 0, limit: 0, ...partial };
}

describe('formatUsageLabel', () => {
  it('localizes each window unit', () => {
    expect(formatUsageLabel(row({ window: { duration: 1, unit: 'week' } }), t)).toBe('每周限额');
    expect(formatUsageLabel(row({ window: { duration: 3, unit: 'day' } }), t)).toBe('3 天限额');
    expect(formatUsageLabel(row({ window: { duration: 5, unit: 'hour' } }), t)).toBe('5 小时限额');
    expect(formatUsageLabel(row({ window: { duration: 30, unit: 'minute' } }), t)).toBe('30 分钟限额');
  });

  it('prefers the window over a server-supplied name', () => {
    expect(formatUsageLabel(row({ name: 'Coding quota', window: { duration: 1, unit: 'week' } }), t)).toBe('每周限额');
  });

  it('passes a windowless custom name through verbatim', () => {
    expect(formatUsageLabel(row({ name: 'Coding quota' }), t)).toBe('Coding quota');
    expect(formatUsageLabel(row({ name: 'Limit #2' }), t)).toBe('Limit #2');
  });

  it('falls back to the generic label', () => {
    expect(formatUsageLabel(row({}), t)).toBe('限额');
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
    expect(usageSeverity(12, 100)).toBe('ok');
    expect(usageSeverity(50, 100)).toBe('warn');
    expect(usageSeverity(85, 100)).toBe('danger');
    expect(usageSeverity(1, 0)).toBe('ok');
  });

  it('computes a clamped percentage', () => {
    expect(usagePercent(12, 100)).toBe(12);
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(1, 0)).toBe(0);
  });
});

describe('findUsageByWindow', () => {
  const fiveHour = row({ window: { duration: 5, unit: 'hour' } });
  const weekly = row({ window: { duration: 1, unit: 'week' } });

  it('matches the window structurally', () => {
    expect(findUsageByWindow([weekly, fiveHour], 5, 'hour')).toBe(fiveHour);
    expect(findUsageByWindow([weekly, fiveHour], 1, 'week')).toBe(weekly);
  });

  it('ignores rows without a window and partial matches', () => {
    expect(findUsageByWindow([row({ name: '5h booster' })], 5, 'hour')).toBeUndefined();
    expect(findUsageByWindow([row({ window: { duration: 5, unit: 'day' } })], 5, 'hour')).toBeUndefined();
    expect(findUsageByWindow([row({ window: { duration: 6, unit: 'hour' } })], 5, 'hour')).toBeUndefined();
    expect(findUsageByWindow([], 5, 'hour')).toBeUndefined();
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

describe('moneyParts', () => {
  it('uses currency symbols for CNY/USD and embeds the ISO code otherwise', () => {
    expect(moneyParts(325, 'CNY')).toEqual({ symbol: '¥', number: '3.25' });
    expect(moneyParts(1000, 'USD')).toEqual({ symbol: '$', number: '10.00' });
    expect(moneyParts(250, 'EUR')).toEqual({ symbol: '', number: '2.50 EUR' });
  });
});
