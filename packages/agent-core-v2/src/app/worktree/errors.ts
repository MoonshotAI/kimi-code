import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorktreeErrors = {
  codes: {
    WORKTREE_NOT_GIT_REPO: 'worktree.not_git_repo',
    WORKTREE_NO_COMMITS: 'worktree.no_commits',
    WORKTREE_BASE_NOT_FOUND: 'worktree.base_not_found',
    WORKTREE_INVALID_NAME: 'worktree.invalid_name',
    WORKTREE_ALREADY_EXISTS: 'worktree.already_exists',
    WORKTREE_GIT_FAILED: 'worktree.git_failed',
    WORKTREE_INCLUDE_FAILED: 'worktree.include_failed',
    WORKTREE_CANCELLED: 'worktree.cancelled',
    WORKTREE_NOT_FOUND: 'worktree.not_found',
    WORKTREE_HAS_UNCOMMITTED: 'worktree.has_uncommitted',
    WORKTREE_HAS_UNIQUE_COMMITS: 'worktree.has_unique_commits',
    WORKTREE_IN_USE: 'worktree.in_use',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorktreeErrors);
