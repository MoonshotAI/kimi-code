export function downloadTimeLeftMs(receivedBytes: number, totalBytes: number, bytesPerSecond: number | undefined): number | undefined {
  if (totalBytes <= 0 || bytesPerSecond === undefined || !(bytesPerSecond > 0) || receivedBytes > totalBytes) return undefined;
  return ((totalBytes - receivedBytes) * 1_000) / bytesPerSecond;
}

export type DownloadTimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export function downloadTimeLeftParts(ms: number): { unit: DownloadTimeUnit; count: number } {
  const seconds = Math.max(0, ms) / 1_000;
  if (Math.round(seconds) < 60) return { unit: 'seconds', count: Math.round(seconds) };
  const minutes = seconds / 60;
  if (Math.round(minutes) < 60) return { unit: 'minutes', count: Math.round(minutes) };
  const hours = minutes / 60;
  if (Math.round(hours) < 24) return { unit: 'hours', count: Math.round(hours) };
  return { unit: 'days', count: Math.round(hours / 24) };
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatDownloadBytes(value: number): string {
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1_024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(amount)} B` : `${amount.toFixed(amount < 100 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}
