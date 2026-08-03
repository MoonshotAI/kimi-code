import { normalize } from 'pathe';

export type PathClass = 'posix' | 'win32';

/** POSIX file type mask (`st_mode & S_IFMT`). */
export const S_IFMT = 0o170000;
/** POSIX regular file mode. */
export const S_IFREG = 0o100000;
/** POSIX directory mode. */
export const S_IFDIR = 0o040000;

/**
 * If `candidate` is a descendant of `base`, return the relative path.
 * Otherwise return the normalized candidate unchanged.
 *
 * On Windows, path comparison is case-insensitive.
 */
export function relativizeIfUnder(candidate: string, base: string, pathClass: PathClass): string {
  const normCandidate = normalize(candidate);
  const normBase = normalize(base);
  const comparableCandidate = pathClass === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const comparableBase = pathClass === 'win32' ? normBase.toLowerCase() : normBase;
  if (comparableCandidate === comparableBase) return '.';
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  if (comparableCandidate.startsWith(prefix)) {
    return normCandidate.slice(prefix.length);
  }
  return normCandidate;
}
