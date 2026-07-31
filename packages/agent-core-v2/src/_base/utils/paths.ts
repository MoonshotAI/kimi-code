/**
 * Path-filter helpers — pure string predicates, no IO.
 */

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * A chokidar `ignored` predicate that prunes a recursive watch on `root`
 * down to the given candidate subtrees (files or directories beneath it).
 * The root itself, every ancestor of a candidate (so traversal can reach
 * it), and every path inside a candidate pass the filter; everything else
 * is ignored, so large sibling trees (dependency folders, VCS metadata)
 * are never walked. This is the reliable way to watch candidates that may
 * not exist yet: watching a missing path directly silently never fires
 * when its parent directory is missing too.
 */
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
