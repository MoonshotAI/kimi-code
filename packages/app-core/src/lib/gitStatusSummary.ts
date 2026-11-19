import type { GitStatusEntry } from '../api/types';

export type PullRequestDisplay = 'shown' | 'hidden' | 'failed';

export interface GitStatusSummary {
  branch: string;
  detached: boolean;
  shortHead: string | null;
  upstream: string | null;
  notPushed: boolean;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  hasChanges: boolean;
  statsError: string | null;
  pullRequest: GitStatusEntry['pullRequest'];
  pullRequestDisplay: PullRequestDisplay;
  pullRequestError: string | null;
}

export function pullRequestDisplay(entry: Pick<GitStatusEntry, 'pullRequest' | 'pullRequestStatus'>): PullRequestDisplay {
  if (entry.pullRequestStatus === 'failed') return 'failed';
  if (entry.pullRequestStatus === 'none' || entry.pullRequestStatus === 'unavailable') return 'hidden';
  return entry.pullRequest === null ? 'hidden' : 'shown';
}

export function summarizeGitStatus(entry: GitStatusEntry): GitStatusSummary {
  const detached = entry.detached === true;
  const display = pullRequestDisplay(entry);
  return {
    branch: entry.branch,
    detached,
    shortHead: entry.head === undefined || entry.head.length === 0 ? null : entry.head,
    upstream: entry.upstream ?? null,
    notPushed: !detached && entry.upstream === undefined,
    ahead: entry.ahead,
    behind: entry.behind,
    additions: entry.additions,
    deletions: entry.deletions,
    hasChanges: entry.additions > 0 || entry.deletions > 0 || Object.keys(entry.entries).length > 0,
    statsError: entry.statsError ?? null,
    pullRequest: display === 'shown' ? entry.pullRequest : null,
    pullRequestDisplay: display,
    pullRequestError: display === 'failed' ? (entry.pullRequestError ?? '') : null,
  };
}
