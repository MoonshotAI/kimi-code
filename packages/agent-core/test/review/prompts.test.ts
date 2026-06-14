import { describe, expect, it } from 'vitest';

import {
  buildReconciliatorPrompt,
  buildStandardReviewerPrompt,
  type ReviewAssignment,
  type ReviewBackground,
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
