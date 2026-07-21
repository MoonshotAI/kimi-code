// apps/kimi-web/src/lib/usageFormat.ts
// Pure formatting helpers for the composer context/usage-limits panel — no
// Vue, no i18n instance; callers inject `t` so the logic stays unit-testable.

export interface UsageRowInput {
  label: string;
  used: number;
  limit: number;
  resetHint?: string;
  resetAt?: string;
  windowSeconds?: number;
}

export interface UsageRowView {
  key: string;
  label: string;
  valueText: string;
  pct: number;
  resetHint?: string;
}

export type UsageTranslate = (key: string, named: Record<string, unknown>) => string;

/** Trim sub-millisecond precision so Date.parse receives the ECMAScript
 *  date-time interchange format supported consistently across browsers. */
export function normalizeResetTimestamp(value: string): string {
  return value.replace(/(\.\d{3})\d+(Z|[+-]\d{2}:\d{2})$/, '$1$2');
}

/** Percent 0–100 for a quota row; 0 when the limit is missing or zero. */
export function usageRowPct(row: { used: number; limit: number }): number {
  if (row.limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((row.used / row.limit) * 100)));
}

/** Compact localized duration ("6d 12h 36m" / "6 天 12 小时 36 分"), matching
 *  the oauth parser's day/hour/minute granularity. */
export function formatUsageDuration(totalSeconds: number, t: UsageTranslate): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(t('status.usageDurationDay', { n: days }));
  if (hours > 0) parts.push(t('status.usageDurationHour', { n: hours }));
  if (minutes > 0) parts.push(t('status.usageDurationMinute', { n: minutes }));
  if (parts.length === 0) parts.push(t('status.usageDurationSecond', { n: seconds }));
  return parts.join(' ');
}

/** Prefer the raw reset timestamp (localized, relative to now); fall back to
 *  the server-rendered hint when it is absent or unparseable. */
export function localizedResetHint(
  row: { resetAt?: string; resetHint?: string },
  t: UsageTranslate,
  now: number = Date.now(),
): string | undefined {
  if (row.resetAt !== undefined) {
    const parsed = Date.parse(normalizeResetTimestamp(row.resetAt));
    if (Number.isFinite(parsed)) {
      const diffSec = Math.floor((parsed - now) / 1000);
      return diffSec <= 0
        ? t('status.usageResetNow', {})
        : t('status.usageResetsIn', { duration: formatUsageDuration(diffSec, t) });
    }
  }
  return row.resetHint;
}

/** ISO-currency money via Intl, with a plain "12.34 CUR" fallback for unknown
 *  currency codes. */
export function formatUsageMoney(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Display rows for the panel: the weekly summary first (localized label),
 *  then each rolling limit — window-based label when the payload declares one,
 *  raw server label otherwise. */
export function buildUsageRows(
  usage: { summary: UsageRowInput | null; limits: UsageRowInput[] },
  t: UsageTranslate,
): UsageRowView[] {
  const rows: UsageRowView[] = [];
  if (usage.summary !== null) {
    rows.push(toRowView(usage.summary, 'summary', t('status.usageWeekly', {}), t));
  }
  for (const [index, row] of usage.limits.entries()) {
    rows.push(
      toRowView(
        row,
        `limit:${String(index)}`,
        row.windowSeconds !== undefined
          ? t('status.usageWindowLimit', { duration: formatUsageDuration(row.windowSeconds, t) })
          : row.label,
        t,
      ),
    );
  }
  return rows;
}

function toRowView(
  row: UsageRowInput,
  key: string,
  label: string,
  t: UsageTranslate,
): UsageRowView {
  const pct = usageRowPct(row);
  return {
    key,
    label,
    valueText: t('status.statusContextValue', {
      used: String(row.used),
      max: String(row.limit),
      pct,
    }),
    pct,
    resetHint: localizedResetHint(row, t),
  };
}
