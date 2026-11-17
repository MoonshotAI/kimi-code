import { type ManagedQuota, type ManagedQuotaEntry } from '@moonshot-ai/kimi-code-oauth';

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1024 * 1024) return `${trimDecimal(n / (1024 * 1024))}M`;
  if (n >= 1024) {
    const k = n / 1024;
    return `${k >= 100 ? Math.round(k) : trimDecimal(k)}k`;
  }
  return String(n);
}

function trimDecimal(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function usagePercent(used: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((used / max) * 100)));
}

export function usagePercentFromRatio(ratio: number): number {
  return Math.min(100, Math.max(0, Math.ceil(safeUsageRatio(ratio) * 100)));
}

export function renderProgressBar(ratio: number, width = 20, filled = '█', empty = '░'): string {
  const clamped = safeUsageRatio(ratio);
  const filledCount = Math.round(clamped * width);
  return filled.repeat(filledCount) + empty.repeat(Math.max(0, width - filledCount));
}

export function safeUsageRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
}

export function ratioSeverity(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.85) return 'danger';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}

export interface MonthlyUsageBreakdown {
  readonly kimiRatio: number;
  readonly codeRatio: number;
}

export interface QuotaUsageRow {
  readonly name: string;
  readonly usedRatio: number;
  readonly resetAt?: string;
  readonly breakdown?: MonthlyUsageBreakdown;
}

export function quotaUsageRows(quota: ManagedQuota): QuotaUsageRow[] {
  const rows: QuotaUsageRow[] = [];
  const push = (
    name: string,
    entry: ManagedQuotaEntry | undefined,
    breakdown?: MonthlyUsageBreakdown,
  ): void => {
    if (entry === undefined) return;
    rows.push({ name, usedRatio: entry.usedRatio, resetAt: entry.resetAt, breakdown });
  };
  push('5h limit', quota.usages.limit5h);
  push('Weekly limit', quota.usages.limit7d);
  push('Monthly limit', quota.usages.monthTotal, monthlyBreakdown(quota));
  return rows;
}

function monthlyBreakdown(quota: ManagedQuota): MonthlyUsageBreakdown | undefined {
  const total = quota.usages.monthTotal;
  if (total === undefined) return undefined;
  const codeRatio = safeUsageRatio(quota.usages.monthCode?.usedRatio ?? 0);
  const kimiRatio = safeUsageRatio(Math.round((total.usedRatio - codeRatio) * 1e6) / 1e6);
  return { kimiRatio, codeRatio };
}
