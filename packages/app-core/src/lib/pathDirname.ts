// packages/app-core/src/lib/pathDirname.ts

/**
 * The directory portion of a file path, on EITHER separator ('/' or '\' — a
 * Windows path arrives with backslashes and must still yield its base dir).
 * '' for a bare-name path; the ROOT itself is kept for a root-level absolute
 * file ('/README.md' → '/', 'C:\README.md' → 'C:'), because an empty base
 * would resolve the file's relative links against the wrong scope.
 *
 * A POSIX basename can legally contain '\', but a path whose only separator-
 * like char is a backslash near the end is vanishingly rare next to EVERY
 * Windows path (accepted trade-off).
 */
export function pathDirname(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSlash < 0) return '';
  if (lastSlash === 0) return path[0]!; // the POSIX root itself
  return path.slice(0, lastSlash);
}
