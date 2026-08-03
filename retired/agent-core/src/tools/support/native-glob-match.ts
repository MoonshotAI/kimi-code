let nativeModule: Record<string, unknown> | null | undefined;

function getNative(): Record<string, unknown> | undefined {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('@moonshot-ai/kimi-native-tools') as Record<string, unknown>;
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

function simpleGlobMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return value === pattern;

  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${reStr}$`).test(value);
  } catch {
    return false;
  }
}

export function tryNativeGlobMatch(
  value: string,
  pattern: string,
  options?: { nocase?: boolean },
): boolean {
  // Neither the native matcher nor the simple fallback is case-insensitive on
  // its own, so fold both sides when nocase is requested. This keeps case-only
  // path variants from slipping past permission rules.
  const nocase = options?.nocase === true;
  const v = nocase ? value.toLowerCase() : value;
  const p = nocase ? pattern.toLowerCase() : pattern;
  const m = getNative();
  if (m?.['nativeGlobMatchesAny'] != null) {
    try {
      return (m['nativeGlobMatchesAny'] as (globs: string[], path: string) => boolean)([p], v);
    } catch {
      // fall through
    }
  }
  return simpleGlobMatch(v, p);
}
