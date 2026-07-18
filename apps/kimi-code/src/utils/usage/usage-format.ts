/**
 * Formatting helpers for the `/usage` slash command.
 *
 * Kept pure + ANSI-free so they're trivial to unit-test; the slash
 * command itself chalks the colour afterwards.
 */

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
