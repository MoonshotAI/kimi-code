import { basename, dirname, isAbsolute, join, normalize, relative } from 'pathe';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { findGitWorkTree, type GitWorkTree } from '#/app/git/workTree';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { WorktreeCheckout } from './worktree';

export function worktreesDirFor(homeDir: string, repoRoot: string): string {
  return join(homeDir, 'worktrees', encodeWorkDirKey(repoRoot));
}

// git stores realpaths (macOS /tmp is /private/tmp); a missing leaf resolves through its nearest existing parent.
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
  const workTree = await findGitWorkTree(fs, cwd);
  if (workTree === null) return undefined;
  const repoRoot = await mainCheckoutRoot(fs, workTree);
  if (repoRoot === undefined) return undefined;

  const checkoutRoot = await canonicalPath(fs, workTree.root);
  const relativePath = relative(checkoutRoot, await canonicalPath(fs, cwd));
  if (checkoutRoot === repoRoot) return { repoRoot, checkoutRoot, relativePath, kind: 'main' };
  const kimiDir = await canonicalPath(fs, worktreesDirFor(homeDir, repoRoot));
  const kind = dirname(checkoutRoot) === kimiDir ? 'managed' : 'linked';
  return { repoRoot, checkoutRoot, relativePath, kind };
}

async function mainCheckoutRoot(fs: IHostFileSystem, workTree: GitWorkTree): Promise<string | undefined> {
  if (workTree.controlDirPath === workTree.dotGitPath) return canonicalPath(fs, workTree.root);
  const commonDir = await canonicalPath(fs, await readCommonDir(fs, workTree.controlDirPath));
  if (basename(commonDir) !== '.git') return undefined;
  return dirname(commonDir);
}

async function readCommonDir(fs: IHostFileSystem, controlDir: string): Promise<string> {
  const pointer = await fs.readText(join(controlDir, 'commondir')).then(
    (text) => text.trim(),
    () => '',
  );
  if (pointer === '') return controlDir;
  return isAbsolute(pointer) ? pointer : join(controlDir, pointer);
}
