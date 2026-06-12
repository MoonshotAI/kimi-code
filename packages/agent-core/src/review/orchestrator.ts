import type { Kaos } from '@moonshot-ai/kaos';

import { loadAgentsMd } from '../profile';
import type { AgentEvent } from '../rpc/events';
import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
} from '../session/subagent-host';
import { toKimiErrorPayload } from '../errors';
import { linkAbortSignal, userCancellationReason } from '../utils/abort';
import {
  createDeepCoverageMatrix,
  DEEP_REVIEW_PERSPECTIVES,
} from './coverage-matrix';
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
  ReviewPlanPreview,
  ReviewProgressStatus,
  ReviewResult,
  ReviewStartInput,
  ReviewTarget,
  ReviewTargetPreview,
} from './types';
import {
  auditReviewAssignment,
  buildReviewWorkerContinuationPrompt,
  ReviewWorkerDriver,
  type ReviewWorkerAudit,
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

interface DeepReviewerAssignment {
  readonly spec: ReturnType<typeof createDeepCoverageMatrix>['reviewerAssignments'][number];
  readonly assignment: ReviewAssignment;
  readonly swarmIndex: number;
  readonly swarmItem: string;
}

interface DeepReviewerSwarmState extends DeepReviewerAssignment {
  agentId?: string;
  previousSignature?: string;
  nonProgressContinuations: number;
}

interface ReviewSwarmLauncher extends ReviewWorkerLauncher {
  runQueued<T>(
    tasks: readonly QueuedSubagentTask<T>[],
  ): Promise<Array<QueuedSubagentRunResult<T>>>;
}

interface DeepReviewerSwarmTaskData {
  readonly assignmentId: string;
}

type ReviewAgentSwarmEvent = NonNullable<
  Extract<AgentEvent, { readonly type: 'review.started' }>['agentSwarm']
>;

const DEEP_REVIEW_AGENT_SWARM_TOOL_CALL_ID = 'review:deep-agent-swarm';
const DEEP_REVIEW_AGENT_SWARM_DESCRIPTION = 'Deep Review reviewers';
const DEEP_REVIEW_AGENT_SWARM_PROMPT_TEMPLATE = 'Run this review assignment:\n{{item}}';
const DEFAULT_MAX_NON_PROGRESS_SWARM_CONTINUATIONS = 3;

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

  async previewPlan(input: ReviewStartInput): Promise<ReviewPlanPreview> {
    this.signal.throwIfAborted();
    const preview = await this.previewTarget(input.target);
    this.signal.throwIfAborted();
    return buildReviewPlanPreview(input.intensity, preview.stats);
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
        agentSwarm: input.intensity === 'deep'
          ? buildDeepReviewAgentSwarmEvent(preview.stats)
          : undefined,
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
      if (this.signal.aborted) {
        if (reviewStarted) {
          this.options.runtime.clear();
        }
        this.emitEvent({ type: 'review.cancelled' });
      } else {
        const payload = toKimiErrorPayload(error);
        this.emitEvent({
          type: 'review.failed',
          message: payload.message,
          error: payload,
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
    const reviewers = await this.runWorkersInParallel((signal) =>
      reviewerAssignments.map((assignment) =>
        this.runWorker({
          assignment,
          profileName: 'reviewer',
          prompt: buildThoroughReviewerPrompt({
            background: context.background,
            assignment,
          }),
          description: `Review changes: ${assignment.perspective ?? 'focused review'}`,
          signal,
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
      return {
        spec,
        assignment,
        swarmIndex: assignmentIdsByKey.size,
        swarmItem: deepReviewSwarmItem(spec),
      };
    });
    const reviewers = await this.runDeepReviewerSwarm(context, reviewerAssignments);
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
    const reconciliators = await this.runWorkersInParallel((signal) =>
      reconciliatorAssignments.map(({ group, assignment, sourceCommentIds }) =>
        this.runWorker({
          assignment,
          profileName: 'reconciliator',
          prompt: buildReconciliatorPrompt({
            background: context.background,
            assignment,
            sourceCommentCount: sourceCommentIds.length,
          }),
          description: `Reconcile Deep Review: ${group.label}`,
          signal,
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
    readonly signal?: AbortSignal;
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
      signal: input.signal ?? this.signal,
    }).run();
  }

  private async runWorkersInParallel<T>(
    buildWorkers: (signal: AbortSignal) => readonly Promise<T>[],
  ): Promise<readonly T[]> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(this.signal, controller);
    const promises = buildWorkers(controller.signal);
    const wrapped = promises.map(async (promise) => {
      try {
        return await promise;
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      }
    });
    try {
      return await Promise.all(wrapped);
    } catch (error) {
      await Promise.allSettled(promises);
      throw error;
    } finally {
      unlink();
    }
  }

  private async runDeepReviewerSwarm(
    context: ReviewRunContext,
    assignments: readonly DeepReviewerAssignment[],
  ): Promise<readonly ReviewWorkerDriverResult[]> {
    const launcher = this.requireSwarmLauncher();
    const states = assignments.map((assignment): DeepReviewerSwarmState => ({
      ...assignment,
      nonProgressContinuations: 0,
    }));
    const terminal = new Map<string, ReviewWorkerDriverResult>();

    while (terminal.size < states.length) {
      const pending = states.filter((state) => !terminal.has(state.assignment.id));
      const tasks = pending.map((state) => this.deepReviewerSwarmTask(context, state));
      const results = await launcher.runQueued(tasks);

      for (const result of results) {
        const state = pending.find((item) => item.assignment.id === result.task.data.assignmentId);
        if (state === undefined) continue;
        if (result.status !== 'completed') {
          const message = result.error ?? `Deep Review worker ${state.assignment.id} ${result.status}`;
          throw new Error(message);
        }
        if (result.agentId === undefined) {
          throw new Error(`Deep Review worker ${state.assignment.id} completed without an agent id.`);
        }
        state.agentId = result.agentId;

        const audit = this.auditAssignment(state.assignment);
        if (audit.status === 'complete' || audit.status === 'blocked') {
          terminal.set(state.assignment.id, {
            agentId: result.agentId,
            status: audit.status,
            summary: audit.summary ?? audit.blocker,
          });
          continue;
        }

        if (audit.signature === state.previousSignature) {
          state.nonProgressContinuations += 1;
        } else {
          state.previousSignature = audit.signature;
          state.nonProgressContinuations = 0;
        }

        if (state.nonProgressContinuations >= DEFAULT_MAX_NON_PROGRESS_SWARM_CONTINUATIONS) {
          throw new Error(
            `Review worker ${state.assignment.id} made no progress after ${String(state.nonProgressContinuations)} continuations.`,
          );
        }
      }
    }

    return states.map((state) => terminal.get(state.assignment.id)!);
  }

  private deepReviewerSwarmTask(
    context: ReviewRunContext,
    state: DeepReviewerSwarmState,
  ): QueuedSubagentTask<DeepReviewerSwarmTaskData> {
    const common = {
      data: { assignmentId: state.assignment.id },
      profileName: 'reviewer',
      parentToolCallId: DEEP_REVIEW_AGENT_SWARM_TOOL_CALL_ID,
      parentToolCallUuid: this.options.parentToolCallUuid,
      description: `Deep Review: ${state.spec.fileGroupName} / ${state.spec.perspective}`,
      swarmIndex: state.swarmIndex,
      swarmItem: state.swarmItem,
      runInBackground: false,
      signal: this.signal,
    };
    if (state.agentId !== undefined) {
      return {
        ...common,
        kind: 'resume',
        resumeAgentId: state.agentId,
        prompt: buildReviewWorkerContinuationPrompt(this.auditAssignment(state.assignment)),
      };
    }
    return {
      ...common,
      kind: 'spawn',
      prompt: buildDeepReviewerPrompt({
        background: context.background,
        assignment: state.assignment,
      }),
      review: this.options.runtime.createAgentFacade(state.assignment.id),
    };
  }

  private requireSwarmLauncher(): ReviewSwarmLauncher {
    if (hasRunQueued(this.options.launcher)) return this.options.launcher;
    throw new Error('Deep Review requires an AgentSwarm-capable subagent launcher.');
  }

  private auditAssignment(assignment: ReviewAssignment): ReviewWorkerAudit {
    return auditReviewAssignment(this.options.runtime, assignment);
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

function hasRunQueued(launcher: ReviewWorkerLauncher): launcher is ReviewSwarmLauncher {
  return typeof (launcher as { runQueued?: unknown }).runQueued === 'function';
}

function buildDeepReviewAgentSwarmEvent(stats: ReviewDiffStats): ReviewAgentSwarmEvent {
  const matrix = createDeepCoverageMatrix({ files: stats.files });
  return {
    toolCallId: DEEP_REVIEW_AGENT_SWARM_TOOL_CALL_ID,
    args: {
      description: DEEP_REVIEW_AGENT_SWARM_DESCRIPTION,
      subagent_type: 'reviewer',
      prompt_template: DEEP_REVIEW_AGENT_SWARM_PROMPT_TEMPLATE,
      items: matrix.reviewerAssignments.map(deepReviewSwarmItem),
      review_swarm: {
        perspectives: matrix.perspectives,
        fileGroups: matrix.fileGroups,
        items: matrix.reviewerAssignments.map((spec, index) => ({
          index: index + 1,
          perspective: spec.perspective,
          fileGroupId: spec.fileGroupId,
          fileGroupName: spec.fileGroupName,
          assignedFiles: spec.assignedFiles,
        })),
      },
    },
  };
}

function deepReviewSwarmItem(
  spec: ReturnType<typeof createDeepCoverageMatrix>['reviewerAssignments'][number],
): string {
  return `${spec.fileGroupName} / ${spec.perspective}: ${spec.assignedFiles.join(', ')}`;
}

export async function previewReviewOrchestratorTarget(
  kaos: Kaos,
  target: ReviewTarget,
): Promise<ReviewTargetPreview> {
  const resolved = await resolveReviewTarget(kaos, target);
  const stats: ReviewDiffStats = await previewReviewTarget(kaos, resolved);
  return { target: resolved, stats };
}

export async function previewReviewOrchestratorPlan(
  kaos: Kaos,
  input: ReviewStartInput,
): Promise<ReviewPlanPreview> {
  const preview = await previewReviewOrchestratorTarget(kaos, input.target);
  return buildReviewPlanPreview(input.intensity, preview.stats);
}

function buildReviewPlanPreview(
  intensity: ReviewStartInput['intensity'],
  stats: ReviewDiffStats,
): ReviewPlanPreview {
  switch (intensity) {
    case 'standard':
      return {
        intensity,
        reviewerCount: 1,
        perspectives: ['standard'],
      };
    case 'thorough':
      return {
        intensity,
        reviewerCount: THOROUGH_REVIEW_PERSPECTIVES.length,
        perspectives: [...THOROUGH_REVIEW_PERSPECTIVES],
      };
    case 'deep': {
      const matrix = createDeepCoverageMatrix({ files: stats.files });
      return {
        intensity,
        reviewerCount: matrix.reviewerAssignments.length,
        perspectives: [...DEEP_REVIEW_PERSPECTIVES],
        fileGroups: matrix.fileGroups.map((group) => ({
          label: group.name,
          files: group.files,
          perspectives: matrix.perspectives,
        })),
        reconciliationGroups: matrix.reconciliationGroups.map((group) => group.label),
      };
    }
  }
}
