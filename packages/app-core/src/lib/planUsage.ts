import type { ManagedQuota, QuotaEntry } from '../api/types';
import { formatDuration } from './formatDuration';

export type UsageTranslator = (key: string, params?: Record<string, unknown>) => string;

export type QuotaUsageKey = 'limit5h' | 'limit7d' | 'monthTotal';

export interface QuotaUsageRow {
  key: QuotaUsageKey;
  entry: QuotaEntry;
}

export function quotaUsageRows(quota: ManagedQuota): QuotaUsageRow[] {
  const rows: QuotaUsageRow[] = [];
  if (quota.usages.limit5h !== undefined) {
    rows.push({ key: 'limit5h', entry: quota.usages.limit5h });
  }
  if (quota.usages.limit7d !== undefined) {
    rows.push({ key: 'limit7d', entry: quota.usages.limit7d });
  }
  if (quota.usages.monthTotal !== undefined) {
    rows.push({ key: 'monthTotal', entry: quota.usages.monthTotal });
  }
  return rows;
}

export interface MonthlyBreakdown {
  totalRatio: number;
  codeRatio: number;
  kimiRatio: number;
}

export function monthlyBreakdown(quota: ManagedQuota): MonthlyBreakdown | null {
  const total = quota.usages.monthTotal;
  if (total === undefined) return null;
  const codeRatio = clampRatio(quota.usages.monthCode?.usedRatio ?? 0);
  const kimiRatio = clampRatio(Math.round((total.usedRatio - codeRatio) * 1e6) / 1e6);
  return { totalRatio: total.usedRatio, codeRatio, kimiRatio };
}

export function formatQuotaLabel(key: QuotaUsageKey, t: UsageTranslator): string {
  switch (key) {
    case 'limit5h':
      return t('settings.planUsage.hourLimit', { n: 5 });
    case 'limit7d':
      return t('settings.planUsage.weekLimit', { n: 1 });
    case 'monthTotal':
      return t('settings.planUsage.monthlyLimit');
  }
}

export function formatResetAt(resetAt: string, t: UsageTranslator, locale: string = 'en'): string {
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(resetMs)) return '';
  const remainingMs = resetMs - Date.now();
  if (remainingMs < 1000) return t('settings.planUsage.resetDone');
  return t('settings.planUsage.resetsIn', { duration: formatDuration(remainingMs, locale) });
}

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
}

export function usageSeverity(ratio: number): 'ok' | 'warn' | 'danger' {
  const r = clampRatio(ratio);
  if (r >= 0.85) return 'danger';
  if (r >= 0.5) return 'warn';
  return 'ok';
}

export function usagePercent(ratio: number): number {
  return Math.round(clampRatio(ratio) * 100);
}

export const MAX_USER_LEVEL = 30;

export function shouldShowUpgrade(userLevel: number | undefined): boolean {
  return userLevel !== undefined && userLevel < MAX_USER_LEVEL;
}

export const FREE_USER_LEVEL = 10;
export const FREE_USER_LEVEL_V2 = 15;

export function isFreePlan(userLevel: number, goodsVersion?: number): boolean {
  return userLevel <= (goodsVersion === 2 ? FREE_USER_LEVEL_V2 : FREE_USER_LEVEL);
}

export function moneyParts(cents: number, currency: string): { symbol: string; number: string } {
  const formatted = (cents / 100).toFixed(2);
  switch (currency.toUpperCase()) {
    case 'CNY':
      return { symbol: '¥', number: formatted };
    case 'USD':
      return { symbol: '$', number: formatted };
    default:
      return { symbol: '', number: `${formatted} ${currency}` };
  }
}
