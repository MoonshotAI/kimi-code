import { describe, expect, it } from 'vitest';

import {
  buildReconciliatorPrompt,
  buildReviewFanOutPrompt,
  buildReviewPilotPrompt,
  buildStandardReviewerPrompt,
  type ReviewAssignment,
  type ReviewBackground,
  type ReviewDiffStats,
} from '../../src/review';
import { buildReviewWorkerContinuationPrompt } from '../../src/review/worker-driver';

const background: ReviewBackground = {
  target: { scope: 'working_tree' },
  intensity: 'standard',
  stats: {
    fileCount: 1,
    additions: 2,
    deletions: 1,
    files: [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
  },
};

const pilotStats: ReviewDiffStats = {
  fileCount: 2,
  additions: 10,
  deletions: 3,
  files: [
    { path: 'src/a.ts', status: 'modified', additions: 7, deletions: 3 },
    { path: 'src/b.ts', status: 'added', additions: 3, deletions: 0 },
  ],
};

describe('review pilot prompts', () => {
  it('asks the pilot to plan without running the review, and lists the changed files', () => {
    const prompt = buildReviewPilotPrompt({
      target: { scope: 'working_tree' },
      stats: pilotStats,
      intensity: 'thorough',
    });

    expect(prompt).toContain('code review pilot');
    expect(prompt).toContain('do not call RunCodeReview yet');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
  });

  it('leads the directions with the user focus when one is given', () => {
    const prompt = buildReviewPilotPrompt({
      target: { scope: 'working_tree' },
      stats: pilotStats,
      intensity: 'deep',
      focus: 'auth regressions',
    });

    expect(prompt).toContain('auth regressions');
    expect(prompt).toContain("Lead with the user's requested focus");
    expect(prompt).toContain('at least two directions');
  });

  it('tells the fan-out turn to call RunCodeReview with the resolved target', () => {
    const prompt = buildReviewFanOutPrompt({
      target: { scope: 'single_commit', commit: 'abc123' },
      intensity: 'standard',
    });

    expect(prompt).toContain('Call RunCodeReview');
    expect(prompt).toContain('"scope":"single_commit"');
    expect(prompt).toContain('"commit":"abc123"');
  });
});

describe('review prompts', () => {
  it('asks reviewers for review-quality findings instead of generic summaries', () => {
    const prompt = buildStandardReviewerPrompt({
      background,
      assignment: reviewerAssignment,
    });

    expect(prompt).toContain('Each AddComment body should explain');
    expect(prompt).toContain('why the changed code is wrong or risky');
    expect(prompt).toContain('Do not suggest broad refactors');
    expect(prompt).toContain('severity');
    expect(prompt).toContain('expected impact');
    expect(prompt).toContain('For working-tree modified or renamed files, use version `current`');
  });

  it('asks reconciliators to preserve valid findings and dismiss weak ones', () => {
    const prompt = buildReconciliatorPrompt({
      background,
      assignment: {
        ...reconciliatorAssignment,
        sourceCommentIds: ['review-comment-1', 'review-comment-2'],
      },
      sourceCommentCount: 2,
    });

    expect(prompt).toContain('Re-evaluate every source comment');
    expect(prompt).toContain('merge comments only when they describe the same root issue');
    expect(prompt).toContain('Do not weaken severity');
    expect(prompt).toContain('Use DismissComment for false positives');
  });

  it('continues workers with concrete next actions for comments and reconciliation', () => {
    const prompt = buildReviewWorkerContinuationPrompt({
      status: 'active',
      missingCoverage: [],
      unreconciledComments: ['review-comment-1'],
      signature: 'same',
    });

    expect(prompt).toContain('If coverage is complete, inspect unresolved source comments');
    expect(prompt).toContain('merge or dismiss each one');
    expect(prompt).toContain('Do not call complete until every required read and reconciliation step is done');
  });
});

const reviewerAssignment: ReviewAssignment = {
  id: 'review-assignment-1',
  role: 'reviewer',
  assignedFiles: ['src/a.ts'],
  requiredCoverage: 'patch',
};

const reconciliatorAssignment: ReviewAssignment = {
  id: 'review-assignment-2',
  role: 'reconciliator',
  assignedFiles: ['src/a.ts'],
  requiredCoverage: 'patch',
};
