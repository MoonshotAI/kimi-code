/**
 * `_base/utils/paths` (cross-cutting) — pure path-filter predicates.
 *
 * Constrains filesystem watches to selected subtrees and scanner-visible
 * entries.
 */

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

export interface SubtreeWatchFilterOptions {
  readonly maxDepth?: number;
  readonly skipEntry?: (entryName: string) => boolean;
  readonly keepEntryFile?: string;
}

export function subtreeWatchFilter(
  root: string,
  candidates: readonly string[],
  options?: SubtreeWatchFilterOptions,
): (path: string) => boolean {
  const normRoot = normalizeSlashes(root);
  const normCandidates = candidates.map(normalizeSlashes);
  return (p: string): boolean => {
    const norm = normalizeSlashes(p);
    if (norm === normRoot) return false;
    for (const candidate of normCandidates) {
      if (norm === candidate) return false;
      if (norm.startsWith(`${candidate}/`)) {
        return isPrunedBelowCandidate(norm.slice(candidate.length + 1), options);
      }
      if (candidate.startsWith(`${norm}/`)) return false;
    }
    return true;
  };
}

function isPrunedBelowCandidate(
  rel: string,
  options: SubtreeWatchFilterOptions | undefined,
): boolean {
  if (options === undefined) return false;
  const segments = rel.split('/');
  if (options.maxDepth !== undefined && segments.length > options.maxDepth) return true;
  if (options.skipEntry !== undefined) {
    const excludedAt = segments.findIndex(options.skipEntry);
    if (excludedAt !== -1) {
      if (segments.length <= excludedAt + 1) return false;
      return !(
        options.keepEntryFile !== undefined &&
        segments.length === excludedAt + 2 &&
        segments.at(-1) === options.keepEntryFile
      );
    }
  }
  return false;
}
