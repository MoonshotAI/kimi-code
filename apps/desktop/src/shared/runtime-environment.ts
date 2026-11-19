export const RUNTIME_ENVIRONMENT_KEYS = [
  'KIMI_CODE_HOME',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_CODE_BASE_URL',
  'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
] as const;

export type RuntimeEnvironmentKey = typeof RUNTIME_ENVIRONMENT_KEYS[number];
export type RuntimeEnvironmentOverrides = Partial<Record<RuntimeEnvironmentKey, string>>;

export type RuntimeEnvironmentGetResult =
  | { status: 'ok'; overrides: RuntimeEnvironmentOverrides }
  | { status: 'unavailable' }
  | { status: 'error'; error: string };

export type RuntimeEnvironmentSaveResult =
  | { status: 'relaunching' }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'invalid'; field: RuntimeEnvironmentKey }
  | { status: 'error'; error: string };

function isRuntimeEnvironmentKey(value: string): value is RuntimeEnvironmentKey {
  return (RUNTIME_ENVIRONMENT_KEYS as readonly string[]).includes(value);
}

export function asRuntimeEnvironmentOverrides(value: unknown): RuntimeEnvironmentOverrides | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const overrides: RuntimeEnvironmentOverrides = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRuntimeEnvironmentKey(key) || typeof item !== 'string') return null;
    overrides[key] = item;
  }
  return overrides;
}

export function asRuntimeEnvironmentGetResult(value: unknown): RuntimeEnvironmentGetResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { status?: unknown; overrides?: unknown; error?: unknown };
  if (candidate.status === 'unavailable') return { status: 'unavailable' };
  if (candidate.status === 'error' && typeof candidate.error === 'string') {
    return { status: 'error', error: candidate.error };
  }
  if (candidate.status !== 'ok') return null;
  const overrides = asRuntimeEnvironmentOverrides(candidate.overrides);
  return overrides === null ? null : { status: 'ok', overrides };
}

export function asRuntimeEnvironmentSaveResult(value: unknown): RuntimeEnvironmentSaveResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { status?: unknown; field?: unknown; error?: unknown };
  if (candidate.status === 'relaunching' || candidate.status === 'cancelled' || candidate.status === 'unavailable') {
    return { status: candidate.status };
  }
  if (candidate.status === 'error' && typeof candidate.error === 'string') {
    return { status: 'error', error: candidate.error };
  }
  if (candidate.status === 'invalid' && typeof candidate.field === 'string' && isRuntimeEnvironmentKey(candidate.field)) {
    return { status: 'invalid', field: candidate.field };
  }
  return null;
}
