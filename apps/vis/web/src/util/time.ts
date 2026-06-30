/** Format an epoch-ms timestamp as a short relative string ("2m ago", "3h ago"). */
export function formatRelativeTime(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '—';
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Format an epoch-ms timestamp as ISO-ish local time (YYYY-MM-DD HH:MM:SS). */
export function formatAbsoluteTime(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '—';
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format an epoch-ms timestamp as HH:MM:SS (wall clock). */
export function formatWallClock(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '--:--:--';
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration in ms as a compact human string (e.g. "840ms", "2.4s", "1m03s"). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** Format a token count compactly (e.g. "512", "12.4k", "1.20M"). */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
