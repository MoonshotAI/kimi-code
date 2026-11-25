import { basename, dirname, join, normalize, relative } from 'pathe';

import { encodeWorkDirKey, sameDir, toAbsoluteDir } from '#/_base/utils/workdir-slug';
import { locateCheckout } from '#/app/git/workTree';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { WorktreeCheckout } from './worktree';

export function worktreesDirFor(homeDir: string, repoRoot: string): string {
  return join(homeDir, 'worktrees', encodeWorkDirKey(repoRoot));
}

export async function canonicalPath(fs: IHostFileSystem, path: string): Promise<string> {
  const normalized = normalize(path);
  try {
    return normalize(await fs.realpath(normalized));
  } catch {
    const parent = dirname(normalized);
    if (parent === normalized) return normalized;
    return join(await canonicalPath(fs, parent), basename(normalized));
  }
}

export async function resolveWorktreeCheckout(
  fs: IHostFileSystem,
  homeDir: string,
  cwd: string,
): Promise<WorktreeCheckout | undefined> {
  const absolute = toAbsoluteDir(cwd);
  if (absolute === undefined) return undefined;
  const located = await locateCheckout(fs, absolute);
  if (located.kind !== 'grouped') return undefined;

  const repoRoot = located.canonicalMainDir;
  const checkoutRoot = await canonicalPath(fs, located.checkoutRoot);
  const relativePath = relative(checkoutRoot, await canonicalPath(fs, absolute));
  if (sameDir(checkoutRoot, repoRoot)) {
    return { repoRoot, checkoutRoot, relativePath, kind: 'main', bare: false };
  }
  const bare = await fs.lstat(join(repoRoot, '.git')).then(
    () => false,
    () => true,
  );
  const kimiDir = await canonicalPath(fs, worktreesDirFor(homeDir, repoRoot));
  const kind = sameDir(dirname(checkoutRoot), kimiDir) ? 'managed' : 'linked';
  return { repoRoot, checkoutRoot, relativePath, kind, bare };
}
