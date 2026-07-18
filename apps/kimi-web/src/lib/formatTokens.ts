// Format a token count for compact display. Context sizes are powers of two
// (262144 = 256×1024, 1048576 = 1024×1024), so the k/M units are 1024-based —
// a 256k context must render as "256k", never "262k".
// - < 1024:    as-is ("512")
// - k range:   one decimal under 100k, rounded above ("49.4k", "256k")
// - M range:   one decimal, trailing ".0" dropped ("1M", "1.5M")
export function formatTokens(n: number): string {
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
