/**
 * Render cron-facing timestamps in local wall time with an explicit
 * numeric offset. Cron expressions are evaluated in local time, so the
 * tool output should preserve that mental model while remaining
 * unambiguous and parseable as ISO 8601.
 */
export function formatLocalIsoWithOffset(ms: number): string {
  const date = new Date(ms);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(
    3,
    '0',
  )}${offset}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
