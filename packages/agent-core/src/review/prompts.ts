import type {
  ReviewAssignment,
  ReviewBackground,
  ReviewComment,
  ReviewDiffStats,
  ReviewFinalComment,
  ReviewIntensity,
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
    changeType: nonEmpty(input.input.changeType),
    briefing: nonEmpty(input.input.background),
  };
}

/**
 * Turn-1 prompt: the main agent acts as the review pilot. It studies the
 * selected changes and writes a background briefing plus the review directions,
 * but does not modify files or run the review yet.
 */
export function buildReviewPilotPrompt(input: {
  readonly target: ReviewTarget;
  readonly stats: ReviewDiffStats;
  readonly intensity: ReviewIntensity;
  readonly focus?: string;
}): string {
  const { target, stats, intensity, focus } = input;
  const trimmedFocus = focus?.trim();
  const hasFocus = trimmedFocus !== undefined && trimmedFocus.length > 0;
  const lines = [
    'You are the code review pilot. A review has been requested; in this step, study the selected changes and plan the review. Do not modify any files, and do not call RunCodeReview yet.',
    '',
    `Scope: ${describeReviewTarget(target)}.`,
    `Intensity: ${intensity}.`,
    `Changed (${formatStats(stats)}):`,
    ...stats.files.map(
      (file) => `- ${file.path} (${file.status}, +${String(file.additions)} -${String(file.deletions)})`,
    ),
    '',
  ];
  if (hasFocus) {
    lines.push(`The user asked you to focus the review on: ${trimmedFocus}`, '');
  }
  lines.push(
    'Inspect the actual changes (read the diff and the relevant code), then write:',
    '1. A background briefing for the reviewers — what this change is, its intent, and the context they need to judge it. Keep it factual orientation; do not state whether the code is correct.',
    hasFocus
      ? '2. The review directions to pursue. Lead with the user\'s requested focus, then add the angles the change most warrants.'
      : '2. The review directions to pursue — the distinct angles the change most warrants (e.g. correctness, security, edge cases, tests, compatibility).',
    intensity === 'deep'
      ? 'Plan at least two directions; deep review needs overlapping coverage.'
      : intensity === 'thorough'
        ? 'Plan a few focused directions; each becomes one reviewer.'
        : 'One overall direction is enough for a standard review, though you may note a couple of priorities.',
    '',
    'Write the background and directions in your reply. Do not call any review tool yet — the next message will ask you to run the review.',
  );
  return lines.join('\n');
}

/**
 * Turn-2 prompt: tell the pilot to run the review by calling RunCodeReview with
 * the background and directions it just decided.
 */
export function buildReviewFanOutPrompt(input: {
  readonly target: ReviewTarget;
  readonly intensity: ReviewIntensity;
}): string {
  const { target, intensity } = input;
  return [
    'Now run the review. Call RunCodeReview exactly once, using the background and directions you just decided:',
    `- target: ${JSON.stringify(target)}`,
    `- intensity: ${intensity}`,
    '- background: the briefing you wrote (factual orientation for the reviewers, not a verdict)',
    `- directions: the directions you decided${intensity === 'deep' ? ' (at least two)' : ''}; lead with the user's focus if one was given`,
    '- change_type: a short one-line label for the change',
    '',
    'The reviewers are read-only and independent — each only sees your background, its assigned files, and its direction. After RunCodeReview returns, give the user a brief summary of the outcome.',
  ].join('\n');
}

function describeReviewTarget(target: ReviewTarget): string {
  switch (target.scope) {
    case 'working_tree':
      return target.baseRef === undefined
        ? 'the working tree (staged, unstaged, and untracked changes)'
        : `the working tree against ${target.baseRef}`;
    case 'current_branch':
      return `the current branch${target.headRef === undefined ? '' : ` (${target.headRef})`} against ${target.baseRef}`;
    case 'single_commit':
      return `the single commit ${target.commit}`;
  }
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
    `Review the assigned file group from this Deep Review perspective: ${input.assignment.perspective ?? 'focused review'}.`,
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
    'Do not suggest broad refactors unless the current change makes a concrete bug likely.',
    'If the user provided a focus, prioritize it without ignoring serious unrelated regressions.',
    '',
    'Finding standards:',
    '- Add a comment only when you can describe a real failure scenario, not just a possible improvement.',
    '- Each AddComment body should explain the scenario, why the changed code is wrong or risky, and the expected impact.',
    '- Cite the smallest useful line you read. Prefer changed lines; use nearby context lines only when that is where the defect is visible.',
    '- For working-tree modified or renamed files, use version `current` when reading changed code with ReadFileVersion; version `base` is the pre-change file.',
    '- Choose severity by expected impact: critical for security exposure, data loss, crashes, or severe correctness failures; important for likely user-visible regressions; minor for real but lower-impact issues.',
    '- Missing tests are findings only when the missing coverage lets a concrete regression through; describe the regression, not just the absence of tests.',
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
    '2. Call ReadDiff to inspect the actual changed lines before completing the assignment. ReadDiff is the review-safe equivalent of running `git diff` and is scoped to your assigned files.',
    '3. Add one AddComment call per actionable finding. Each comment must cite a line you read.',
    '4. Call UpdateProgress with status `complete` when coverage is satisfied, even if there are no findings.',
    '5. Call UpdateProgress with status `blocked` only if the assignment cannot be completed.',
  ];
}

function fullFileCoverageWorkflow(): readonly string[] {
  return [
    '1. Call GetAssignment and GetChangedFiles to orient yourself.',
    '2. For every assigned file, call ReadFileVersion until the entire file is covered before completing the assignment.',
    '3. For working-tree modified or renamed files, use version `current` to read changed code; version `base` is the pre-change file.',
    '4. For deleted files, use ReadFileVersion with version `base`; for added or untracked files, use version `current`; for branch or commit reviews, use the version that contains the changed code unless you need the base for comparison.',
    '5. Add one AddComment call per actionable finding. Each comment must cite a line you read.',
    '6. Call UpdateProgress with status `complete` when full-file coverage is satisfied, even if there are no findings.',
    '7. Call UpdateProgress with status `blocked` only if the assignment cannot be completed.',
  ];
}

export function buildReconciliatorPrompt(input: {
  readonly background: ReviewBackground;
  readonly assignment: ReviewAssignment;
  readonly sourceCommentCount: number;
}): string {
  return [
    'Reconcile the candidate review comments into the final review.',
    'Re-evaluate every source comment against the changed code and evidence before deciding whether it belongs in the final review.',
    'Keep the final review concise: one final comment per distinct root issue, with clear severity, location, scenario, reason, and impact.',
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
    '2. Call GetCommentEvidence or read the relevant diff/file context whenever a source comment is not self-evidently supported.',
    '3. Call ReadDiff for every assigned file before completing the assignment. ReadDiff is the review-safe equivalent of running `git diff` and is scoped to your assigned files.',
    '4. Merge each actionable finding with MergeComments, preserving every supporting source_comment_id; merge comments only when they describe the same root issue.',
    '5. Do not weaken severity when the highest-impact source comment is valid; adjust severity only when the evidence shows a lower or higher actual impact.',
    '6. Use DismissComment for false positives, duplicates, unsupported claims, pre-existing issues, low-confidence guesses, out-of-scope comments, and comments that are not actionable.',
    '7. Call UpdateProgress with status `complete` only after every source comment is merged or dismissed.',
    '8. Call UpdateProgress with status `blocked` only if reconciliation cannot be completed.',
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
      ? 'Review blocked before producing review comments.'
      : `Review blocked after producing ${formatCount(result.comments.length, 'review comment')}.`;
  }

  if (result.comments.length === 0) {
    return `Review completed for ${formatStats(result.stats)}. No review comments.`;
  }

  const comments = result.comments
    .map((comment) => `- ${comment.severity}: ${comment.path}:${String(comment.line)} ${comment.title}`)
    .join('\n');
  return [
    `Review completed for ${formatStats(result.stats)} with ${formatCount(result.comments.length, 'review comment')}.`,
    comments,
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
