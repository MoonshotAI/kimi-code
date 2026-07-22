// apps/kimi-web/src/lib/planUsage.ts
// Presentation helpers for the settings Plan Usage / Booster sections. The
// usage payload arrives pre-formatted from the server (English label + reset
// hint strings, mirroring the TUI `/usage` panel) — these helpers localize
// what is safely parseable, pass everything else through verbatim, and share
// the TUI's severity thresholds and currency-symbol rules.

export type UsageTranslator = (key: string, params?: Record<string, unknown>) => string;

/** "Weekly limit" / "5h limit" / "3d limit" / "30m limit" → localized; anything
    else (server-supplied custom names) passes through. */
export function localizeUsageLabel(label: string, t: UsageTranslator): string {
  if (label === 'Weekly limit') return t('settings.planUsage.weeklyLimit');
  const window = /^(\d+)([hdm]) limit$/.exec(label);
  if (window !== null) {
    const [, n, unit] = window;
    if (unit === 'h') return t('settings.planUsage.hourLimit', { n });
    if (unit === 'd') return t('settings.planUsage.dayLimit', { n });
    return t('settings.planUsage.minuteLimit', { n });
  }
  return label;
}

/** "resets in 5d 12h 57m" / "reset" → localized; unparseable hints pass through. */
export function localizeResetHint(hint: string, t: UsageTranslator): string {
  if (hint === 'reset') return t('settings.planUsage.resetDone');
  const m = /^resets in (.+)$/.exec(hint);
  if (m === null) return hint;
  const parts: string[] = [];
  for (const token of m[1]!.split(/\s+/)) {
    const unit = /^(\d+)([dhms])$/.exec(token);
    if (unit === null) return hint; // unexpected token → keep the original line
    const [, n, u] = unit;
    if (u === 'd') parts.push(t('settings.planUsage.durationDay', { n }));
    else if (u === 'h') parts.push(t('settings.planUsage.durationHour', { n }));
    else if (u === 'm') parts.push(t('settings.planUsage.durationMinute', { n }));
    else parts.push(t('settings.planUsage.durationSecond', { n }));
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
