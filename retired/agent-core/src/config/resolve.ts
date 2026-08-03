import { ErrorCodes, KimiError } from '#/errors';

const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface ResolveConfigValueInput<T> {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envKey: string;
  readonly configValue?: T;
  readonly defaultValue: T;
  readonly parseEnv: (value: string | undefined) => T | undefined;
}

export function resolveConfigValue<T>(input: ResolveConfigValueInput<T>): T {
  return (
    input.parseEnv(input.env?.[input.envKey]) ??
    input.configValue ??
    input.defaultValue
  );
}

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * Parse a floating-point environment value (e.g. `KIMI_MODEL_TEMPERATURE`).
 * Returns `undefined` when unset/blank; throws `KimiError(CONFIG_INVALID)` on a
 * non-numeric value so a typo fails fast like the other `KIMI_MODEL_*` vars.
 * No range validation — callers pass values the upstream API accepts.
 */
export function parseFloatEnv(value: string | undefined, varName: string): number | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `${varName} must be a number, got "${value}".`);
  }
  return parsed;
}
