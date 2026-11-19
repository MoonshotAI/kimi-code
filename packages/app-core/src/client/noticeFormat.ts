export function formatDetailValue(value: unknown): string {
  if (value instanceof Error) {
    if (typeof value.stack === 'string' && value.stack) return value.stack;
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatProviderErrorMessage(message: string): string {
  try {
    return JSON.stringify(JSON.parse(message.trim())) ?? message;
  } catch {
    return message;
  }
}

export function errorInfo(err: unknown): { name: string | undefined; message: string | undefined } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  const record = err as { name?: unknown; message?: unknown } | null;
  return {
    name: typeof record?.name === 'string' ? record.name : undefined,
    message: typeof record?.message === 'string' ? record.message : undefined,
  };
}

export function errorStack(err: unknown): string | undefined {
  return err instanceof Error && typeof err.stack === 'string' && err.stack ? err.stack : undefined;
}

export function formatTimestamp(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return `${Math.round(ms)}ms`;
}
