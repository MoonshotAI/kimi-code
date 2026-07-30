// apps/web/src/lib/planUsage.ts
// Presentation helpers for the settings Plan Usage / Booster sections. The
// usage payload arrives structured from the server (window unit + absolute
// reset timestamp) — these helpers localize labels and reset hints, and share
// the TUI's severity thresholds and currency-symbol rules.

import type { UsageRow, UsageWindow } from '../api/types';

export type UsageTranslator = (key: string, params?: Record<string, unknown>) => string;

/** Structural lookup by renewal window — never match on `name`, which is
    server-supplied free text. */
export function findUsageByWindow(
  limits: UsageRow[],
  duration: number,
  unit: UsageWindow['unit'],
): UsageRow | undefined {
  return limits.find((row) => row.window?.duration === duration && row.window?.unit === unit);
}

/** Top plan level in the backend level tables (domains 1 and 3 both cap at 30
    today) — a backend level bump must update this in step. */
export const MAX_USER_LEVEL = 30;

/** The upgrade entry only makes sense below the top plan level; an unknown
    level (profile not loaded yet) stays hidden. */
export function shouldShowUpgrade(userLevel: number | undefined): boolean {
  return userLevel !== undefined && userLevel < MAX_USER_LEVEL;
}

/** Windowed rows get a localized "Nh limit"-style label; rows with only a
    server-supplied custom name pass through verbatim; anything else falls
    back to a generic label. */
export function formatUsageLabel(row: UsageRow, t: UsageTranslator): string {
  if (row.window !== undefined) {
    const { duration, unit } = row.window;
    if (unit === 'week') return t('settings.planUsage.weekLimit', { n: duration });
    if (unit === 'day') return t('settings.planUsage.dayLimit', { n: duration });
    if (unit === 'hour') return t('settings.planUsage.hourLimit', { n: duration });
    return t('settings.planUsage.minuteLimit', { n: duration });
  }
  return row.name ?? t('settings.planUsage.genericLimit');
}

/** ISO reset timestamp → localized "resets in …" hint; an already-passed
    timestamp reads as reset, an unparseable one yields '' (caller hides it). */
export function formatResetAt(resetAt: string, t: UsageTranslator): string {
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(resetMs)) return '';
  const totalSeconds = Math.floor((resetMs - Date.now()) / 1000);
  if (totalSeconds <= 0) return t('settings.planUsage.resetDone');
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(t('settings.planUsage.durationDay', { n: days }));
    parts.push(t('settings.planUsage.durationHour', { n: hours }));
    parts.push(t('settings.planUsage.durationMinute', { n: minutes }));
  } else if (hours > 0) {
    parts.push(t('settings.planUsage.durationHour', { n: hours }));
    parts.push(t('settings.planUsage.durationMinute', { n: minutes }));
  } else if (minutes > 0) {
    parts.push(t('settings.planUsage.durationMinute', { n: minutes }));
  } else {
    parts.push(t('settings.planUsage.durationSecond', { n: totalSeconds }));
  }
  return t('settings.planUsage.resetsIn', { duration: parts.join(' ') });
}

/** Usage-ratio → semantic severity, same thresholds as the TUI `/usage` panel. */
export function usageSeverity(used: number, limit: number): 'ok' | 'warn' | 'danger' {
  if (limit <= 0) return 'ok';
  const ratio = used / limit;
  if (ratio >= 0.85) return 'danger';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}

export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** Cents → currency parts: symbol for CNY/USD (same rules as the TUI), the
    ISO code embedded in the number otherwise. */
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
