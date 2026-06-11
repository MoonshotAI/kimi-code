import { describe, expect, it } from 'vitest';

import {
  countDeepReviewerCoverage,
  createDeepCoverageMatrix,
  DEEP_REVIEW_PERSPECTIVES,
} from '../../src/review';
import type { ReviewFileChange } from '../../src/review';

describe('createDeepCoverageMatrix', () => {
  it('partitions files while assigning every file to every perspective', () => {
    const matrix = createDeepCoverageMatrix({
      files: files(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']),
      maxFilesPerGroup: 2,
    });

    expect(matrix.fileGroups.map((group) => group.files)).toEqual([
      ['src/a.ts', 'src/b.ts'],
      ['src/c.ts', 'src/d.ts'],
      ['src/e.ts'],
    ]);
    expect(matrix.reviewerAssignments).toHaveLength(
      matrix.fileGroups.length * DEEP_REVIEW_PERSPECTIVES.length,
    );
    expect([...countDeepReviewerCoverage(matrix).entries()]).toEqual([
      ['src/a.ts', DEEP_REVIEW_PERSPECTIVES.length],
      ['src/b.ts', DEEP_REVIEW_PERSPECTIVES.length],
      ['src/c.ts', DEEP_REVIEW_PERSPECTIVES.length],
      ['src/d.ts', DEEP_REVIEW_PERSPECTIVES.length],
      ['src/e.ts', DEEP_REVIEW_PERSPECTIVES.length],
    ]);
  });

  it('groups reconciliation by perspective by default', () => {
    const matrix = createDeepCoverageMatrix({
      files: files(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      perspectives: ['Correctness', 'Security'],
      maxFilesPerGroup: 2,
    });

    expect(matrix.reconciliationKind).toBe('perspective');
    expect(matrix.reconciliationGroups).toEqual([
      {
        id: 'reconcile-p1',
        kind: 'perspective',
        label: 'Correctness',
        perspective: 'Correctness',
        assignedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        sourceAssignmentKeys: ['group-1:p1', 'group-2:p1'],
      },
      {
        id: 'reconcile-p2',
        kind: 'perspective',
        label: 'Security',
        perspective: 'Security',
        assignedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        sourceAssignmentKeys: ['group-1:p2', 'group-2:p2'],
      },
    ]);
  });

  it('can group reconciliation by subsystem file group', () => {
    const matrix = createDeepCoverageMatrix({
      files: files(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      perspectives: ['Correctness', 'Security'],
      maxFilesPerGroup: 2,
      reconciliationKind: 'subsystem',
    });

    expect(matrix.reconciliationGroups).toEqual([
      {
        id: 'reconcile-group-1',
        kind: 'subsystem',
        label: 'Files 1-2',
        fileGroupId: 'group-1',
        assignedFiles: ['src/a.ts', 'src/b.ts'],
        sourceAssignmentKeys: ['group-1:p1', 'group-1:p2'],
      },
      {
        id: 'reconcile-group-2',
        kind: 'subsystem',
        label: 'Files 3-3',
        fileGroupId: 'group-2',
        assignedFiles: ['src/c.ts'],
        sourceAssignmentKeys: ['group-2:p1', 'group-2:p2'],
      },
    ]);
  });

  it('rejects fewer than two perspectives', () => {
    expect(() =>
      createDeepCoverageMatrix({
        files: files(['src/a.ts']),
        perspectives: ['Only'],
      }),
    ).toThrow('Deep review requires at least 2 perspectives');
  });
});

function files(paths: readonly string[]): readonly ReviewFileChange[] {
  return paths.map((path) => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
  }));
}
