import { isAbsolute, join, parse } from 'pathe';

import picomatch from 'picomatch';

import { canonicalizePath, type PathClass } from '../policies/path-access';

export interface PermissionPathMatchOptions {
  readonly cwd?: string;
  readonly pathClass?: PathClass;
  readonly homeDir?: string;
  readonly caseInsensitivePaths?: boolean;
}

interface PathMatchSemantics {
  readonly pathClass: PathClass;
}

/**
 * Match ordinary string fields, like command text or search patterns.
 * `*` and `**` work as wildcards, but the value is not treated as a file path.
 */
export function globMatch(value: string, pattern: string, options?: { nocase?: boolean }): boolean {
  if (picomatch.isMatch(value, pattern, options)) return true;

  const normalizedValue = stripLeadingDotSlash(value);
  const normalizedPattern = stripLeadingDotSlash(pattern);
  if (normalizedValue === value && normalizedPattern === pattern) return false;
  return picomatch.isMatch(normalizedValue, normalizedPattern, options);
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * Match file path fields, like Read/Write/Edit `path`.
 * Also compares normalized forms, so `./a`, `dir/../a`, and Windows
 * separator or case variants can match the same rule.
 */
export function pathGlobMatch(
  value: string,
  pattern: string,
  pathOptions?: PermissionPathMatchOptions,
): boolean {
  const semantics = pathMatchSemantics(value, pattern, pathOptions);
  const nocase = pathOptions?.caseInsensitivePaths ?? true;

  if (globMatch(value, pattern, { nocase })) return true;

  for (const valueVariant of pathVariants(value, semantics, pathOptions)) {
    for (const patternVariant of pathVariants(pattern, semantics, pathOptions)) {
      if (globMatch(valueVariant, patternVariant, { nocase })) return true;
    }
  }
  return false;
}

/**
 * Build equivalent spellings for one path string before glob matching:
 * the original text, a leading `./` or `.\` form without that prefix,
 * the canonical absolute path when possible, and slash-form Windows paths.
 *
 * Example: with cwd `/repo`, `./src/../secret.txt` adds both
 * `src/../secret.txt` and `/repo/secret.txt`. On Windows,
 * `C:\repo\secret.txt` also adds `C:/repo/secret.txt`.
 */
function pathVariants(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string[] {
  const variants = new Set<string>();
  addPathVariant(variants, value, semantics.pathClass);
  addPathVariant(variants, stripLeadingDotPath(value, semantics.pathClass), semantics.pathClass);

  const canonical = canonicalizePathPattern(value, semantics, pathOptions);
  if (canonical !== undefined) addPathVariant(variants, canonical, semantics.pathClass);
  return Array.from(variants);
}

function canonicalizePathPattern(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string | undefined {
  const expanded = expandUserPath(value, semantics.pathClass, pathOptions?.homeDir);
  const cwd = pathOptions?.cwd ?? defaultCwdForPath(expanded);
  if (cwd === undefined) return undefined;
  try {
    return canonicalizePath(expanded, cwd, semantics.pathClass);
  } catch {
    return undefined;
  }
}

function expandUserPath(
  value: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): string {
  if (homeDir === undefined) return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || (pathClass === 'win32' && value.startsWith('~\\'))) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

function defaultCwdForPath(value: string): string | undefined {
  if (!isAbsolute(value)) return undefined;
  return parse(value).root;
}

function pathMatchSemantics(
  value: string,
  pattern: string,
  pathOptions: PermissionPathMatchOptions | undefined,
): PathMatchSemantics {
  // Production callers pass the active Kaos path class. The fallback keeps
  // the pure matcher useful for tests and direct helper calls.
  const pathClass =
    pathOptions?.pathClass ??
    ([value, pattern].some((candidate) => {
      return (
        /^[A-Za-z]:(?:[\\/]|$)/.test(candidate) ||
        candidate.startsWith('\\\\') ||
        candidate.includes('\\')
      );
    })
      ? 'win32'
      : 'posix');
  return { pathClass };
}

function addPathVariant(variants: Set<string>, value: string, pathClass: PathClass): void {
  variants.add(value);
  // Picomatch treats backslashes as escape syntax in some cases; add a
  // slash-separated Win32 variant so nocase and globs behave predictably.
  if (pathClass === 'win32') variants.add(value.replaceAll('\\', '/'));
}

function stripLeadingDotPath(value: string, pathClass: PathClass): string {
  if (value.startsWith('./')) return value.slice(2);
  if (pathClass === 'win32' && value.startsWith('.\\')) return value.slice(2);
  return value;
}
