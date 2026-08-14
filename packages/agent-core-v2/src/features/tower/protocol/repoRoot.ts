/**
 * `tower` domain (protocol) — maps a caller's working directory back to the
 * main checkout that holds `.tower/`.
 *
 * Tower worktrees always live at `<repoRoot>/.tower/worktrees/<slot>`, so a
 * caller anchored inside one maps back to the main checkout by convention —
 * no state lookup needed (which would be circular: reading state requires the
 * store root).
 */

import { WORKTREES_DIR } from './paths';

export function resolveTowerRepoRoot(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/');
  const marker = `/${WORKTREES_DIR}/`;
  const index = normalized.indexOf(marker);
  if (index === -1) return cwd;
  return cwd.slice(0, index);
}
