/**
 * Path-filter helpers — pure string predicates, no IO.
 *
 * `subtreeWatchFilter` builds an `ignored` predicate that confines a recursive
 * fs watch to the candidate subtrees under `root` plus their ancestor chain
 * (so candidates that do not exist yet are still detected once created). The
 * optional knobs prune paths BELOW a candidate only, mirroring a
 * recursion-gated scanner: `maxDepth` rejects anything deeper than that many
 * segments below the candidate, and an entry matching `skipEntry` (e.g. the
 * skill scanner's `node_modules` / dot-entry rule) stops further watching —
 * but the entry itself, and with `keepEntryFile` also its direct child file
 * of that name, stay watched, because a scanner still probes those without
 * recursing deeper. Everything below that point is what the consumer never
 * reads, and only that is pruned.
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
  return options.maxDepth !== undefined && segments.length > options.maxDepth;
}
