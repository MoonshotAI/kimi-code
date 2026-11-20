export function formatTokens(n: number): string {
  if (n >= 1024 * 1024) return `${trimDecimal(n / (1024 * 1024))}M`;
  if (n >= 1024) {
    const k = n / 1024;
    return `${k >= 100 ? Math.round(k) : trimDecimal(k)}k`;
  }
  return String(n);
}

export function formatTokenEstimate(n: number): string {
  return `~${formatTokens(n)}`;
}

export function formatTokenShare(tokens: number, total: number): string {
  const pct = total > 0 ? (tokens / total) * 100 : 0;
  return pct > 0 && pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

function trimDecimal(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
