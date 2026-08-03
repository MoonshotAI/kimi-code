/**
 * Path-filter helpers — pure string predicates, no IO.
 */

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

export function subtreeWatchFilter(
  root: string,
  candidates: readonly string[],
): (path: string) => boolean {
  const normRoot = normalizeSlashes(root);
  const normCandidates = candidates.map(normalizeSlashes);
  return (p: string): boolean => {
    const norm = normalizeSlashes(p);
    if (norm === normRoot) return false;
    for (const candidate of normCandidates) {
      if (norm === candidate || norm.startsWith(`${candidate}/`)) return false;
      if (candidate.startsWith(`${norm}/`)) return false;
    }
    return true;
  };
}
