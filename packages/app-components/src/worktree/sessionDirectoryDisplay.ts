import type { AppSession, AppWorktreeBase } from '@moonshot-ai/app-core/api';

export interface SessionWorktreeDisplay {
  path: string;
  branch: string | null;
  base: AppWorktreeBase | null;
  missing: boolean;
}

export function sessionWorktreeDisplay(
  session: Pick<AppSession, 'worktree'> | null | undefined,
): SessionWorktreeDisplay | null {
  const worktree = session?.worktree;
  if (worktree === undefined || worktree.path === undefined || worktree.setup.status === 'local') return null;
  return {
    path: worktree.path,
    branch: worktree.branch ?? null,
    base: worktree.base ?? null,
    missing: worktree.missing === true,
  };
}

export function shortenHomePath(path: string, home: string | null | undefined): string {
  const base = home?.replace(/[\\/]+$/, '') ?? '';
  if (base.length > 0 && (path === base || path.startsWith(`${base}/`))) return `~${path.slice(base.length)}`;
  const match = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (match) return `~${match[1] ?? ''}`;
  return path;
}

export type PullRequestStateKey = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';

const PR_STATE_LABELS: Record<PullRequestStateKey, string> = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
  draft: 'Draft',
  unknown: 'Unknown',
};

export function pullRequestStateKey(state: string): PullRequestStateKey {
  const normalized = state.trim().toLowerCase().replaceAll('_', '-');
  return normalized === 'open' || normalized === 'closed' || normalized === 'merged' || normalized === 'draft'
    ? normalized
    : 'unknown';
}

export function pullRequestStateLabel(state: string): string {
  return PR_STATE_LABELS[pullRequestStateKey(state)];
}

export function pullRequestIcon(state: string): string {
  return pullRequestStateKey(state) === 'merged' ? 'git-merge' : 'git-pull-request';
}
