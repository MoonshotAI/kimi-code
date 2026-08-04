/**
 * Path-filter helpers — pure string predicates, no IO.
 *
 * `subtreeWatchFilter` builds an `ignored` predicate that confines a recursive
 * fs watch to the candidate subtrees under `root` plus their ancestor chain
 * (so candidates that do not exist yet are still detected once created). The
 * optional knobs prune paths BELOW a candidate only: `skipEntry` rejects
 * entries by basename (e.g. a scanner's `node_modules` / dot-entry rule) and
 * `maxDepth` rejects anything deeper than that many segments below the
 * candidate — letting a watch mirror a scanner's own pruning instead of
 * watching subtrees the consumer would never read.
 */

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

export interface SubtreeWatchFilterOptions {
  readonly maxDepth?: number;
  readonly skipEntry?: (entryName: string) => boolean;
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
  if (options.skipEntry !== undefined && segments.some(options.skipEntry)) return true;
  return options.maxDepth !== undefined && segments.length > options.maxDepth;
}
