import type {
  ReviewAssignment,
  ReviewBackground,
  ReviewComment,
  ReviewDiffStats,
  ReviewFinalComment,
  ReviewMergedComment,
  ReviewResult,
  ReviewStartInput,
  ReviewTarget,
} from './types';

export const THOROUGH_REVIEW_PERSPECTIVES = [
  'Correctness and regressions',
  'Security and data safety',
  'Maintainability and tests',
] as const;

export interface BuildReviewBackgroundInput {
  readonly target: ReviewTarget;
  readonly input: ReviewStartInput;
  readonly stats: ReviewDiffStats;
  readonly repoInstructions?: string;
}

export function buildReviewBackground(input: BuildReviewBackgroundInput): ReviewBackground {
  return {
    target: input.target,
    intensity: input.input.intensity,
    focus: input.input.focus,
    stats: input.stats,
    repoInstructions: nonEmpty(input.repoInstructions),
  };
}

export function buildStandardReviewerPrompt(input: {
  readonly background: ReviewBackground;
  readonly assignment: ReviewAssignment;
}): string {
  return buildReviewerPrompt(
    'Review the assigned changes as the single Standard reviewer.',
    input,
    patchCoverageWorkflow(),
  );
}

export function buildThoroughReviewerPrompt(input: {
  readonly background: ReviewBackground;
  readonly assignment: ReviewAssignment;
}): string {
  return buildReviewerPrompt(
    `Review the assigned changes from this perspective: ${input.assignment.perspective ?? 'focused review'}.`,
    input,
    patchCoverageWorkflow(),
  );
}

export function buildDeepReviewerPrompt(input: {
  readonly background: ReviewBackground;
  readonly assignment: ReviewAssignment;
}): string {
  return buildReviewerPrompt(
    `Review the assigned file group from this Deep review perspective: ${input.assignment.perspective ?? 'focused review'}.`,
    input,
    fullFileCoverageWorkflow(),
  );
}

function buildReviewerPrompt(
  lead: string,
  input: {
    readonly background: ReviewBackground;
    readonly assignment: ReviewAssignment;
  },
  workflow: readonly string[],
): string {
  const { background, assignment } = input;
  const lines = [
    lead,
    '',
    'Focus on actionable correctness, reliability, security, data-loss, and maintainability issues introduced by the changed code.',
    'Do not report style preferences, pre-existing issues, or speculative risks without concrete evidence in the reviewed changes.',
    'If the user provided a focus, prioritize it without ignoring serious unrelated regressions.',
    '',
    '<review-background>',
    JSON.stringify(background, null, 2),
    '</review-background>',
    '',
    '<review-assignment>',
    JSON.stringify(assignment, null, 2),
    '</review-assignment>',
    '',
    'Required workflow:',
    ...workflow,
  ];
  return lines.join('\n');
}

function patchCoverageWorkflow(): readonly string[] {
  return [
    '1. Call GetAssignment and GetChangedFiles to orient yourself.',
    '2. For every assigned file, call ReadPatch for the file before completing the assignment.',
    '3. Add one AddComment call per actionable finding. Each comment must cite a line you read.',
    '4. Call UpdateProgress with status `complete` when coverage is satisfied, even if there are no findings.',
    '5. Call UpdateProgress with status `blocked` only if the assignment cannot be completed.',
  ];
}

function fullFileCoverageWorkflow(): readonly string[] {
  return [
    '1. Call GetAssignment and GetChangedFiles to orient yourself.',
    '2. For every assigned file, call ReadFileVersion until the entire file is covered before completing the assignment.',
    '3. For deleted files, use ReadFileVersion with version `base`; for added or untracked files, use version `current`; for branch or commit reviews, use the version that contains the changed code unless you need the base for comparison.',
    '4. Add one AddComment call per actionable finding. Each comment must cite a line you read.',
    '5. Call UpdateProgress with status `complete` when full-file coverage is satisfied, even if there are no findings.',
    '6. Call UpdateProgress with status `blocked` only if the assignment cannot be completed.',
  ];
}

export function buildReconciliatorPrompt(input: {
  readonly background: ReviewBackground;
  readonly assignment: ReviewAssignment;
  readonly sourceCommentCount: number;
}): string {
  return [
    'Reconcile the candidate review comments into the final review.',
    '',
    '<review-background>',
    JSON.stringify(input.background, null, 2),
    '</review-background>',
    '',
    '<review-assignment>',
    JSON.stringify(input.assignment, null, 2),
    '</review-assignment>',
    '',
    `Source comments to reconcile: ${String(input.sourceCommentCount)}.`,
    '',
    'Required workflow:',
    '1. Call GetComments with include_sources true to inspect all candidate source comments.',
    '2. Call ReadPatch for every assigned file before completing the assignment.',
    '3. Merge each actionable finding with MergeComments, preserving every supporting source_comment_id.',
    '4. Dismiss non-actionable, duplicate, unsupported, or out-of-scope comments with DismissComment.',
    '5. Call UpdateProgress with status `complete` only after every source comment is merged or dismissed.',
    '6. Call UpdateProgress with status `blocked` only if reconciliation cannot be completed.',
  ].join('\n');
}

export function candidateToFinalComment(comment: ReviewComment): ReviewFinalComment {
  return {
    id: comment.id,
    sourceCommentIds: [comment.id],
    severity: comment.severity,
    path: comment.path,
    line: comment.line,
    title: comment.title,
    body: comment.body,
    evidence: comment.evidence,
    suggestedFix: comment.suggestedFix,
  };
}

export function mergedToFinalComment(comment: ReviewMergedComment): ReviewFinalComment {
  return {
    id: comment.id,
    sourceCommentIds: comment.sourceCommentIds,
    severity: comment.severity,
    path: comment.path,
    line: comment.line,
    title: comment.title,
    body: comment.body,
    evidence: comment.evidence,
    suggestedFix: comment.suggestedFix,
  };
}

export function summarizeReviewResult(result: Omit<ReviewResult, 'summary'>): string {
  if (result.status === 'blocked') {
    return result.comments.length === 0
      ? 'Review blocked before producing actionable findings.'
      : `Review blocked after producing ${formatCount(result.comments.length, 'finding')}.`;
  }

  if (result.comments.length === 0) {
    return `Review completed for ${formatStats(result.stats)}. No actionable findings.`;
  }

  const findings = result.comments
    .map((comment) => `- ${comment.severity}: ${comment.path}:${String(comment.line)} ${comment.title}`)
    .join('\n');
  return [
    `Review completed for ${formatStats(result.stats)} with ${formatCount(result.comments.length, 'finding')}.`,
    findings,
  ].join('\n');
}

function formatStats(stats: ReviewDiffStats): string {
  return `${formatCount(stats.fileCount, 'file')}, +${String(stats.additions)} -${String(stats.deletions)}`;
}

function formatCount(count: number, singular: string): string {
  return `${String(count)} ${count === 1 ? singular : `${singular}s`}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
