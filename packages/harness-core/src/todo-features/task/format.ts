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

export function describeToolArguments(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const description = (parsed as { description?: unknown }).description;
    if (typeof description === 'string' && description.trim() !== '') return description;
  } catch {
  }
  return undefined;
}
