export type ReviewScopeKind = 'working_tree' | 'current_branch' | 'single_commit';

export type ReviewIntensity = 'standard' | 'thorough' | 'deep';

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export type ReviewProgressStatus = 'active' | 'complete' | 'blocked';

export type ReviewCommentSeverity = 'critical' | 'important' | 'minor';

export type ReviewCoverageKind = 'patch' | 'full_file';

export type ReviewWorkerRole = 'reviewer' | 'reconciliator';

export type ReviewCommentState = 'candidate' | 'merged' | 'dismissed';

export type ReviewDismissalReason =
  | 'duplicate'
  | 'out_of_scope'
  | 'pre_existing'
  | 'unsupported'
  | 'low_confidence'
  | 'superseded'
  | 'not_actionable';

export interface ReviewWorkingTreeTarget {
  readonly scope: 'working_tree';
  readonly baseRef?: string;
}

export interface ReviewCurrentBranchTarget {
  readonly scope: 'current_branch';
  readonly baseRef: string;
  readonly headRef?: string;
}

export interface ReviewSingleCommitTarget {
  readonly scope: 'single_commit';
  readonly commit: string;
}

export type ReviewTarget =
  | ReviewWorkingTreeTarget
  | ReviewCurrentBranchTarget
  | ReviewSingleCommitTarget;

export interface ReviewFileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ReviewFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary?: boolean;
}

export interface ReviewDiffStats {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly files: readonly ReviewFileChange[];
}

export interface ReviewAssignment {
  readonly id: string;
  readonly role: ReviewWorkerRole;
  readonly perspective?: string;
  readonly assignedFiles: readonly string[];
  readonly requiredCoverage: ReviewCoverageKind;
  readonly sourceCommentIds?: readonly string[];
  readonly group?: string;
}

export interface ReviewComment {
  readonly id: string;
  readonly assignmentId: string;
  readonly state: ReviewCommentState;
  readonly severity: ReviewCommentSeverity;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly body: string;
  readonly evidence?: string;
  readonly suggestedFix?: string;
}

export interface ReviewMergedComment {
  readonly id: string;
  readonly sourceCommentIds: readonly string[];
  readonly severity: ReviewCommentSeverity;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly body: string;
  readonly evidence?: string;
  readonly suggestedFix?: string;
}

export interface ReviewDismissedComment {
  readonly commentId: string;
  readonly reason: ReviewDismissalReason;
  readonly summary: string;
  readonly mergedCommentId?: string;
}

export interface ReviewProgress {
  readonly assignmentId: string;
  readonly status: ReviewProgressStatus;
  readonly summary?: string;
  readonly blocker?: string;
}

export interface ReviewBackground {
  readonly target: ReviewTarget;
  readonly intensity: ReviewIntensity;
  readonly focus?: string;
  readonly stats: ReviewDiffStats;
  readonly repoInstructions?: string;
}

export interface ReviewStartInput {
  readonly target: ReviewTarget;
  readonly intensity: ReviewIntensity;
  readonly focus?: string;
}

export interface ReviewTargetPreview {
  readonly target: ReviewTarget;
  readonly stats: ReviewDiffStats;
}

export interface ReviewWorkingTreeSummary {
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
}

export interface ReviewHeadSummary {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
}

export interface ReviewUpstreamInfo {
  readonly upstreamRef: string;
  readonly upstreamCommit: string;
  readonly headCommit: string;
  readonly aheadCount: number;
  readonly behindCount: number;
}

export interface ReviewScopeSummary {
  readonly workingTree: ReviewWorkingTreeSummary;
  readonly head: ReviewHeadSummary | null;
  readonly upstream: ReviewUpstreamInfo | null;
}

export interface ReviewPlanFileGroup {
  readonly label: string;
  readonly files: readonly string[];
  readonly perspectives: readonly string[];
}

export interface ReviewPlanPreview {
  readonly intensity: ReviewIntensity;
  readonly reviewerCount: number;
  readonly perspectives: readonly string[];
  readonly fileGroups?: readonly ReviewPlanFileGroup[];
  readonly reconciliationGroups?: readonly string[];
}

export interface ReviewBaseRef {
  readonly name: string;
  readonly kind: 'branch' | 'tag' | 'commit';
  readonly description?: string;
}

export interface ReviewCommit {
  readonly sha: string;
  readonly title: string;
  readonly author?: string;
  readonly date?: string;
}

export interface ReviewFinalComment {
  readonly id: string;
  readonly sourceCommentIds: readonly string[];
  readonly severity: ReviewCommentSeverity;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly body: string;
  readonly evidence?: string;
  readonly suggestedFix?: string;
}

export interface ReviewResult {
  readonly target: ReviewTarget;
  readonly intensity: ReviewIntensity;
  readonly status: ReviewProgressStatus;
  readonly stats: ReviewDiffStats;
  readonly summary: string;
  readonly comments: readonly ReviewFinalComment[];
}
