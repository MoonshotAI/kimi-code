// apps/kimi-web/src/lib/usageFormat.ts
// Pure formatting helpers for the /usage panel — no Vue, no i18n, no side
// effects. Rendering semantics mirror the TUI usage report
// (apps/kimi-code/src/tui/components/messages/usage-panel.ts).

export interface UsageWindowLike {
  duration: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
}

export interface UsageRowLike {
  name?: string;
  window?: UsageWindowLike;
  used: number;
  limit: number;
  resetAt?: string;
}

/** Ratio of a plan-usage row, clamped to 0–1; 0 when the limit is not positive. */
export function usageRatio(row: Pick<UsageRowLike, 'used' | 'limit'>): number {
  return row.limit > 0 ? Math.max(0, Math.min(row.used / row.limit, 1)) : 0;
}

/** Whole-percent form of `usageRatio` ("42% used"). */
export function usagePercent(row: Pick<UsageRowLike, 'used' | 'limit'>): number {
  return Math.round(usageRatio(row) * 100);
}

/**
 * Which label a plan-usage row gets: a weekly limit, an N-unit limit, or a
 * named/fallback row. The component maps this to i18n keys.
 */
export function usageWindowKind(
  row: Pick<UsageRowLike, 'window'>,
): { kind: 'week' } | { kind: 'hour' | 'day' | 'minute'; n: number } | { kind: 'named' } {
  const w = row.window;
  if (w === undefined) return { kind: 'named' };
  if (w.unit === 'week') return { kind: 'week' };
  return { kind: w.unit, n: w.duration };
}

/**
 * Seconds until a reset timestamp, or null when the timestamp is missing or
 * unparseable. Negative/zero means the reset moment has passed.
 */
export function countdownSeconds(resetAt: string | undefined, now: number): number | null {
  if (resetAt === undefined) return null;
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((parsed - now) / 1000);
}

/** Compact countdown: "2d 3h" / "3h 4m" / "5m" (mirrors the TUI formatDuration). */
export function formatCountdown(totalSec: number): string {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥';
    case 'USD':
      return '$';
    default:
      return '';
  }
}

/** Cents → display string: "¥50.00" / "$12.34" / "12.34 EUR" for unknown codes. */
export function formatCurrency(cents: number, currency: string): string {
  const symbol = currencySymbol(currency);
  const main = (cents / 100).toFixed(2);
  return symbol.length > 0 ? `${symbol}${main}` : `${main} ${currency}`;
}
