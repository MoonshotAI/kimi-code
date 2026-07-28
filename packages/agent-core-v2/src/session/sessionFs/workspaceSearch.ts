/**
 * `sessionFs` domain (L2) — reusable workspace filename search helper.
 *
 * Searches a concrete workspace root through the app-level `os` filesystem
 * primitive and returns the session filesystem search wire shape. Used by the
 * Session-scoped filesystem service and by server workspace routes that need
 * the same filename-search behavior before a Session scope exists.
 */

import { join } from 'node:path';

import ignore, { type Ignore } from 'ignore';

import type { IHostFileSystem, HostDirEntry } from '#/os/interface/hostFileSystem';

import type { FsSearchHit, FsSearchRequest, FsSearchResponse } from './fs';
import { computeFuzzyScore, computeMatchPositions, matchesAnyGlob } from './fsSearch';

const SEARCH_HARD_CAP = 500;
const WALK_MAX_DEPTH = 64;

export async function searchWorkspaceFiles(
  hostFs: IHostFileSystem,
  root: string,
  req: FsSearchRequest,
  options: { readonly gitignoreCache?: Map<string, Ignore> } = {},
): Promise<FsSearchResponse> {
  const matcher = req.follow_gitignore
    ? await workspaceMatcher(hostFs, root, options.gitignoreCache)
    : undefined;
  const candidates: FsSearchHit[] = [];
  const queryLower = req.query.toLowerCase();

  await walkWorkspaceFiles(hostFs, root, '', matcher, async (relPath, name, kind) => {
    const score = computeFuzzyScore(name, queryLower);
    if (score <= 0) return;
    if (req.include_globs && !matchesAnyGlob(relPath, req.include_globs)) {
      return;
    }
    if (req.exclude_globs && matchesAnyGlob(relPath, req.exclude_globs)) {
      return;
    }
    candidates.push({
      path: relPath,
      name,
      kind,
      score,
      match_positions: computeMatchPositions(relPath, queryLower),
    });
  });

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const effectiveCap = Math.min(req.limit, SEARCH_HARD_CAP);
  const truncated = candidates.length > effectiveCap;
  return { items: candidates.slice(0, effectiveCap), truncated };
}

async function walkWorkspaceFiles(
  hostFs: IHostFileSystem,
  root: string,
  rootRel: string,
  matcher: Ignore | undefined,
  visit: (
    relPath: string,
    name: string,
    kind: 'file' | 'directory' | 'symlink',
  ) => Promise<void>,
  depth = 0,
): Promise<void> {
  if (depth > WALK_MAX_DEPTH) return;
  let entries: readonly HostDirEntry[];
  try {
    entries = await hostFs.readdir(absOf(root, rootRel));
  } catch {
    return;
  }
  for (const entry of entries) {
    const { name } = entry;
    if (name === '.git') continue;
    const childRel = rootRel === '' ? name : `${rootRel}/${name}`;
    const isDir = entry.isDirectory && entry.isSymbolicLink !== true;
    if (matcher) {
      const probe = isDir ? `${childRel}/` : childRel;
      if (matcher.ignores(probe)) continue;
    }
    const kind: 'file' | 'directory' | 'symlink' = entry.isSymbolicLink
      ? 'symlink'
      : isDir
        ? 'directory'
        : 'file';
    await visit(childRel, name, kind);
    if (isDir) {
      await walkWorkspaceFiles(hostFs, root, childRel, matcher, visit, depth + 1);
    }
  }
}

async function workspaceMatcher(
  hostFs: IHostFileSystem,
  root: string,
  cache: Map<string, Ignore> | undefined,
): Promise<Ignore> {
  const cached = cache?.get(root);
  if (cached !== undefined) return cached;
  const ig = ignore();
  ig.add('.git/');
  try {
    const contents = await hostFs.readText(join(root, '.gitignore'));
    ig.add(contents);
  } catch {
  }
  cache?.set(root, ig);
  return ig;
}

function absOf(root: string, rel: string): string {
  return rel === '' || rel === '.' ? root : join(root, rel);
}
