import type {
  ReviewBaseRef,
  ReviewCommit,
  ReviewDiffStats,
  ReviewIntensity,
  ReviewResult,
} from '@moonshot-ai/kimi-code-sdk';

export type ReviewScopeChoice = 'working_tree' | 'current_branch' | 'ahead_of_upstream' | 'single_commit';

export interface ReviewChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export const REVIEW_SCOPE_CHOICES: readonly ReviewChoice[] = [
  {
    value: 'working_tree',
    label: 'Working tree',
    description: 'Review uncommitted tracked and untracked changes.',
  },
  {
    value: 'current_branch',
    label: 'Current branch',
    description: 'Review the current HEAD against a selected branch, tag, or commit.',
  },
  {
    value: 'ahead_of_upstream',
    label: 'Ahead of upstream',
    description: 'Review all commits on this branch that are ahead of its upstream branch.',
  },
  {
    value: 'single_commit',
    label: 'Single commit',
    description: 'Review only the changes introduced by one commit.',
  },
];

export const REVIEW_INTENSITY_CHOICES: readonly ReviewChoice[] = [
  {
    value: 'standard',
    label: 'Standard',
    description: 'Single reviewer for everyday changes.',
  },
  {
    value: 'thorough',
    label: 'Thorough',
    description: 'Multiple focused reviewers before opening a PR.',
  },
  {
    value: 'deep',
    label: 'Deep',
    description: 'Swarm-backed review for risky or large changes.',
  },
];

export const THOROUGH_REVIEW_PERSPECTIVE_LABELS: readonly string[] = [
  'Correctness and regressions',
  'Security and data safety',
  'Maintainability and tests',
];

export function formatReviewStats(stats: ReviewDiffStats): string {
  return `${formatCount(stats.fileCount, 'file')}: +${String(stats.additions)} -${String(stats.deletions)}`;
}

export function reviewBaseRefChoice(ref: ReviewBaseRef): ReviewChoice {
  return {
    value: ref.name,
    label: `${ref.name}  ${ref.kind}`,
    description: ref.description,
  };
}

export function reviewCommitChoice(commit: ReviewCommit): ReviewChoice {
  return {
    value: commit.sha,
    label: `${commit.sha.slice(0, 12)}  ${commit.title}`,
    description: [commit.author, commit.date].filter(Boolean).join(' · ') || undefined,
  };
}

export function formatReviewResultMarkdown(result: ReviewResult): string {
  if (result.comments.length === 0) return result.summary;

  const lines = [result.summary, ''];
  for (const comment of result.comments) {
    lines.push(
      `- **${severityLabel(comment.severity)}** ${comment.path}:${String(comment.line)} - ${comment.title}`,
    );
    lines.push(`  ${comment.body}`);
    if (comment.suggestedFix !== undefined) {
      lines.push(`  Suggested fix: ${comment.suggestedFix}`);
    }
  }
  return lines.join('\n');
}

export function isReviewIntensity(value: string): value is ReviewIntensity {
  return value === 'standard' || value === 'thorough' || value === 'deep';
}

export function isReviewScopeChoice(value: string): value is ReviewScopeChoice {
  return value === 'working_tree'
    || value === 'current_branch'
    || value === 'ahead_of_upstream'
    || value === 'single_commit';
}

function formatCount(count: number, singular: string): string {
  return `${String(count)} ${count === 1 ? singular : `${singular}s`}`;
}

function severityLabel(severity: ReviewResult['comments'][number]['severity']): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'important':
      return 'Important';
    case 'minor':
      return 'Minor';
  }
}
