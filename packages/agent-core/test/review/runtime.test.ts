import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import { SessionReviewRuntime } from '../../src/review';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

describe('SessionReviewRuntime', () => {
  it('requires patch coverage before comments and completion', () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'standard' },
      statsFor(['src/a.ts', 'src/b.ts']),
    );
    const assignment = runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: ['src/a.ts', 'src/b.ts'],
      requiredCoverage: 'patch',
    });
    const reviewer = runtime.createAgentFacade(assignment.id);

    expect(() =>
      reviewer.addComment({
        severity: 'important',
        path: 'src/a.ts',
        line: 10,
        title: 'Unchecked input',
        body: 'This line has not been read yet.',
      }),
    ).toThrow('must cite a line that the worker read');

    reviewer.recordPatchRead({
      path: 'src/a.ts',
      ranges: [{ start: 9, end: 12 }],
    });
    const comment = reviewer.addComment({
      severity: 'important',
      path: 'src/a.ts',
      line: 10,
      title: 'Unchecked input',
      body: 'Validate this value before use.',
    });

    expect(comment).toMatchObject({
      id: 'review-comment-1',
      assignmentId: assignment.id,
      state: 'candidate',
    });
    expect(() => reviewer.updateProgress({ status: 'complete' })).toThrow('src/b.ts (patch)');

    reviewer.recordPatchRead({
      path: 'src/b.ts',
      ranges: [{ start: 1, end: 3 }],
    });
    expect(reviewer.updateProgress({ status: 'complete', summary: 'done' })).toMatchObject({
      assignmentId: assignment.id,
      status: 'complete',
      summary: 'done',
    });
  });

  it('combines full-file coverage across multiple reads', () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'deep' },
      statsFor(['src/large.ts']),
    );
    const assignment = runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: ['src/large.ts'],
      requiredCoverage: 'full_file',
    });
    const reviewer = runtime.createAgentFacade(assignment.id);

    reviewer.recordFileVersionRead({
      path: 'src/large.ts',
      lineOffset: 1,
      nLines: 50,
      totalLines: 100,
      changedVersion: true,
    });
    expect(() => reviewer.updateProgress({ status: 'complete' })).toThrow(
      'src/large.ts (full_file)',
    );

    reviewer.recordFileVersionRead({
      path: 'src/large.ts',
      lineOffset: 51,
      nLines: 50,
      totalLines: 100,
      changedVersion: true,
    });
    expect(reviewer.updateProgress({ status: 'complete' })).toMatchObject({
      status: 'complete',
    });
    expect(
      reviewer.addComment({
        severity: 'minor',
        path: 'src/large.ts',
        line: 75,
        title: 'Naming',
        body: 'The full file has been read, so this line can be cited.',
      }),
    ).toMatchObject({ path: 'src/large.ts', line: 75 });
  });

  it('preserves source provenance when comments are merged or dismissed', () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'thorough' },
      statsFor(['src/a.ts']),
    );
    const first = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reviewer',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );
    const second = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reviewer',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );
    const reconciliator = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reconciliator',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );

    first.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 20, end: 22 }] });
    second.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 20, end: 22 }] });
    const firstComment = first.addComment({
      severity: 'critical',
      path: 'src/a.ts',
      line: 21,
      title: 'Missing authorization',
      body: 'The new endpoint does not check the caller.',
      evidence: 'line 21',
    });
    const secondComment = second.addComment({
      severity: 'important',
      path: 'src/a.ts',
      line: 21,
      title: 'Auth check is absent',
      body: 'This path appears reachable without authorization.',
    });

    const merged = reconciliator.mergeComments({
      sourceCommentIds: [firstComment.id, secondComment.id],
      severity: 'critical',
      path: 'src/a.ts',
      line: 21,
      title: 'Missing authorization',
      body: 'The endpoint needs an authorization check before use.',
    });

    expect(merged).toMatchObject({
      id: 'review-merged-comment-1',
      sourceCommentIds: [firstComment.id, secondComment.id],
    });
    expect(runtime.getComments({ state: 'merged' }).map((comment) => comment.id)).toEqual([
      firstComment.id,
      secondComment.id,
    ]);

    const duplicate = first.addComment({
      severity: 'minor',
      path: 'src/a.ts',
      line: 22,
      title: 'Duplicate wording',
      body: 'This repeats the same concern.',
    });
    const dismissed = reconciliator.dismissComment({
      commentId: duplicate.id,
      reason: 'duplicate',
      summary: 'Covered by the merged authorization finding.',
      mergedCommentId: merged.id,
    });

    expect(dismissed).toEqual({
      commentId: duplicate.id,
      reason: 'duplicate',
      summary: 'Covered by the merged authorization finding.',
      mergedCommentId: merged.id,
    });
    expect(runtime.getComments({ state: 'dismissed' }).map((comment) => comment.id)).toEqual([
      duplicate.id,
    ]);
  });

  it('limits reconciliators to their assigned source comments', () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'thorough' },
      statsFor(['src/a.ts']),
    );
    const reviewer = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reviewer',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
      }).id,
    );

    reviewer.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 1, end: 3 }] });
    const assigned = reviewer.addComment({
      severity: 'important',
      path: 'src/a.ts',
      line: 2,
      title: 'Assigned comment',
      body: 'This comment is assigned to the reconciliator.',
    });
    const unassigned = reviewer.addComment({
      severity: 'minor',
      path: 'src/a.ts',
      line: 3,
      title: 'Unassigned comment',
      body: 'This comment belongs to another reconciliation batch.',
    });
    const reconciliator = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reconciliator',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
        sourceCommentIds: [assigned.id],
      }).id,
    );

    expect(() =>
      reconciliator.mergeComments({
        sourceCommentIds: [unassigned.id],
        severity: 'minor',
        path: 'src/a.ts',
        line: 3,
        title: 'Unassigned comment',
        body: 'This should not be allowed.',
      }),
    ).toThrow('Comment is not assigned to this reconciliator');
    expect(() =>
      reconciliator.dismissComment({
        commentId: unassigned.id,
        reason: 'out_of_scope',
        summary: 'Not part of this reconciliation batch.',
      }),
    ).toThrow('Comment is not assigned to this reconciliator');
  });

  it('reports unknown reconciliator source comments as unreconciled', () => {
    const runtime = createRuntime();
    runtime.startReview(
      { target: { scope: 'working_tree' }, intensity: 'thorough' },
      statsFor(['src/a.ts']),
    );
    const reconciliator = runtime.createAgentFacade(
      runtime.createAssignment({
        role: 'reconciliator',
        assignedFiles: ['src/a.ts'],
        requiredCoverage: 'patch',
        sourceCommentIds: ['missing-comment'],
      }).id,
    );
    reconciliator.recordPatchRead({ path: 'src/a.ts', ranges: [{ start: 1, end: 3 }] });

    expect(() =>
      reconciliator.updateProgress({ status: 'complete', summary: 'done' }),
    ).toThrow('Review reconciliation is incomplete: missing-comment');
  });

  it('keeps review access optional for standalone agents', () => {
    const agent = new Agent({ kaos: createFakeKaos() });
    expect(agent.review).toBeUndefined();

    const runtime = createRuntime();
    runtime.startReview({ target: { scope: 'working_tree' }, intensity: 'standard' });
    const assignment = runtime.createAssignment({
      role: 'reviewer',
      assignedFiles: ['src/a.ts'],
      requiredCoverage: 'patch',
    });
    const review = runtime.createAgentFacade(assignment.id);
    const reviewAgent = new Agent({ kaos: createFakeKaos(), review });

    expect(reviewAgent.review?.getAssignment()).toEqual(assignment);
  });
});

function createRuntime(): SessionReviewRuntime {
  const counters = new Map<string, number>();
  return new SessionReviewRuntime({
    idGenerator: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}-${String(next)}`;
    },
  });
}

function statsFor(paths: readonly string[]) {
  return {
    fileCount: paths.length,
    additions: paths.length,
    deletions: 0,
    files: paths.map((path) => ({
      path,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
    })),
  };
}
