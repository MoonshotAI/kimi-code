/**
 * Formatting helpers for the `/usage` slash command.
 *
 * Kept pure + ANSI-free so they're trivial to unit-test; the slash
 * command itself chalks the colour afterwards.
 */

import { type ManagedQuota, type ManagedQuotaEntry } from '@moonshot-ai/kimi-code-oauth';

/**
 * Format a token count in 1024-based units: context sizes are powers of
 * two, so 262144 reads as "256k", not "262.1k". k values at or above
 * 100 are rounded to whole numbers ("977k").
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1024 * 1024) return `${trimDecimal(n / (1024 * 1024))}M`;
  if (n >= 1024) {
    const k = n / 1024;
    return `${k >= 100 ? Math.round(k) : trimDecimal(k)}k`;
  }
  return String(n);
}

/** One decimal place, dropping a redundant ".0" ("1.0" → "1", "1.5" stays). */
function trimDecimal(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Usage as a whole-number percentage of `max`, ceiled so any non-zero
 * usage shows at least 1%, clamped to [0, 100]. A non-positive or
 * non-finite `max` reports 0.
 */
export function usagePercent(used: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((used / max) * 100)));
}

/** `usagePercent` for callers that only know the ratio (NaN-safe). */
export function usagePercentFromRatio(ratio: number): number {
  return Math.min(100, Math.max(0, Math.ceil(safeUsageRatio(ratio) * 100)));
}

/**
 * Build a `[███░░░░░░░]` style bar. Returns a plain-ASCII string with
 * `filled`/`empty` glyphs — colouring is the caller's responsibility.
 */
export function renderProgressBar(ratio: number, width = 20, filled = '█', empty = '░'): string {
  const clamped = safeUsageRatio(ratio);
  const filledCount = Math.round(clamped * width);
  return filled.repeat(filledCount) + empty.repeat(Math.max(0, width - filledCount));
}

export function safeUsageRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
}

/**
 * Map a usage ratio to a semantic colour token — the `/usage` renderer
 * translates these into palette hex values.
 */
export function ratioSeverity(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio >= 0.85) return 'danger';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}

/**
 * The kimi/code split of the new plan's monthly quota: `codeRatio` is the
 * code-typed share of the monthly total as served, `kimiRatio` the
 * remainder, clamped against float noise.
 */
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

/**
 * Assemble the plan-usage rows for the `/usage` report from the managed
 * quota: one row per quota window the backend served — 5h, weekly,
 * monthly (with its kimi/code breakdown) — in payload order. Entries the
 * backend omitted are skipped.
 */
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
