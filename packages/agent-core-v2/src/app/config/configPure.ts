/**
 * `config` domain (L2) — pure helper functions for config values.
 *
 * Provides side-effect-free helpers used by config services, including plain
 * object detection, deep equality, deep merge, undefined stripping, and error
 * formatting.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

export function deepMerge<T>(base: T | undefined, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    out[key] = isPlainObject(bv) && isPlainObject(pv) ? deepMerge(bv, pv) : pv;
  }
  return out as T;
}

export function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v !== undefined) {
      out[key as keyof T] = v as T[keyof T];
    }
  }
  return out;
}

export function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
