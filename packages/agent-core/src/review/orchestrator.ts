import type { Kaos } from '@moonshot-ai/kaos';

import { loadAgentsMd } from '../profile';
import type { AgentEvent } from '../rpc/events';
import { linkAbortSignal, userCancellationReason } from '../utils/abort';
import { createDeepCoverageMatrix } from './coverage-matrix';
import {
  listReviewBaseRefs,
  listReviewCommits,
  previewReviewTarget,
  resolveReviewTarget,
} from './git-target';
import {
  buildReconciliatorPrompt,
  buildDeepReviewerPrompt,
  buildReviewBackground,
  buildStandardReviewerPrompt,
  buildThoroughReviewerPrompt,
  candidateToFinalComment,
  mergedToFinalComment,
  summarizeReviewResult,
  THOROUGH_REVIEW_PERSPECTIVES,
} from './prompts';
import type {
  ReviewAssignment,
  ReviewBaseRef,
  ReviewCommit,
  ReviewDiffStats,
  ReviewFinalComment,
  ReviewProgressStatus,
  ReviewResult,
  ReviewStartInput,
  ReviewTarget,
  ReviewTargetPreview,
} from './types';
import {
  ReviewWorkerDriver,
  type ReviewWorkerDriverResult,
  type ReviewWorkerLauncher,
} from './worker-driver';
import { ReviewRuntimeError, type SessionReviewRuntime } from './runtime';

type ReviewOrchestratorEvent = Extract<
  AgentEvent,
  | { readonly type: 'review.started' }
  | { readonly type: 'review.completed' }
  | { readonly type: 'review.cancelled' }
  | { readonly type: 'review.failed' }
>;

interface ReviewRunContext {
  readonly input: ReviewStartInput;
  readonly stats: ReviewDiffStats;
  readonly background: ReturnType<typeof buildReviewBackground>;
}

export interface ReviewOrchestratorOptions {
  readonly kaos: Kaos;
  readonly systemKaos?: Kaos;
  readonly kimiHomeDir?: string;
  readonly runtime: SessionReviewRuntime;
  readonly launcher: ReviewWorkerLauncher;
  readonly parentToolCallId?: string;
  readonly parentToolCallUuid?: string;
  readonly signal?: AbortSignal;
  readonly loadRepoInstructions?: () => Promise<string>;
  readonly emitEvent?: (event: ReviewOrchestratorEvent) => void;
}

export class ReviewOrchestrator {
  private readonly controller = new AbortController();
  private readonly unlinkSourceSignal: () => void;

  constructor(private readonly options: ReviewOrchestratorOptions) {
    this.unlinkSourceSignal =
      options.signal === undefined
        ? () => {}
        : linkAbortSignal(options.signal, this.controller);
  }

  async listBaseRefs(): Promise<readonly ReviewBaseRef[]> {
    return listReviewBaseRefs(this.options.kaos);
  }

  async listCommits(): Promise<readonly ReviewCommit[]> {
    return listReviewCommits(this.options.kaos);
  }

  async previewTarget(target: ReviewTarget): Promise<ReviewTargetPreview> {
    this.signal.throwIfAborted();
    const resolved = await resolveReviewTarget(this.options.kaos, target);
    this.signal.throwIfAborted();
    const stats = await previewReviewTarget(this.options.kaos, resolved);
    this.signal.throwIfAborted();
    return { target: resolved, stats };
  }

  async start(input: ReviewStartInput): Promise<ReviewResult> {
    let reviewStarted = false;
    try {
      if (this.options.runtime.getActiveRun() !== null) {
        throw new ReviewRuntimeError('A review is already active');
      }
      this.options.runtime.clear();

      const preview = await this.previewTarget(input.target);
      const repoInstructions = await this.loadRepoInstructions();
      this.signal.throwIfAborted();
      const resolvedInput: ReviewStartInput = {
        target: preview.target,
        intensity: input.intensity,
        focus: input.focus,
      };
      const background = buildReviewBackground({
        target: preview.target,
        input: resolvedInput,
        stats: preview.stats,
        repoInstructions,
      });
      this.options.runtime.startReview(
        resolvedInput,
        preview.stats,
        background,
      );
      reviewStarted = true;
      this.emitEvent({
        type: 'review.started',
        target: preview.target,
        intensity: input.intensity,
        focus: input.focus,
        stats: preview.stats,
      });

      const context: ReviewRunContext = {
        input: resolvedInput,
        stats: preview.stats,
        background,
      };
      const result = await this.runReviewForIntensity(context);
      this.emitEvent({
        type: 'review.completed',
        status: result.status === 'blocked' ? 'blocked' : 'complete',
        summary: result.summary,
        comments: result.comments,
      });
      return result;
    } catch (error) {
      if (this.signal.aborted && reviewStarted) {
        this.options.runtime.clear();
        this.emitEvent({ type: 'review.cancelled' });
      } else {
        this.emitEvent({
          type: 'review.failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (reviewStarted && this.options.runtime.getActiveRun() !== null) {
        this.options.runtime.finishReview();
      }
      this.unlinkSourceSignal();
    }
  }

  cancel(): void {
    this.controller.abort(userCancellationReason());
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  private runReviewForIntensity(context: ReviewRunContext): Promise<ReviewResult> {
    switch (context.input.intensity) {
      case 'standard':
        return this.runStandardReview(context);
      case 'thorough':
        return this.runThoroughReview(context);
      case 'deep':
        return this.runDeepReview(context);
    }
  }

  private async runStandardReview(context: ReviewRunContext): Promise<ReviewResult> {
    const assignment = this.options.runtime.createAssignment({
      role: 'reviewer',
      perspective: 'standard',
      assignedFiles: context.stats.files.map((file) => file.path),
      requiredCoverage: 'patch',
    });
    const worker = await this.runWorker({
      assignment,
      profileName: 'reviewer',
      prompt: buildStandardReviewerPrompt({
        background: context.background,
        assignment,
      }),
      description: 'Review changes',
    });
    const comments = this.options.runtime
      .getComments({ state: 'candidate' })
      .map(candidateToFinalComment);
    return this.buildResult(context, worker.status, comments, worker.summary);
  }

  private async runThoroughReview(context: ReviewRunContext): Promise<ReviewResult> {
    const assignedFiles = context.stats.files.map((file) => file.path);
    const reviewerAssignments = THOROUGH_REVIEW_PERSPECTIVES.map((perspective) =>
      this.options.runtime.createAssignment({
        role: 'reviewer',
        perspective,
        assignedFiles,
        requiredCoverage: 'patch',
        group: 'thorough',
      }),
    );
    const reviewers = await Promise.all(
      reviewerAssignments.map((assignment) =>
        this.runWorker({
          assignment,
          profileName: 'reviewer',
          prompt: buildThoroughReviewerPrompt({
            background: context.background,
            assignment,
          }),
          description: `Review changes: ${assignment.perspective ?? 'focused review'}`,
        }),
      ),
    );
    const blockedReviewer = reviewers.find((worker) => worker.status === 'blocked');
    if (blockedReviewer !== undefined) {
      const comments = this.options.runtime
        .getComments({ state: 'candidate' })
        .map(candidateToFinalComment);
      return this.buildResult(context, 'blocked', comments, blockedReviewer.summary);
    }

    const sourceComments = this.options.runtime.getComments({ state: 'candidate' });
    const reconciliator = this.options.runtime.createAssignment({
      role: 'reconciliator',
      perspective: 'thorough reconciliation',
      assignedFiles,
      requiredCoverage: 'patch',
      sourceCommentIds: sourceComments.map((comment) => comment.id),
      group: 'thorough',
    });
    const worker = await this.runWorker({
      assignment: reconciliator,
      profileName: 'reconciliator',
      prompt: buildReconciliatorPrompt({
        background: context.background,
        assignment: reconciliator,
        sourceCommentCount: sourceComments.length,
      }),
      description: 'Reconcile review comments',
    });
    const comments = this.options.runtime.getMergedComments().map(mergedToFinalComment);
    return this.buildResult(context, worker.status, comments, worker.summary);
  }

  private async runDeepReview(context: ReviewRunContext): Promise<ReviewResult> {
    const matrix = createDeepCoverageMatrix({ files: context.stats.files });
    const assignmentIdsByKey = new Map<string, string>();
    const reviewerAssignments = matrix.reviewerAssignments.map((spec) => {
      const assignment = this.options.runtime.createAssignment({
        role: 'reviewer',
        perspective: spec.perspective,
        assignedFiles: spec.assignedFiles,
        requiredCoverage: 'full_file',
        group: spec.fileGroupId,
      });
      assignmentIdsByKey.set(spec.key, assignment.id);
      return { spec, assignment };
    });
    const reviewers = await Promise.all(
      reviewerAssignments.map(({ spec, assignment }) =>
        this.runWorker({
          assignment,
          profileName: 'reviewer',
          prompt: buildDeepReviewerPrompt({
            background: context.background,
            assignment,
          }),
          description: `Deep review: ${spec.fileGroupName} / ${spec.perspective}`,
        }),
      ),
    );
    const blockedReviewer = reviewers.find((worker) => worker.status === 'blocked');
    if (blockedReviewer !== undefined) {
      const comments = this.options.runtime
        .getComments({ state: 'candidate' })
        .map(candidateToFinalComment);
      return this.buildResult(context, 'blocked', comments, blockedReviewer.summary);
    }

    const candidates = this.options.runtime.getComments({ state: 'candidate' });
    const reconciliatorAssignments = matrix.reconciliationGroups.map((group) => {
      const sourceAssignmentIds = new Set(
        group.sourceAssignmentKeys
          .map((key) => assignmentIdsByKey.get(key))
          .filter((assignmentId): assignmentId is string => assignmentId !== undefined),
      );
      const sourceCommentIds = candidates
        .filter((comment) => sourceAssignmentIds.has(comment.assignmentId))
        .map((comment) => comment.id);
      const assignment = this.options.runtime.createAssignment({
        role: 'reconciliator',
        perspective: group.label,
        assignedFiles: group.assignedFiles,
        requiredCoverage: 'patch',
        sourceCommentIds,
        group: group.id,
      });
      return { group, assignment, sourceCommentIds };
    });
    const reconciliators = await Promise.all(
      reconciliatorAssignments.map(({ group, assignment, sourceCommentIds }) =>
        this.runWorker({
          assignment,
          profileName: 'reconciliator',
          prompt: buildReconciliatorPrompt({
            background: context.background,
            assignment,
            sourceCommentCount: sourceCommentIds.length,
          }),
          description: `Reconcile Deep review: ${group.label}`,
        }),
      ),
    );
    const blockedReconciliator = reconciliators.find((worker) => worker.status === 'blocked');
    const comments = this.options.runtime.getMergedComments().map(mergedToFinalComment);
    return this.buildResult(
      context,
      blockedReconciliator === undefined ? 'complete' : 'blocked',
      comments,
      blockedReconciliator?.summary,
    );
  }

  private runWorker(input: {
    readonly assignment: ReviewAssignment;
    readonly profileName: 'reviewer' | 'reconciliator';
    readonly prompt: string;
    readonly description: string;
  }): Promise<ReviewWorkerDriverResult> {
    return new ReviewWorkerDriver({
      runtime: this.options.runtime,
      launcher: this.options.launcher,
      assignment: input.assignment,
      profileName: input.profileName,
      prompt: input.prompt,
      description: input.description,
      parentToolCallId: this.options.parentToolCallId ?? 'review',
      parentToolCallUuid: this.options.parentToolCallUuid,
      runInBackground: false,
      signal: this.signal,
    }).run();
  }

  private buildResult(
    context: ReviewRunContext,
    status: ReviewProgressStatus,
    comments: readonly ReviewFinalComment[],
    workerSummary: string | undefined,
  ): ReviewResult {
    const resultWithoutSummary: Omit<ReviewResult, 'summary'> = {
      target: context.input.target,
      intensity: context.input.intensity,
      status,
      stats: context.stats,
      comments,
    };
    const summary = summarizeReviewResult(resultWithoutSummary);
    return {
      ...resultWithoutSummary,
      summary: status === 'blocked' && workerSummary !== undefined
        ? `${summary}\n${workerSummary}`
        : summary,
    };
  }

  private async loadRepoInstructions(): Promise<string> {
    if (this.options.loadRepoInstructions !== undefined) {
      return this.options.loadRepoInstructions();
    }
    const kaos = this.options.systemKaos ?? this.options.kaos;
    return loadAgentsMd(kaos, this.options.kimiHomeDir);
  }

  private emitEvent(event: ReviewOrchestratorEvent): void {
    this.options.emitEvent?.(event);
  }
}

export async function previewReviewOrchestratorTarget(
  kaos: Kaos,
  target: ReviewTarget,
): Promise<ReviewTargetPreview> {
  const resolved = await resolveReviewTarget(kaos, target);
  const stats: ReviewDiffStats = await previewReviewTarget(kaos, resolved);
  return { target: resolved, stats };
}
