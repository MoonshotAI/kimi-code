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
