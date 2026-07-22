import { describe, expect, it } from 'vitest';
import {
  localizeResetHint,
  localizeUsageLabel,
  moneyParts,
  usagePercent,
  usageSeverity,
} from '../../src/renderer/lib/planUsage';

// Minimal zh-flavoured translator double: records params, renders readable keys.
const zhStrings: Record<string, string> = {
  'settings.planUsage.weeklyLimit': '每周限额',
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

describe('localizeUsageLabel', () => {
  it('maps the weekly and windowed limit labels', () => {
    expect(localizeUsageLabel('Weekly limit', t)).toBe('每周限额');
    expect(localizeUsageLabel('5h limit', t)).toBe('5 小时限额');
    expect(localizeUsageLabel('3d limit', t)).toBe('3 天限额');
    expect(localizeUsageLabel('30m limit', t)).toBe('30 分钟限额');
  });

  it('passes unknown labels through verbatim', () => {
    expect(localizeUsageLabel('Coding quota', t)).toBe('Coding quota');
    expect(localizeUsageLabel('Limit #2', t)).toBe('Limit #2');
  });
});

describe('localizeResetHint', () => {
  it('localizes duration hints', () => {
    expect(localizeResetHint('resets in 5d 12h 57m', t)).toBe('5 天 12 小时 57 分钟后重置');
    expect(localizeResetHint('resets in 3h 8m', t)).toBe('3 小时 8 分钟后重置');
    expect(localizeResetHint('resets in 45s', t)).toBe('45 秒后重置');
  });

  it('maps the already-reset state', () => {
    expect(localizeResetHint('reset', t)).toBe('已重置');
  });

  it('passes unparseable hints through', () => {
    expect(localizeResetHint('resets at 2026-07-27T05:20:51Z', t)).toBe('resets at 2026-07-27T05:20:51Z');
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

describe('moneyParts', () => {
  it('uses currency symbols for CNY/USD and embeds the ISO code otherwise', () => {
    expect(moneyParts(325, 'CNY')).toEqual({ symbol: '¥', number: '3.25' });
    expect(moneyParts(1000, 'USD')).toEqual({ symbol: '$', number: '10.00' });
    expect(moneyParts(250, 'EUR')).toEqual({ symbol: '', number: '2.50 EUR' });
  });
});
