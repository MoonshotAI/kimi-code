const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export function parseNonNegativeIntEnv(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || !/^\d+$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function parsePositiveIntEnv(value: string | undefined): number | undefined {
  const n = parseNonNegativeIntEnv(value);
  return n !== undefined && n > 0 ? n : undefined;
}
