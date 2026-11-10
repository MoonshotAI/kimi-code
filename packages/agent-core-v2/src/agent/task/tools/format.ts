import { formatTaskWallTime } from '#/agent/task/wallTime';

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function fieldName(key: string): string {
  return key.replaceAll(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

export function formatPlainObject(record: object): string {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${fieldName(key)}: ${formatValue(value)}`)
    .join('\n');
}

export function formatTaskRecord<T extends { readonly startedAt: number; readonly endedAt: number | null }>(
  record: T,
): string {
  const { startedAt: _startedAt, endedAt: _endedAt, ...rest } = record;
  const body = formatPlainObject(rest);
  const wallTime = `Wall time: ${formatTaskWallTime(record)}`;
  return body.length === 0 ? wallTime : `${wallTime}\n${body}`;
}
