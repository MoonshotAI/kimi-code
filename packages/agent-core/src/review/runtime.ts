import { randomUUID } from 'node:crypto';

import type {
  ReviewCommentDraft,
  ReviewCommentFilter,
  ReviewDismissCommentInput,
  ReviewMergeCommentDraft,
} from './comments';
import {
  ReviewCoverageTracker,
  type ReviewCoverageMissingItem,
  type ReviewFileVersionCoverageInput,
  type ReviewPatchCoverageInput,
} from './coverage';
import type {
  ReviewAssignment,
  ReviewBackground,
  ReviewComment,
  ReviewDiffStats,
  ReviewDismissedComment,
  ReviewMergedComment,
  ReviewProgress,
  ReviewProgressStatus,
  ReviewStartInput,
} from './types';

export class ReviewRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewRuntimeError';
  }
}

export interface ReviewRuntimeRun {
  readonly target: ReviewStartInput['target'];
  readonly intensity: ReviewStartInput['intensity'];
  readonly focus?: string;
  readonly stats?: ReviewDiffStats;
  readonly background?: ReviewBackground;
  readonly startedAt: number;
}

export interface CreateReviewAssignmentInput {
  readonly id?: string;
  readonly role: ReviewAssignment['role'];
  readonly perspective?: string;
  readonly assignedFiles: readonly string[];
  readonly requiredCoverage: ReviewAssignment['requiredCoverage'];
  readonly sourceCommentIds?: readonly string[];
  readonly group?: string;
}

export interface ReviewProgressUpdate {
  readonly status: ReviewProgressStatus;
  readonly summary?: string;
  readonly blocker?: string;
}

export interface ReviewRuntimeOptions {
  readonly idGenerator?: (prefix: string) => string;
}

export interface ReviewRuntimeEventSink {
  assignmentStarted(assignment: ReviewAssignment): void;
  progressUpdated(progress: ReviewProgress): void;
  commentAdded(comment: ReviewComment): void;
  commentMerged(comment: ReviewMergedComment): void;
  commentDismissed(comment: ReviewDismissedComment): void;
}

export interface ReviewAgentFacade {
  readonly assignmentId: string;
  getActiveRun(): ReviewRuntimeRun;
  getAssignment(): ReviewAssignment;
  getChangedFiles(): ReviewDiffStats['files'];
  recordPatchRead(input: ReviewPatchCoverageInput): void;
  recordFileVersionRead(input: ReviewFileVersionCoverageInput): void;
  updateProgress(input: ReviewProgressUpdate): ReviewProgress;
  addComment(input: ReviewCommentDraft): ReviewComment;
  getComments(filter?: ReviewCommentFilter): readonly ReviewComment[];
  getMergedComments(): readonly ReviewMergedComment[];
  getDismissedComments(): readonly ReviewDismissedComment[];
  getCommentEvidence(commentId: string): string | undefined;
  mergeComments(input: ReviewMergeCommentDraft): ReviewMergedComment;
  dismissComment(input: ReviewDismissCommentInput): ReviewDismissedComment;
}

export class SessionReviewRuntime {
  readonly coverage = new ReviewCoverageTracker();

  private activeRun: ReviewRuntimeRun | null = null;
  private readonly assignments = new Map<string, ReviewAssignment>();
  private readonly progress = new Map<string, ReviewProgress>();
  private readonly comments = new Map<string, ReviewComment>();
  private readonly mergedComments = new Map<string, ReviewMergedComment>();
  private readonly dismissedComments = new Map<string, ReviewDismissedComment>();
  private readonly idGenerator: (prefix: string) => string;
  private eventSink: ReviewRuntimeEventSink | undefined;

  constructor(options: ReviewRuntimeOptions = {}) {
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  setEventSink(eventSink: ReviewRuntimeEventSink | undefined): void {
    this.eventSink = eventSink;
  }

  startReview(
    input: ReviewStartInput,
    stats?: ReviewDiffStats,
    background?: ReviewBackground,
  ): ReviewRuntimeRun {
    if (this.activeRun !== null) {
      throw new ReviewRuntimeError('A review is already active');
    }
    const run: ReviewRuntimeRun = {
      target: input.target,
      intensity: input.intensity,
      focus: input.focus,
      stats,
      background,
      startedAt: Date.now(),
    };
    this.activeRun = run;
    return run;
  }

  finishReview(): void {
    this.activeRun = null;
  }

  clear(): void {
    this.activeRun = null;
    this.assignments.clear();
    this.progress.clear();
    this.comments.clear();
    this.mergedComments.clear();
    this.dismissedComments.clear();
    this.coverage.clear();
  }

  getActiveRun(): ReviewRuntimeRun | null {
    return this.activeRun;
  }

  createAssignment(input: CreateReviewAssignmentInput): ReviewAssignment {
    this.requireActiveRun();
    const id = input.id ?? this.idGenerator('review-assignment');
    if (this.assignments.has(id)) {
      throw new ReviewRuntimeError(`Review assignment already exists: ${id}`);
    }
    const assignment: ReviewAssignment = {
      id,
      role: input.role,
      perspective: input.perspective,
      assignedFiles: input.assignedFiles,
      requiredCoverage: input.requiredCoverage,
      sourceCommentIds: input.sourceCommentIds,
      group: input.group,
    };
    this.assignments.set(id, assignment);
    this.progress.set(id, {
      assignmentId: id,
      status: 'active',
    });
    this.eventSink?.assignmentStarted(assignment);
    return assignment;
  }

  createAgentFacade(assignmentId: string): ReviewAgentFacade {
    this.requireAssignment(assignmentId);
    return {
      assignmentId,
      getActiveRun: () => this.requireActiveRun(),
      getAssignment: () => this.requireAssignment(assignmentId),
      getChangedFiles: () => this.requireActiveRun().stats?.files ?? [],
      recordPatchRead: (input) => {
        this.requireAssignmentFile(assignmentId, input.path);
        this.coverage.recordPatchRead(assignmentId, input);
      },
      recordFileVersionRead: (input) => {
        this.requireAssignmentFile(assignmentId, input.path);
        this.coverage.recordFileVersionRead(assignmentId, input);
      },
      updateProgress: (input) => this.updateProgress(assignmentId, input),
      addComment: (input) => this.addComment(assignmentId, input),
      getComments: (filter) => this.getComments(filter),
      getMergedComments: () => this.getMergedComments(),
      getDismissedComments: () => this.getDismissedComments(),
      getCommentEvidence: (commentId) => this.getCommentEvidence(commentId),
      mergeComments: (input) => this.mergeComments(assignmentId, input),
      dismissComment: (input) => this.dismissComment(assignmentId, input),
    };
  }

  getAssignment(assignmentId: string): ReviewAssignment | undefined {
    return this.assignments.get(assignmentId);
  }

  getProgress(assignmentId: string): ReviewProgress | undefined {
    return this.progress.get(assignmentId);
  }

  missingCoverage(assignmentId: string): readonly ReviewCoverageMissingItem[] {
    return this.coverage.missingCoverage(this.requireAssignment(assignmentId));
  }

  missingReconciliation(assignmentId: string): readonly string[] {
    const assignment = this.requireAssignment(assignmentId);
    if (assignment.role !== 'reconciliator') return [];
    const sourceCommentIds = assignment.sourceCommentIds ?? [];
    if (sourceCommentIds.length === 0) return [];
    return sourceCommentIds.filter((commentId) => {
      const comment = this.comments.get(commentId);
      return comment === undefined || comment.state === 'candidate';
    });
  }

  getComments(filter: ReviewCommentFilter = {}): readonly ReviewComment[] {
    const paths = filter.paths === undefined ? undefined : new Set(filter.paths);
    const sourceCommentIds =
      filter.sourceCommentIds === undefined ? undefined : new Set(filter.sourceCommentIds);
    return [...this.comments.values()].filter((comment) => {
      if (filter.state !== undefined && comment.state !== filter.state) return false;
      if (paths !== undefined && !paths.has(comment.path)) return false;
      if (sourceCommentIds !== undefined && !sourceCommentIds.has(comment.id)) return false;
      return true;
    });
  }

  getMergedComments(): readonly ReviewMergedComment[] {
    return [...this.mergedComments.values()];
  }

  getDismissedComments(): readonly ReviewDismissedComment[] {
    return [...this.dismissedComments.values()];
  }

  getCommentEvidence(commentId: string): string | undefined {
    return this.requireComment(commentId).evidence;
  }

  updateProgress(assignmentId: string, input: ReviewProgressUpdate): ReviewProgress {
    const assignment = this.requireAssignment(assignmentId);
    if (input.status === 'complete') {
      const missing = this.coverage.missingCoverage(assignment);
      if (missing.length > 0) {
        throw new ReviewRuntimeError(formatMissingCoverage(missing));
      }
      const unreconciled = this.missingReconciliation(assignmentId);
      if (unreconciled.length > 0) {
        throw new ReviewRuntimeError(formatMissingReconciliation(unreconciled));
      }
    }
    const progress: ReviewProgress = {
      assignmentId,
      status: input.status,
      summary: input.summary,
      blocker: input.blocker,
    };
    this.progress.set(assignmentId, progress);
    this.eventSink?.progressUpdated(progress);
    return progress;
  }

  addComment(assignmentId: string, input: ReviewCommentDraft): ReviewComment {
    const assignment = this.requireAssignment(assignmentId);
    if (assignment.role !== 'reviewer') {
      throw new ReviewRuntimeError('Only reviewer assignments can add candidate comments');
    }
    this.requireAssignmentFile(assignmentId, input.path);
    this.requireCoveredLine(assignmentId, input.path, input.line);

    const id = this.idGenerator('review-comment');
    const comment: ReviewComment = {
      id,
      assignmentId,
      state: 'candidate',
      severity: input.severity,
      path: input.path,
      line: input.line,
      title: input.title,
      body: input.body,
      evidence: input.evidence,
      suggestedFix: input.suggestedFix,
    };
    this.comments.set(id, comment);
    this.eventSink?.commentAdded(comment);
    return comment;
  }

  mergeComments(assignmentId: string, input: ReviewMergeCommentDraft): ReviewMergedComment {
    const assignment = this.requireReconciliator(assignmentId);
    if (input.sourceCommentIds.length === 0) {
      throw new ReviewRuntimeError('MergeComments requires at least one source comment');
    }
    if (new Set(input.sourceCommentIds).size !== input.sourceCommentIds.length) {
      throw new ReviewRuntimeError('MergeComments source comment ids must be unique');
    }
    for (const commentId of input.sourceCommentIds) {
      this.requireReconciliatorSource(assignment, commentId);
    }

    const sources = input.sourceCommentIds.map((commentId) => this.requireComment(commentId));
    if (!sources.some((comment) => this.coverage.hasLineCoverage(comment.assignmentId, input.path, input.line))) {
      throw new ReviewRuntimeError('Merged comment path and line must be supported by source coverage');
    }

    const merged: ReviewMergedComment = {
      id: this.idGenerator('review-merged-comment'),
      sourceCommentIds: input.sourceCommentIds,
      severity: input.severity,
      path: input.path,
      line: input.line,
      title: input.title,
      body: input.body,
      evidence: input.evidence,
      suggestedFix: input.suggestedFix,
    };
    this.mergedComments.set(merged.id, merged);
    for (const source of sources) {
      this.comments.set(source.id, { ...source, state: 'merged' });
    }
    this.eventSink?.commentMerged(merged);
    return merged;
  }

  dismissComment(assignmentId: string, input: ReviewDismissCommentInput): ReviewDismissedComment {
    const assignment = this.requireReconciliator(assignmentId);
    this.requireReconciliatorSource(assignment, input.commentId);
    const comment = this.requireComment(input.commentId);
    if (comment.state !== 'candidate') {
      throw new ReviewRuntimeError('Only candidate comments can be dismissed');
    }
    if (input.mergedCommentId !== undefined && !this.mergedComments.has(input.mergedCommentId)) {
      throw new ReviewRuntimeError(`Merged comment was not found: ${input.mergedCommentId}`);
    }

    const dismissed: ReviewDismissedComment = {
      commentId: input.commentId,
      reason: input.reason,
      summary: input.summary,
      mergedCommentId: input.mergedCommentId,
    };
    this.dismissedComments.set(input.commentId, dismissed);
    this.comments.set(comment.id, { ...comment, state: 'dismissed' });
    this.eventSink?.commentDismissed(dismissed);
    return dismissed;
  }

  private requireActiveRun(): ReviewRuntimeRun {
    if (this.activeRun === null) {
      throw new ReviewRuntimeError('No review is active');
    }
    return this.activeRun;
  }

  private requireAssignment(assignmentId: string): ReviewAssignment {
    const assignment = this.assignments.get(assignmentId);
    if (assignment === undefined) {
      throw new ReviewRuntimeError(`Review assignment was not found: ${assignmentId}`);
    }
    return assignment;
  }

  private requireAssignmentFile(assignmentId: string, path: string): void {
    const assignment = this.requireAssignment(assignmentId);
    if (!assignment.assignedFiles.includes(path)) {
      throw new ReviewRuntimeError(`Path is not assigned to this review worker: ${path}`);
    }
  }

  private requireCoveredLine(assignmentId: string, path: string, line: number): void {
    if (!Number.isInteger(line) || line <= 0) {
      throw new ReviewRuntimeError('Review comments must cite a positive integer line number');
    }
    if (!this.coverage.hasLineCoverage(assignmentId, path, line)) {
      throw new ReviewRuntimeError(`Review comment must cite a line that the worker read: ${path}:${line}`);
    }
  }

  private requireComment(commentId: string): ReviewComment {
    const comment = this.comments.get(commentId);
    if (comment === undefined) {
      throw new ReviewRuntimeError(`Review comment was not found: ${commentId}`);
    }
    return comment;
  }

  private requireReconciliator(assignmentId: string): ReviewAssignment {
    const assignment = this.requireAssignment(assignmentId);
    if (assignment.role !== 'reconciliator') {
      throw new ReviewRuntimeError('Only reconciliator assignments can merge or dismiss comments');
    }
    return assignment;
  }

  private requireReconciliatorSource(assignment: ReviewAssignment, commentId: string): void {
    if (assignment.sourceCommentIds !== undefined && !assignment.sourceCommentIds.includes(commentId)) {
      throw new ReviewRuntimeError(`Comment is not assigned to this reconciliator: ${commentId}`);
    }
  }
}

function formatMissingCoverage(missing: readonly ReviewCoverageMissingItem[]): string {
  const summary = missing.map((item) => `${item.path} (${item.required})`).join(', ');
  return `Review assignment coverage is incomplete: ${summary}`;
}

function formatMissingReconciliation(commentIds: readonly string[]): string {
  return `Review reconciliation is incomplete: ${commentIds.join(', ')}`;
}
