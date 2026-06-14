import type {
  ReviewArtifact,
  ReviewBaseRef,
  ReviewCommentSeverity,
  ReviewCommit,
  ReviewDiffStats,
  ReviewIntensity,
  ReviewResult,
  ReviewScopeSummary,
} from '@moonshot-ai/kimi-code-sdk';

export type ReviewScopeChoice = 'working_tree' | 'current_branch' | 'ahead_of_upstream' | 'single_commit';

export interface ReviewChoice {
  readonly value: string;
  readonly label: string;
  readonly labelAnimation?: 'wave';
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

export function reviewScopeChoices(summary: ReviewScopeSummary | undefined): readonly ReviewChoice[] {
  return [
    {
      value: 'working_tree',
      label: 'Working tree',
      description: summary === undefined
        ? 'Review uncommitted tracked and untracked changes.'
        : workingTreeDescription(summary),
    },
    {
      value: 'current_branch',
      label: 'Current branch',
      description: summary?.head === null || summary?.head === undefined
        ? 'Review the current HEAD against a selected branch, tag, or commit.'
        : `HEAD ${summary.head.shortSha} · ${summary.head.subject}. Choose a base branch, tag, or commit.`,
    },
    ...upstreamScopeChoice(summary),
    {
      value: 'single_commit',
      label: 'Single commit',
      description: 'Review only the changes introduced by one commit.',
    },
  ];
}

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
    label: 'Deep Review',
    labelAnimation: 'wave',
    description: 'Uses AgentSwarm for risky or large changes.',
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

const SEVERITY_ORDER: readonly ReviewCommentSeverity[] = ['critical', 'important', 'minor'];

interface CompactComment {
  readonly severity: ReviewCommentSeverity;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly rejected: boolean;
}

/** Compact transcript render for a freshly completed review. */
export function formatReviewCompactMarkdown(result: ReviewResult): string {
  return renderCompactReview({
    summary: result.summary,
    stats: result.stats,
    reviewId: result.reviewId,
    comments: result.comments.map((comment) => ({
      severity: comment.severity,
      path: comment.path,
      line: comment.line,
      title: comment.title,
      rejected: false,
    })),
  });
}

/** Compact transcript render from a persisted artifact (folds rejected state). */
export function formatReviewArtifactCompactMarkdown(artifact: ReviewArtifact): string {
  return renderCompactReview({
    summary: artifact.summary,
    stats: artifact.stats,
    reviewId: artifact.id,
    comments: artifact.comments.map((comment) => ({
      severity: comment.severity,
      path: comment.anchor.path,
      line: comment.anchor.line,
      title: comment.title,
      rejected: comment.state === 'dismissed',
    })),
  });
}

function renderCompactReview(input: {
  readonly summary: string;
  readonly stats: ReviewDiffStats;
  readonly reviewId: number | undefined;
  readonly comments: readonly CompactComment[];
}): string {
  const active = input.comments.filter((comment) => !comment.rejected);
  const rejected = input.comments.filter((comment) => comment.rejected);
  if (active.length === 0 && rejected.length === 0) return input.summary;

  const criticalCount = active.filter((comment) => comment.severity === 'critical').length;
  const countParts = [formatCount(active.length, 'finding')];
  if (criticalCount > 0) countParts.push(`${String(criticalCount)} critical`);
  if (rejected.length > 0) countParts.push(`${String(rejected.length)} rejected`);

  const lines = [`**Code review** · ${formatReviewStats(input.stats)} · ${countParts.join(' · ')}`, ''];
  for (const severity of SEVERITY_ORDER) {
    const group = active.filter((comment) => comment.severity === severity);
    if (group.length === 0) continue;
    lines.push(`**${severityLabel(severity)}**`);
    for (const comment of group) {
      lines.push(`- \`${comment.path}:${String(comment.line)}\` — ${comment.title}`);
    }
    lines.push('');
  }
  if (rejected.length > 0) {
    lines.push('**Rejected**');
    for (const comment of rejected) {
      lines.push(`- ~~\`${comment.path}:${String(comment.line)}\` — ${comment.title}~~`);
    }
    lines.push('');
  }
  if (input.reviewId !== undefined) {
    lines.push(`Browse or reject findings: \`/review read ${String(input.reviewId)}\``);
  }
  return lines.join('\n').trimEnd();
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

function upstreamScopeChoice(summary: ReviewScopeSummary | undefined): readonly ReviewChoice[] {
  const upstream = summary?.upstream;
  if (upstream === undefined || upstream === null || upstream.aheadCount === 0) return [];
  return [
    {
      value: 'ahead_of_upstream',
      label: 'Ahead of upstream',
      description: `${upstream.upstreamRef} · ${formatCount(upstream.aheadCount, 'commit')} ahead`,
    },
  ];
}

function workingTreeDescription(summary: ReviewScopeSummary): string {
  const { stagedCount, unstagedCount, untrackedCount, conflictedCount } = summary.workingTree;
  const parts = [
    `${String(stagedCount)} staged`,
    `${String(unstagedCount)} unstaged`,
    `${String(untrackedCount)} untracked`,
  ];
  if (conflictedCount > 0) parts.push(`${formatCount(conflictedCount, 'conflict')}`);
  if (stagedCount === 0 && unstagedCount === 0 && untrackedCount === 0 && conflictedCount === 0) {
    return 'No uncommitted changes detected.';
  }
  return parts.join(' · ');
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
