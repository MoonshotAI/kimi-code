import { isPlainObject } from './pure';

export type GetEnv = (name: string) => string | undefined;

export type EnvBinding =
  | string
  | {
      readonly env: string;
      readonly deprecatedEnv?: string;
      readonly parse?: (raw: string) => unknown;
      readonly default?: unknown;
    };

export type EnvBindings<T> = EnvBinding | { [K in keyof T]?: EnvBinding | EnvBindings<T[K]> };

export type AnyEnvBindings = EnvBinding | { readonly [key: string]: EnvBinding | AnyEnvBindings };

export function isEnvBinding(value: unknown): value is EnvBinding {
  return typeof value === 'string' || (isPlainObject(value) && 'env' in value);
}

function parseBoundRaw(binding: EnvBinding, raw: string): unknown {
  return typeof binding === 'string' ? raw : binding.parse !== undefined ? binding.parse(raw) : raw;
}

function resolveBinding(
  binding: EnvBinding,
  getEnv: GetEnv,
  existing: unknown,
  onDeprecatedEnv?: (oldName: string, newName: string) => void,
): unknown {
  if (typeof binding !== 'string') {
    const raw = getEnv(binding.env);
    if (raw !== undefined) {
      const parsed = parseBoundRaw(binding, raw);
      if (parsed !== undefined) return parsed;
    }
    if (binding.deprecatedEnv !== undefined) {
      const deprecatedRaw = getEnv(binding.deprecatedEnv);
      if (deprecatedRaw !== undefined) {
        const parsed = parseBoundRaw(binding, deprecatedRaw);
        if (parsed !== undefined) {
          onDeprecatedEnv?.(binding.deprecatedEnv, binding.env);
          return parsed;
        }
      }
    }
  } else {
    const raw = getEnv(binding);
    if (raw !== undefined) return raw;
  }
  if (typeof binding === 'object' && binding.default !== undefined && existing === undefined) {
    return binding.default;
  }
  return existing;
}

function applyEnvBindings(
  target: Record<string, unknown>,
  bindings: AnyEnvBindings,
  getEnv: GetEnv,
  onDeprecatedEnv?: (oldName: string, newName: string) => void,
): void {
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding === undefined) continue;
    if (isEnvBinding(binding)) {
      const resolved = resolveBinding(binding, getEnv, target[key], onDeprecatedEnv);
      if (resolved !== undefined) target[key] = resolved;
    } else {
      const child: Record<string, unknown> = isPlainObject(target[key]) ? { ...target[key] } : {};
      target[key] = child;
      applyEnvBindings(child, binding as AnyEnvBindings, getEnv, onDeprecatedEnv);
      if (Object.keys(child).length === 0) {
        delete target[key];
      }
    }
  }
}

export function applySectionEnv(
  base: unknown,
  bindings: AnyEnvBindings,
  getEnv: GetEnv,
  onDeprecatedEnv?: (oldName: string, newName: string) => void,
): unknown {
  if (isEnvBinding(bindings)) {
    return resolveBinding(bindings, getEnv, base, onDeprecatedEnv);
  }
  const target: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  applyEnvBindings(target, bindings, getEnv, onDeprecatedEnv);
  return target;
}
