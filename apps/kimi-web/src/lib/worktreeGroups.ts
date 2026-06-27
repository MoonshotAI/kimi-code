// apps/kimi-web/src/lib/worktreeGroups.ts
// Pure helpers for the worktree-centric sidebar groups.

import type { AppWorktree } from '../api/types';
import type { WorktreeGroup, WorkspaceView } from '../types';

/**
 * Merge known git worktrees into the session-derived sidebar groups so a
 * worktree checkout appears in the worktree-centric sidebar even before it has
 * any sessions — otherwise a freshly-created (or long-idle) worktree is only
 * visible on the board and can't be opened from the sidebar. Existing session
 * groups pick up authoritative worktree metadata (path, isMain, dirty, PR).
 * Non-git workspaces, and workspaces whose worktrees haven't loaded yet, are
 * left untouched. Pure: the input array and its group objects are not mutated.
 */
export function mergeWorktreeGroups(
  groups: WorktreeGroup[],
  workspaces: WorkspaceView[],
  worktreesByWorkspace: Record<string, AppWorktree[]>,
): WorktreeGroup[] {
  const result = new Map<string, WorktreeGroup>(groups.map((g) => [g.key, g]));
  for (const ws of workspaces) {
    if (ws.isGitRepo !== true) continue;
    const worktrees = worktreesByWorkspace[ws.id];
    if (worktrees === undefined) continue;
    for (const wt of worktrees) {
      const key = `${ws.id}:${wt.branch}`;
      const existing = result.get(key);
      if (existing !== undefined) {
        result.set(key, {
          ...existing,
          path: wt.path,
          isMain: wt.isMain,
          dirty: existing.dirty || wt.dirty,
          pullRequest: existing.pullRequest ?? wt.pullRequest,
        });
        continue;
      }
      result.set(key, {
        key,
        workspaceId: ws.id,
        workspaceName: ws.name,
        branch: wt.branch,
        isMain: wt.isMain,
        path: wt.path,
        dirty: wt.dirty,
        pullRequest: wt.pullRequest,
        sessions: [],
        hasRunning: false,
        hasPending: false,
        latestAt: 0,
      });
    }
  }
  return [...result.values()];
}
