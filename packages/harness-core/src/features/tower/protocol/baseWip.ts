import { join } from 'pathe';

import type { OsFsPort } from '#/features/os/host/index';

import type { Git } from './git';
import { TOWER_ROOT } from './paths';

export interface BaseDirtyEntry {
  readonly path: string;
  readonly unmerged: boolean;
}

const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const ADD_PATHS_CHUNK = 100;

export async function listBaseDirtyEntries(
  git: Git,
  cwd: string,
): Promise<readonly BaseDirtyEntry[]> {
  const out = await git.runGit(cwd, [
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--untracked-files=normal',
  ]);
  const entries: BaseDirtyEntry[] = [];
  for (const record of out.split('\0')) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const raw = record.slice(3).replace(/\/+$/, '');
    if (raw.length === 0 || raw.split('/').includes(TOWER_ROOT)) continue;
    entries.push({ path: raw, unmerged: UNMERGED_CODES.has(code) });
  }
  return entries;
}

export async function snapshotBaseWip(
  git: Git,
  fs: OsFsPort,
  cwd: string,
  base: string,
  paths: readonly string[],
  message: string,
): Promise<string | null> {
  if (paths.length === 0) return null;
  const topLevel = await git.runGit(cwd, ['rev-parse', '--show-toplevel']);
  const baseTip = await git.runGit(topLevel, ['rev-parse', base]);
  const indexPath = join(topLevel, TOWER_ROOT, `wip-index-${crypto.randomUUID()}`);
  const env = {
    GIT_INDEX_FILE: indexPath,
    GIT_LITERAL_PATHSPECS: '1',
  };
  try {
    await git.runGit(topLevel, ['read-tree', baseTip], { env });
    for (let i = 0; i < paths.length; i += ADD_PATHS_CHUNK) {
      await git.runGit(topLevel, ['add', '-A', '--', ...paths.slice(i, i + ADD_PATHS_CHUNK)], {
        env,
      });
    }
    const tree = await git.runGit(topLevel, ['write-tree'], { env });
    const baseTree = await git.runGit(topLevel, ['rev-parse', `${baseTip}^{tree}`]);
    if (tree === baseTree) return null;
    return await git.runGit(topLevel, ['commit-tree', tree, '-p', baseTip, '-m', message], {
      env,
    });
  } finally {
    await fs.remove(indexPath).catch(() => {});
  }
}
