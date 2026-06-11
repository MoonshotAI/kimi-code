import type { ReviewFileChange } from './types';

export const DEEP_REVIEW_PERSPECTIVES = [
  'Correctness and regressions',
  'Security and data safety',
  'Reliability and edge cases',
  'Maintainability and tests',
] as const;

export type DeepReconciliationKind = 'perspective' | 'subsystem';

export interface DeepCoverageMatrixInput {
  readonly files: readonly ReviewFileChange[];
  readonly perspectives?: readonly string[];
  readonly maxFilesPerGroup?: number;
  readonly reconciliationKind?: DeepReconciliationKind;
}

export interface DeepFileGroup {
  readonly id: string;
  readonly name: string;
  readonly files: readonly string[];
}

export interface DeepReviewerAssignmentSpec {
  readonly key: string;
  readonly perspective: string;
  readonly fileGroupId: string;
  readonly fileGroupName: string;
  readonly assignedFiles: readonly string[];
}

export interface DeepReconciliationGroup {
  readonly id: string;
  readonly kind: DeepReconciliationKind;
  readonly label: string;
  readonly perspective?: string;
  readonly fileGroupId?: string;
  readonly assignedFiles: readonly string[];
  readonly sourceAssignmentKeys: readonly string[];
}

export interface DeepCoverageMatrix {
  readonly perspectives: readonly string[];
  readonly fileGroups: readonly DeepFileGroup[];
  readonly reviewerAssignments: readonly DeepReviewerAssignmentSpec[];
  readonly reconciliationKind: DeepReconciliationKind;
  readonly reconciliationGroups: readonly DeepReconciliationGroup[];
}

const DEFAULT_MAX_FILES_PER_GROUP = 4;
const MIN_REVIEWERS_PER_FILE = 2;

export function createDeepCoverageMatrix(input: DeepCoverageMatrixInput): DeepCoverageMatrix {
  const perspectives = normalizePerspectives(input.perspectives ?? DEEP_REVIEW_PERSPECTIVES);
  if (perspectives.length < MIN_REVIEWERS_PER_FILE) {
    throw new Error(
      `Deep review requires at least ${String(MIN_REVIEWERS_PER_FILE)} perspectives for overlapping coverage.`,
    );
  }

  const fileGroups = createFileGroups(
    input.files.map((file) => file.path),
    input.maxFilesPerGroup ?? DEFAULT_MAX_FILES_PER_GROUP,
  );
  const reviewerAssignments = fileGroups.flatMap((group) =>
    perspectives.map((perspective, perspectiveIndex): DeepReviewerAssignmentSpec => ({
      key: `${group.id}:p${String(perspectiveIndex + 1)}`,
      perspective,
      fileGroupId: group.id,
      fileGroupName: group.name,
      assignedFiles: group.files,
    })),
  );
  const reconciliationKind = input.reconciliationKind ?? 'perspective';

  return {
    perspectives,
    fileGroups,
    reviewerAssignments,
    reconciliationKind,
    reconciliationGroups: createReconciliationGroups({
      kind: reconciliationKind,
      perspectives,
      fileGroups,
      reviewerAssignments,
    }),
  };
}

export function countDeepReviewerCoverage(
  matrix: DeepCoverageMatrix,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of matrix.reviewerAssignments) {
    for (const path of assignment.assignedFiles) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}

function createFileGroups(
  paths: readonly string[],
  maxFilesPerGroup: number,
): readonly DeepFileGroup[] {
  const size = Math.max(1, Math.trunc(maxFilesPerGroup));
  const groups: DeepFileGroup[] = [];
  for (let start = 0; start < paths.length; start += size) {
    const files = paths.slice(start, start + size);
    groups.push({
      id: `group-${String(groups.length + 1)}`,
      name: `Files ${String(start + 1)}-${String(start + files.length)}`,
      files,
    });
  }
  return groups;
}

function createReconciliationGroups(input: {
  readonly kind: DeepReconciliationKind;
  readonly perspectives: readonly string[];
  readonly fileGroups: readonly DeepFileGroup[];
  readonly reviewerAssignments: readonly DeepReviewerAssignmentSpec[];
}): readonly DeepReconciliationGroup[] {
  if (input.kind === 'subsystem') {
    return input.fileGroups.map((group): DeepReconciliationGroup => ({
      id: `reconcile-${group.id}`,
      kind: 'subsystem',
      label: group.name,
      fileGroupId: group.id,
      assignedFiles: group.files,
      sourceAssignmentKeys: input.reviewerAssignments
        .filter((assignment) => assignment.fileGroupId === group.id)
        .map((assignment) => assignment.key),
    }));
  }

  return input.perspectives.map((perspective, index): DeepReconciliationGroup => {
    const sourceAssignments = input.reviewerAssignments.filter(
      (assignment) => assignment.perspective === perspective,
    );
    return {
      id: `reconcile-p${String(index + 1)}`,
      kind: 'perspective',
      label: perspective,
      perspective,
      assignedFiles: unique(sourceAssignments.flatMap((assignment) => assignment.assignedFiles)),
      sourceAssignmentKeys: sourceAssignments.map((assignment) => assignment.key),
    };
  });
}

function normalizePerspectives(perspectives: readonly string[]): readonly string[] {
  return perspectives
    .map((perspective) => perspective.trim())
    .filter((perspective, index, list) => perspective.length > 0 && list.indexOf(perspective) === index);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
