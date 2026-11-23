import type { KimiHarness, KimiWorktree } from '@moonshot-ai/kimi-code-sdk';

import {
  removalLosses,
  type WorktreeDeleteChoice,
  type WorktreeRemoval,
} from '#/tui/components/dialogs/worktree-choices';

type RemovalHarness = Pick<KimiHarness, 'inspectWorktreeRemoval' | 'removeWorktree'>;

export async function inspectWorktreeRemoval(
  harness: RemovalHarness,
  input: { readonly repoRoot: string; readonly worktree: Pick<KimiWorktree, 'path' | 'name'>; readonly excludeSessionId?: string },
): Promise<WorktreeRemoval> {
  const { repoRoot, worktree, excludeSessionId } = input;
  const check = await harness.inspectWorktreeRemoval({ repoRoot, path: worktree.path, deleteBranch: false, excludeSessionId });
  const branchCheck =
    check.branch === undefined
      ? undefined
      : await harness.inspectWorktreeRemoval({ repoRoot, path: worktree.path, deleteBranch: true, excludeSessionId });
  return {
    repoRoot,
    path: check.path,
    name: worktree.name,
    branch: check.branch,
    uncommittedFiles: check.uncommittedFiles,
    commitsLostWithWorktree: check.uniqueCommits,
    commitsLostWithBranch: branchCheck?.uniqueCommits ?? 0,
    openSessionIds: check.openSessionIds,
    closedSessionCount: check.closedSessionCount,
  };
}

export async function removeWorktree(
  harness: RemovalHarness,
  removal: WorktreeRemoval,
  choice: WorktreeDeleteChoice,
  excludeSessionId?: string,
): Promise<void> {
  const losses = removalLosses(removal, choice);
  await harness.removeWorktree({
    repoRoot: removal.repoRoot,
    path: removal.path,
    deleteBranch: choice === 'delete-branch',
    discard: { uncommittedFiles: losses.files, uniqueCommits: losses.commits },
    excludeSessionId,
  });
}
