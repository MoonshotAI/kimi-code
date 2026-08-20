/**
 * Formats an epoch millisecond timestamp into HH:MM:SS (today) or YYYY-MM-DD HH:MM:SS (before today).
 * If endedAtMs is provided, appends duration in seconds e.g. (took 3s).
 * Returns empty string if timestamp is invalid or undefined.
 */
export function timestampDisplayContextKey(
  timestampMs?: number,
  nowMs = Date.now(),
): string {
  if (!isValidTimestamp(timestampMs)) return '';
  const now = new Date(nowMs);
  const timestampOffset = new Date(timestampMs).getTimezoneOffset();
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}:${now.getTimezoneOffset()}:${timestampOffset}`;
}

export function formatTimestamp(
  timestampMs?: number,
  endedAtMs?: number,
  nowMs = Date.now(),
): string {
  if (!isValidTimestamp(timestampMs)) {
    return '';
  }
  const date = new Date(timestampMs);
  const now = new Date(nowMs);
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const pad = (n: number) => String(n).padStart(2, '0');
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());

  let text = isToday
    ? `${h}:${m}:${s}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${h}:${m}:${s}`;

  const durationMs = endedAtMs === undefined ? undefined : endedAtMs - timestampMs;
  if (
    isValidTimestamp(endedAtMs) &&
    durationMs !== undefined &&
    Number.isFinite(durationMs) &&
    durationMs >= 0
  ) {
    const durationSec = Math.round(durationMs / 1000);
    if (durationSec < 60) {
      text += ` (took ${durationSec}s)`;
    } else {
      const min = Math.floor(durationSec / 60);
      const sec = durationSec % 60;
      text += ` (took ${min}m${sec}s)`;
    }
  }

  return text;
}

function isValidTimestamp(timestampMs: number | undefined): timestampMs is number {
  return (
    timestampMs !== undefined &&
    timestampMs !== 0 &&
    Number.isFinite(timestampMs) &&
    Number.isFinite(new Date(timestampMs).getTime())
  );
}
