import { WORKTREES_DIR } from './paths';

export function resolveTowerRepoRoot(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/');
  const marker = `/${WORKTREES_DIR}/`;
  const index = normalized.indexOf(marker);
  if (index === -1) return cwd;
  return cwd.slice(0, index);
}
