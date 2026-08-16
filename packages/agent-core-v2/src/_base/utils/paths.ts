/**
 * `_base/utils/paths` (cross-cutting) — pure path predicates and directory
 * walks.
 *
 * Constrains filesystem watches to selected subtrees and scanner-visible
 * entries, and walks host directory chains with platform-native path
 * semantics so drive-letter / UNC roots keep their host form.
 */

import nodePath from 'node:path';

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

export interface UpwardRootPathApi {
  resolve(dir: string): string;
  dirname(dir: string): string;
  join(...segments: string[]): string;
}

export async function findUpwardRoot(
  workDir: string,
  markerName: string,
  hasMarker: (markerPath: string) => Promise<boolean>,
  pathApi: UpwardRootPathApi = nodePath,
): Promise<string> {
  const start = pathApi.resolve(workDir);
  let current = start;
  while (true) {
    if (await hasMarker(pathApi.join(current, markerName))) return normalizeSlashes(current);
    const parent = pathApi.dirname(current);
    if (parent === current) return normalizeSlashes(start);
    current = parent;
  }
}

export interface SubtreeWatchFilterOptions {
  readonly maxDepth?: number;
  readonly skipEntry?: (entryName: string) => boolean;
  readonly keepEntryFile?: string;
  readonly scannedDirectories?: readonly string[];
}

export function subtreeWatchFilter(
  root: string,
  candidates: readonly string[],
  options?: SubtreeWatchFilterOptions,
): (path: string) => boolean {
  const normRoot = normalizeSlashes(root);
  const normCandidates = candidates.map(normalizeSlashes);
  const normScannedDirectories =
    options?.scannedDirectories === undefined
      ? undefined
      : new Set([...normCandidates, ...options.scannedDirectories.map(normalizeSlashes)]);
  return (p: string): boolean => {
    const norm = normalizeSlashes(p);
    if (norm === normRoot) return false;
    for (const candidate of normCandidates) {
      if (norm === candidate) return false;
      if (norm.startsWith(`${candidate}/`)) {
        return isPrunedBelowCandidate(
          norm,
          norm.slice(candidate.length + 1),
          options,
          normScannedDirectories,
        );
      }
      if (candidate.startsWith(`${norm}/`)) return false;
    }
    return true;
  };
}

function isPrunedBelowCandidate(
  normPath: string,
  rel: string,
  options: SubtreeWatchFilterOptions | undefined,
  scannedDirectories: ReadonlySet<string> | undefined,
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
  if (scannedDirectories !== undefined) {
    return !isScannerVisiblePath(normPath, scannedDirectories, options.keepEntryFile);
  }
  return false;
}

function isScannerVisiblePath(
  normPath: string,
  scannedDirectories: ReadonlySet<string>,
  keepEntryFile: string | undefined,
): boolean {
  if (scannedDirectories.has(normPath)) return true;
  const separatorAt = normPath.lastIndexOf('/');
  if (separatorAt === -1) return false;
  const parent = normPath.slice(0, separatorAt);
  if (scannedDirectories.has(parent)) return true;
  if (
    keepEntryFile === undefined ||
    normPath.slice(separatorAt + 1) !== keepEntryFile
  ) {
    return false;
  }
  const parentSeparatorAt = parent.lastIndexOf('/');
  if (parentSeparatorAt === -1) return false;
  return scannedDirectories.has(parent.slice(0, parentSeparatorAt));
}
