import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
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

import { currentTheme } from '#/tui/theme';
import type { ReviewSummaryTranscriptData } from '#/tui/types';

export type ReviewScopeChoice = 'working_tree' | 'current_branch' | 'ahead_of_upstream' | 'single_commit';

export interface ReviewChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** Custom row renderer (content lines); the picker adds the pointer. */
  readonly render?: (selected: boolean, width: number) => readonly string[];
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
  const shortSha = commit.sha.slice(0, 8);
  return {
    value: commit.sha,
    // Plain text used for search; the visible row is drawn by `render`.
    label: `${shortSha} ${commit.title}`,
    render: (selected, width) => renderCommitRow(commit, selected, width),
  };
}

/** Two-line commit row: orange hash + bold one-line title, then stats + relative time. */
function renderCommitRow(commit: ReviewCommit, selected: boolean, width: number): readonly string[] {
  const shortSha = commit.sha.slice(0, 8);
  const hash = currentTheme.fg('warning', shortSha);
  // A `↵` marks a commit message with a body; `…` (from truncateToWidth) marks
  // a subject that did not fit on the line.
  const bodyMark = commit.hasBody === true ? ' ↵' : '';
  const titleBudget = Math.max(1, width - visibleWidth(shortSha) - 1 - visibleWidth(bodyMark));
  const title = currentTheme.boldFg(selected ? 'primary' : 'text', truncateToWidth(commit.title, titleBudget, '…'));
  const head = `${hash} ${title}${currentTheme.fg('textDim', bodyMark)}`;

  const meta: string[] = [];
  if (commit.filesChanged !== undefined) {
    meta.push(
      currentTheme.fg('textDim', formatCount(commit.filesChanged, 'file')) +
        ' ' + currentTheme.fg('diffAdded', `+${String(commit.additions ?? 0)}`) +
        ' ' + currentTheme.fg('diffRemoved', `-${String(commit.deletions ?? 0)}`),
    );
  }
  if (commit.date !== undefined) {
    const relative = formatRelativeTime(commit.date, Date.now());
    if (relative.length > 0) meta.push(currentTheme.fg('textDim', relative));
  }
  return meta.length > 0 ? [head, meta.join(currentTheme.fg('textDim', '  ·  '))] : [head];
}

/** Format an ISO timestamp as relative time (e.g. "2 hours ago") via Intl. */
export function formatRelativeTime(iso: string, nowMs: number, locale: string = resolveTtyLocale()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const diffSeconds = Math.round((time - nowMs) / 1000);
  const formatter = relativeTimeFormatter(locale);
  const units: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds || unit === 'second') {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return formatter.format(0, 'second');
}

/** Build a relative-time formatter for `locale`, silently falling back to `en`. */
function relativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  try {
    if (locale !== 'en' && Intl.RelativeTimeFormat.supportedLocalesOf(locale).length > 0) {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    }
  } catch {
    // Malformed locale tag — fall through to the default below.
  }
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
}

/**
 * Resolve the display locale from the terminal's POSIX locale environment
 * (LC_ALL / LC_MESSAGES / LANG / LANGUAGE), as a BCP-47 tag. Falls back to
 * `en` for the unset, `C`/`POSIX`, or unparseable cases — never throws.
 */
export function resolveTtyLocale(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || env['LANGUAGE'] || '';
  // LANGUAGE may be a colon-separated priority list; take the first entry.
  // Strip the ".UTF-8" charset and "@modifier" suffixes from "en_US.UTF-8".
  const candidate = (raw.split(':')[0] ?? '').split('.')[0]?.split('@')[0]?.trim() ?? '';
  if (candidate === '' || candidate === 'C' || candidate === 'POSIX') return 'en';
  return candidate.replace('_', '-');
}

const SEVERITY_ORDER: readonly ReviewCommentSeverity[] = ['critical', 'important', 'minor'];

/** Escape Markdown control characters in a dynamic value before interpolation. */
export function escapeMarkdown(text: string): string {
  return text.replaceAll(/([\\`*_~#[\]<>])/g, '\\$1');
}

/** Structured data for the colored compact block, from a freshly completed review. */
export function buildReviewSummaryData(result: ReviewResult): ReviewSummaryTranscriptData {
  return {
    fileCount: result.stats.fileCount,
    additions: result.stats.additions,
    deletions: result.stats.deletions,
    handle: result.reviewSlug ?? (result.reviewId === undefined ? undefined : String(result.reviewId)),
    summary: result.summary,
    comments: result.comments.map((comment) => ({
      severity: comment.severity,
      path: comment.path,
      line: comment.line,
      title: comment.title,
      rejected: false,
    })),
  };
}

/** Structured data for the colored compact block, from a persisted artifact (folds rejected). */
export function buildReviewArtifactSummaryData(artifact: ReviewArtifact): ReviewSummaryTranscriptData {
  return {
    fileCount: artifact.stats.fileCount,
    additions: artifact.stats.additions,
    deletions: artifact.stats.deletions,
    handle: artifact.slug,
    summary: artifact.summary,
    comments: artifact.comments.map((comment) => ({
      severity: comment.severity,
      path: comment.anchor.path,
      line: comment.anchor.line,
      title: comment.title,
      rejected: comment.state === 'dismissed',
    })),
  };
}

/** Full grouped-by-severity Markdown for `/review export`. All dynamic values escaped. */
export function formatReviewArtifactMarkdown(artifact: ReviewArtifact): string {
  const lines = [`# Code review: ${escapeMarkdown(artifact.slug)}`, '', escapeMarkdown(artifact.summary), ''];
  for (const severity of SEVERITY_ORDER) {
    const group = artifact.comments.filter(
      (comment) => comment.severity === severity && comment.state !== 'dismissed',
    );
    if (group.length === 0) continue;
    lines.push(`## ${severityLabel(severity)}`, '');
    for (const comment of group) {
      lines.push(`### ${escapeMarkdown(comment.title)}`);
      lines.push(`\`${comment.anchor.path}:${String(comment.anchor.line)}\``, '');
      if (comment.body.length > 0) lines.push(escapeMarkdown(comment.body), '');
      if (comment.suggestedFix !== undefined && comment.suggestedFix.length > 0) {
        lines.push(`**Suggested fix:** ${escapeMarkdown(comment.suggestedFix)}`, '');
      }
    }
  }
  const rejected = artifact.comments.filter((comment) => comment.state === 'dismissed');
  if (rejected.length > 0) {
    lines.push('## Rejected', '');
    for (const comment of rejected) {
      lines.push(`- ~~${escapeMarkdown(`${comment.anchor.path}:${String(comment.anchor.line)} — ${comment.title}`)}~~`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function reviewScopeLabel(scope: ReviewArtifact['target']['scope']): string {
  switch (scope) {
    case 'working_tree':
      return 'Working tree';
    case 'current_branch':
      return 'Current branch';
    case 'single_commit':
      return 'Single commit';
  }
}

/** Header heading for a review's scope, including the base ref / commit when relevant. */
export function reviewTargetHeading(target: ReviewArtifact['target']): string {
  switch (target.scope) {
    case 'working_tree':
      return 'working tree';
    case 'current_branch':
      return `vs ${target.baseRef}`;
    case 'single_commit':
      return `commit ${target.commit.slice(0, 7)}`;
  }
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
