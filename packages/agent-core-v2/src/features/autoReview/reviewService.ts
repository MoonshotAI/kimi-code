import { resolve } from 'node:path';

import { z } from 'zod';

import { DisposableStore } from '#/_base/di/lifecycle';
import { ref, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { readRetryAfterMs, retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IGitService } from '#/app/git/git';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { Message } from '@moonshot-ai/core/llm/message';
import { classifyApiError, isRetryableGenerateError } from '#/llm-adapter/contract/errors';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { registerLegacyStarting } from '#/agent/toolExecutor/legacyHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { AutoReviewCompleted, AutoReviewStarted } from './autoReviewEvents';
import { createAutoReviewReviewer } from './autoReviewGate';
import REVIEW_POLICY from './auto-review-policy.md?raw';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import {
  buildReviewMessages,
  extractAuthorization,
  sameAuthorization,
  type ReviewGitStatus,
  type ReviewText,
} from './context';
import {
  AUTO_REVIEW_AGENT_LABEL,
  AUTO_REVIEW_FLAG_ID,
  AUTO_REVIEW_FOR_AGENT_LABEL,
  AUTO_REVIEW_REVIEWER_LABEL_VALUE,
  isAutoReviewReviewerLabels,
} from './flag';
import {
  AUTO_REVIEW_CIRCUIT_BREAKER_STOP_REASON,
  IAutoReviewService,
  REVIEWER_READONLY_TOOLS,
  type AutoReviewDecision,
  type AutoReviewResult,
} from './review';

const AUTO_REVIEW_REQUEST_KIND = 'auto_review';
const REVIEWER_PROFILE_NAME = 'auto-review';
const MAX_REVIEW_ATTEMPTS = 3;
const MAX_CONCURRENT_REVIEWS = 4;
const MAX_GIT_STATUS_ENTRIES = 50;
const MAX_REVIEWER_TOOL_ROUNDS = 2;
const MAX_CONSECUTIVE_AUTO_DENIALS = 3;
const ROLLING_AUTO_DENIAL_WINDOW = 50;
const MAX_ROLLING_AUTO_DENIALS = 10;

const REVIEWER_TOOL_DISABLED_MESSAGE =
  'Only the read-only tools Read, Grep, and Glob are available during Auto Review.';
const REVIEWER_APPROVAL_DISABLED_MESSAGE =
  'Interactive approval is unavailable during Auto Review; restricted paths cannot be read.';

type ReviewAttempt = AutoReviewResult | { readonly kind: 'appended' } | ReviewFailure;

interface ReviewFailure {
  readonly kind: 'failed';
  readonly reason: string;
  readonly error?: unknown;
}

const AuthorizationSchema = z.enum(['explicit', 'ambiguous', 'none']);

const DecisionSchema: z.ZodType<AutoReviewDecision> = z.union([
  z.object({
    authorization: AuthorizationSchema,
    risk: z.literal('low'),
    decision: z.literal('allow'),
    reason: z.null(),
  }).strict().transform(({ authorization, risk, decision }) => ({ authorization, risk, decision })),
  z.object({
    authorization: z.literal('explicit'),
    risk: z.literal('medium'),
    decision: z.literal('allow'),
    reason: z.null(),
  }).strict().transform(({ authorization, risk, decision }) => ({ authorization, risk, decision })),
  z.object({
    authorization: AuthorizationSchema,
    risk: z.enum(['medium', 'high']),
    decision: z.literal('deny'),
    reason: z.string().nullable(),
  }).strict().transform(({ authorization, risk, decision, reason }) => ({
    authorization,
    risk,
    decision,
    reason: reason === null ? undefined : reason.slice(0, 1000),
  })),
]);

interface ProjectInstructions {
  readonly agentsMd: string | undefined;
  readonly agentsMdPaths: readonly string[] | undefined;
}

export class AutoReviewService extends Service implements IAutoReviewService {
  declare readonly _serviceBrand: undefined;
  private projectInstructions: Promise<ProjectInstructions> | undefined;
  private activeReviews = 0;
  private readonly reviewSlots: Array<() => void> = [];
  private readonly approvedToolCallIds = new Set<string>();
  private consecutiveDenialsTurnId: number | undefined;
  private consecutiveDenials = 0;
  private readonly rollingAutoOutcomes: Array<'allow' | 'deny'> = [];
  private circuitBrokenTurnId: number | undefined;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionGate permissionGate: IAgentPermissionGate,
    @IAgentEnvironmentBindingService private readonly environmentBinding: IAgentEnvironmentBindingService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
  ) {
    super();
    if (isAutoReviewReviewerLabels(this.scopeContext.meta?.labels)) {
      return;
    }
    if (this.flags.enabled(AUTO_REVIEW_FLAG_ID)) {
      void this.loadProjectInstructions();
    }
    if (this.loop.hooks?.onDidFinishStep !== undefined) {
      this._register(
        this.loop.hooks.onDidFinishStep.register('autoReview', async (ctx, next) => {
          if (this.circuitBrokenTurnId === ctx.turnId) {
            ctx.stopTurn = true;
            ctx.stopReason = AUTO_REVIEW_CIRCUIT_BREAKER_STOP_REASON;
          }
          await next();
        }),
      );
    }
    if (typeof permissionGate.registerReviewer === 'function') {
      this._register(
        permissionGate.registerReviewer(
          createAutoReviewReviewer(this.flags, this.modeService, () => this, {
            onApproved: (toolCallId) => {
              this.approvedToolCallIds.add(toolCallId);
            },
            onAutoAllow: (turnId) => {
              this.recordAutoAllow(turnId);
            },
            onAutoDeny: (turnId) => this.recordAutoDeny(turnId),
            onAutoFailed: (turnId) => {
              this.recordAutoFailed(turnId);
            },
          }),
        ),
      );
    }
  }

  private loadProjectInstructions(): Promise<ProjectInstructions> {
    if (this.projectInstructions === undefined) {
      this.projectInstructions = this.instructions.ready.then(() => ({
        agentsMd: this.instructions.agentsMd,
        agentsMdPaths: this.instructions.agentsMdPaths === undefined
          ? undefined
          : [...this.instructions.agentsMdPaths],
      }));
      void this.projectInstructions.catch(() => undefined);
    }
    return this.projectInstructions;
  }

  private recordAutoAllow(turnId: number): void {
    this.consecutiveDenialsTurnId = turnId;
    this.consecutiveDenials = 0;
    this.pushRollingOutcome('allow');
  }

  private recordAutoFailed(turnId: number): void {
    if (this.consecutiveDenialsTurnId === turnId) {
      this.consecutiveDenials = 0;
    }
  }

  private recordAutoDeny(turnId: number): boolean {
    if (this.circuitBrokenTurnId === turnId) return true;
    if (this.consecutiveDenialsTurnId !== turnId) {
      this.consecutiveDenialsTurnId = turnId;
      this.consecutiveDenials = 0;
    }
    this.consecutiveDenials += 1;
    this.pushRollingOutcome('deny');
    const rollingDenials = this.rollingAutoOutcomes.filter((item) => item === 'deny').length;
    if (
      this.consecutiveDenials >= MAX_CONSECUTIVE_AUTO_DENIALS ||
      rollingDenials >= MAX_ROLLING_AUTO_DENIALS
    ) {
      this.circuitBrokenTurnId = turnId;
      this.consecutiveDenials = 0;
      this.rollingAutoOutcomes.length = 0;
      return true;
    }
    return false;
  }

  private pushRollingOutcome(outcome: 'allow' | 'deny'): void {
    this.rollingAutoOutcomes.push(outcome);
    if (this.rollingAutoOutcomes.length > ROLLING_AUTO_DENIAL_WINDOW) {
      this.rollingAutoOutcomes.shift();
    }
  }

  async review(
    context: ResolvedToolExecutionHookContext,
    trigger: string,
    signal: AbortSignal = context.signal,
  ): Promise<AutoReviewResult> {
    const startedAt = Date.now();
    void this.dispatcher.dispatch(new AutoReviewStarted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
    }));
    const config = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION);
    const modelAlias =
      config?.model ??
      resolveSubagentModelPool(this.configService)?.defaultModel ??
      this.profile.resolveModelContext().modelAlias;
    const result: AutoReviewResult =
      this.circuitBrokenTurnId === context.turnId && this.modeService.mode === 'auto'
        ? {
            kind: 'decision',
            decision: {
              authorization: 'none',
              risk: 'medium',
              decision: 'deny',
              reason: 'Turn already stopped after repeated Auto Review denials.',
            },
          }
        : await this.reviewWithDeadline(context, modelAlias, config?.timeoutMs ?? 30000, signal);
    const durationMs = Date.now() - startedAt;
    const authorization = result.kind === 'failed' ? undefined : result.decision.authorization;
    const risk = result.kind === 'failed' ? undefined : result.decision.risk;
    void this.dispatcher.dispatch(new AutoReviewCompleted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      triggerPolicy: trigger,
      model: modelAlias,
      decision: result.kind === 'failed' ? 'failed' : result.decision.decision,
      risk,
      authorization,
      reason: result.kind === 'failed'
        ? result.reason
        : result.decision.decision === 'deny'
          ? result.decision.reason
          : undefined,
      durationMs,
    }));
    if (result.kind === 'failed') {
      this.log.warn('auto review failed', { model: modelAlias, tool: context.toolCall.name, reason: result.reason });
    }
    this.telemetry.track2('auto_review_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      tool_name: context.toolCall.name,
      trigger_policy: trigger,
      model: modelAlias,
      decision: result.kind === 'failed' ? 'failed' : result.decision.decision,
      risk,
      authorization,
      duration_ms: durationMs,
    });
    return result;
  }

  private async reviewWithDeadline(
    context: ResolvedToolExecutionHookContext,
    modelAlias: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AutoReviewResult> {
    const deadline = createDeadlineAbortSignal(signal, timeoutMs);
    let acquired = false;
    try {
      const projectInstructions = await this.loadProjectInstructions();
      await this.acquireReview(deadline.signal);
      acquired = true;
      let appended = false;
      for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
        let outcome: ReviewAttempt;
        try {
          outcome = await this.reviewOnce(context, modelAlias, projectInstructions, deadline);
        } catch (error) {
          context.signal.throwIfAborted();
          if (contextOverflow(error)) {
            this.compaction.begin({ source: 'auto' });
            return { kind: 'failed', reason: 'The review context exceeded the model window.' };
          }
          if (deadline.signal.aborted) return this.deadlineFailure(deadline);
          outcome = { kind: 'failed', reason: error instanceof Error ? error.message : String(error), error };
        }
        if (outcome.kind === 'appended') {
          if (appended) return authorizationChanged();
          appended = true;
          continue;
        }
        if (outcome.kind === 'decision' || attempt === MAX_REVIEW_ATTEMPTS || !retryableReview(outcome)) {
          return reviewResult(outcome);
        }
        const delayMs = Math.min(
          readRetryAfterMs('error' in outcome ? outcome.error : undefined) ?? retryBackoffDelay(attempt - 1),
          deadline.remainingMs(),
        );
        if (delayMs <= 0 || deadline.signal.aborted) return this.deadlineFailure(deadline);
        await sleepForRetry(delayMs, deadline.signal);
      }
      return { kind: 'failed', reason: 'Review timed out.' };
    } catch (error) {
      context.signal.throwIfAborted();
      if (deadline.signal.aborted) return this.deadlineFailure(deadline);
      return {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (acquired) this.releaseReview();
      deadline.clear();
    }
  }

  private deadlineFailure(deadline: DeadlineAbortSignal): AutoReviewResult {
    return {
      kind: 'failed',
      reason: deadline.timedOut() ? 'Review timed out.' : 'Review cancelled.',
    };
  }

  private acquireReview(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (this.activeReviews < MAX_CONCURRENT_REVIEWS) {
      this.activeReviews += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.reviewSlots.indexOf(grant);
        if (index >= 0) this.reviewSlots.splice(index, 1);
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.reviewSlots.push(grant);
    });
  }

  private releaseReview(): void {
    const next = this.reviewSlots.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.activeReviews -= 1;
  }

  private async reviewOnce(
    context: ResolvedToolExecutionHookContext,
    modelAlias: string,
    projectInstructions: ProjectInstructions,
    deadline: DeadlineAbortSignal,
  ): Promise<ReviewAttempt> {
    const history = this.loop.history();
    const { rootAuthorization, combined } = this.resolveAuthorization(history);
    const cwd = this.workspace.workDir;
    const gitStatus = await abortable(this.readGitStatus(cwd, context), deadline.signal);
    const message = await this.requestReviewer(
      modelAlias,
      buildReviewMessages(
        history,
        rootAuthorization,
        projectInstructions.agentsMd,
        projectInstructions.agentsMdPaths,
        cwd,
        context,
        this.approvedToolCallIds,
        gitStatus,
      ),
      context.turnId,
      deadline.signal,
    );
    const current = this.resolveAuthorization().combined;
    if (this.workspace.workDir !== cwd) return authorizationChanged();
    if (!sameAuthorization(combined, current)) {
      return sameAuthorization(combined, current.slice(0, combined.length))
        ? { kind: 'appended' }
        : authorizationChanged();
    }
    const parsed = DecisionSchema.safeParse(parseReviewJson(message.text));
    if (!parsed.success) return { kind: 'failed', reason: 'The reviewer returned an invalid decision.' };
    return { kind: 'decision', decision: parsed.data };
  }

  private resolveAuthorization(history: readonly ContextMessage[] = this.loop.history()): {
    readonly rootAuthorization: readonly ReviewText[];
    readonly combined: readonly ReviewText[];
  } {
    const local = extractAuthorization(history);
    const isHumanGrant = (entry: ReviewText): boolean =>
      entry.role === 'human-instruction' || entry.role === 'verified-user-answer';
    if (this.scopeContext.agentId === MAIN_AGENT_ID || local.some(isHumanGrant)) {
      return { rootAuthorization: [], combined: local };
    }
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return { rootAuthorization: [], combined: local };
    const inherited = extractAuthorization(
      main.accessor.get(IAgentLoopService).history(),
    ).filter(isHumanGrant);
    return inherited.length === 0
      ? { rootAuthorization: [], combined: local }
      : { rootAuthorization: inherited, combined: [...inherited, ...local] };
  }

  private async readGitStatus(
    cwd: string,
    context: ResolvedToolExecutionHookContext,
  ): Promise<ReviewGitStatus | undefined> {
    const git = this.git?.current;
    if (git === undefined) return undefined;
    const argCwd = isRecord(context.args) && typeof context.args['cwd'] === 'string' && context.args['cwd'].length > 0
      ? context.args['cwd']
      : undefined;
    const targetCwd = argCwd === undefined ? cwd : resolve(cwd, argCwd);
    try {
      const status = await git.status(targetCwd, {
        includePullRequest: false,
        includeStats: false,
      });
      const keys = Object.keys(status.entries);
      if (keys.length === 0) return { branch: status.branch, clean: true };
      const entries = Object.fromEntries(
        keys.slice(0, MAX_GIT_STATUS_ENTRIES).map((key) => [key, status.entries[key]!]),
      );
      return { branch: status.branch, clean: false, entries };
    } catch {
      return undefined;
    }
  }

  private async requestReviewer(
    modelAlias: string,
    messages: readonly Message[],
    turnId: number,
    signal: AbortSignal,
  ): Promise<{ readonly text: string }> {
    const binding = this.environmentBinding.current;
    const created = await this.agentLifecycle.create({
      initialProfile: {
        modelAlias,
        profileName: REVIEWER_PROFILE_NAME,
        thinkingLevel: 'off',
        systemPrompt: REVIEW_POLICY,
        activeToolNames: [...REVIEWER_READONLY_TOOLS],
        disallowedTools: [SELECT_TOOLS_TOOL_NAME],
      },
      labels: {
        [AUTO_REVIEW_AGENT_LABEL]: AUTO_REVIEW_REVIEWER_LABEL_VALUE,
        [AUTO_REVIEW_FOR_AGENT_LABEL]: this.scopeContext.agentId,
      },
      environmentId: binding.environmentId,
      environmentCwd: binding.cwd,
    });
    const handle = this.agentLifecycle.handleOf(created.agentId);
    if (handle === undefined) {
      await this.agentLifecycle.remove(created);
      throw new Error('The reviewer agent could not be started.');
    }
    const guards = configureReviewerGuards(handle);
    try {
      const prompt = messages
        .flatMap((message) => message.content)
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n');
      const run = await runAgentTurn(handle, { kind: 'prompt', prompt }, { signal });
      const completion = await run.completion;
      void this.usage.record(this.scopeContext.agentContext, modelAlias, completion.usage, {
        type: 'operation',
        turnId,
        requestKind: AUTO_REVIEW_REQUEST_KIND,
      });
      return { text: completion.summary };
    } finally {
      guards.dispose();
      await this.agentLifecycle.remove(created);
    }
  }
}

function configureReviewerGuards(handle: IAgentScopeHandle): DisposableStore {
  const guards = new DisposableStore();
  optionalGet(handle, IAgentPermissionModeService)?.setMode('manual');
  const toolExecutor = optionalGet(handle, IAgentToolExecutorService);
  if (toolExecutor !== undefined) {
    guards.add(
      registerLegacyStarting(toolExecutor, (event) => {
        if (!REVIEWER_READONLY_TOOLS.has(event.toolCall.name)) {
          event.veto(denyToolExecution(REVIEWER_TOOL_DISABLED_MESSAGE));
        }
      }),
    );
  }
  const permissionGate = optionalGet(handle, IAgentPermissionGate);
  if (permissionGate !== undefined && typeof permissionGate.registerReviewer === 'function') {
    guards.add(
      permissionGate.registerReviewer({
        review: (_ctx, evaluation) =>
          evaluation.result.kind === 'ask'
            ? () => Promise.resolve({
                policyName: 'auto-review-reviewer-readonly',
                result: { kind: 'deny', message: REVIEWER_APPROVAL_DISABLED_MESSAGE },
              })
            : undefined,
      }),
    );
  }
  const reviewerLoop = optionalGet(handle, IAgentLoopService);
  if (reviewerLoop?.hooks?.onWillBeginStep !== undefined) {
    guards.add(
      reviewerLoop.hooks.onWillBeginStep.register('autoReviewReviewerStepCap', async (ctx, next) => {
        if (ctx.step > MAX_REVIEWER_TOOL_ROUNDS) {
          reviewerLoop.update({ activeToolNames: [] });
        }
        await next();
      }),
    );
  }
  return guards;
}

function optionalGet<T>(handle: IAgentScopeHandle, token: ServiceIdentifier<T>): T | undefined {
  try {
    return handle.accessor.get(token);
  } catch {
    return undefined;
  }
}

function reviewResult(outcome: AutoReviewResult | ReviewFailure): AutoReviewResult {
  return outcome.kind === 'decision' ? outcome : { kind: 'failed', reason: outcome.reason };
}

export function parseReviewJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const direct: unknown = JSON.parse(trimmed);
    return direct;
  } catch {
    return extractTrailingJsonObject(trimmed);
  }
}

function extractTrailingJsonObject(text: string): unknown {
  let closeIndex = text.lastIndexOf('}');
  while (closeIndex >= 0) {
    const floor = Math.max(0, closeIndex - 4096);
    let openIndex = text.lastIndexOf('{', closeIndex);
    while (openIndex >= floor) {
      try {
        const candidate: unknown = JSON.parse(text.slice(openIndex, closeIndex + 1));
        if (isRecord(candidate) && 'decision' in candidate) {
          return candidate;
        }
      } catch {
      }
      openIndex = text.lastIndexOf('{', openIndex - 1);
    }
    closeIndex = text.lastIndexOf('}', closeIndex - 1);
  }
  return undefined;
}

function retryableReview(outcome: ReviewFailure): boolean {
  if (outcome.error !== undefined) return isRetryableGenerateError(outcome.error);
  return outcome.reason === 'The reviewer returned an invalid decision.';
}

function contextOverflow(error: unknown): boolean {
  return classifyApiError(error).kind === 'context_overflow';
}

function authorizationChanged(): AutoReviewResult {
  return { kind: 'failed', reason: 'Authorization changed during review.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
