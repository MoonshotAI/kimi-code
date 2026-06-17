import type { ReviewCommentSeverity, ReviewDismissalReason } from './types';

export interface ReviewCommentDraft {
  readonly severity: ReviewCommentSeverity;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly body: string;
  readonly evidence?: string;
  readonly suggestedFix?: string;
}

export interface ReviewMergeCommentDraft extends ReviewCommentDraft {
  readonly sourceCommentIds: readonly string[];
}

export interface ReviewDismissCommentInput {
  readonly commentId: string;
  readonly reason: ReviewDismissalReason;
  readonly summary: string;
  readonly mergedCommentId?: string;
}

export interface ReviewCommentFilter {
  readonly state?: 'candidate' | 'merged' | 'dismissed';
  readonly paths?: readonly string[];
  readonly sourceCommentIds?: readonly string[];
}
