import { resolve } from 'node:path';

import { z } from 'zod';

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { readRetryAfterMs, retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IGitService } from '#/app/git/git';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2 } from '#/errors';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { TokenUsage } from '#human/llm-requester/usage';
import type { AssistantMessage, Message } from '#human/llm/message';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { resolveCompletionBudgetParams } from '#/llm-adapter/model/completion-budget';
import { generateModel, type ModelRequestParams } from '#/llm-adapter/model/generate';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import {
  requiresStrictThinkingValidation,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  type ThinkingConfig,
} from '#/llm-adapter/model/thinking';
import {
  PROVIDER_API_ERROR_CODE,
  classifyApiError,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
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
import { AUTO_REVIEW_FLAG_ID } from './flag';
import { IAutoReviewService, type AutoReviewResult } from './review';

const AUTO_REVIEW_REQUEST_KIND = 'auto_review';
const MAX_REVIEW_ATTEMPTS = 3;
const MAX_CONCURRENT_REVIEWS = 4;
const MAX_GIT_STATUS_ENTRIES = 50;

type ReviewAttempt = AutoReviewResult | { readonly kind: 'appended' } | ReviewFailure;

interface ReviewFailure {
  readonly kind: 'failed';
  readonly reason: string;
  readonly error?: unknown;
}

const DecisionSchema = z.union([
  z.object({
    risk: z.enum(['low', 'medium']),
    decision: z.literal('allow'),
    reason: z.null(),
  }).strict().transform(({ risk, decision }) => ({ risk, decision })),
  z.object({
    risk: z.enum(['medium', 'high']),
    decision: z.literal('deny'),
    reason: z.string().nullable(),
  }).strict().transform(({ risk, decision, reason }) => ({
    risk,
    decision,
    reason: reason === null ? undefined : reason.slice(0, 1000),
  })),
]);

const RESPONSE_FORMAT = {
  type: 'json_schema',
  jsonSchema: {
    name: 'auto_review_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        decision: { type: 'string', enum: ['allow', 'deny'] },
        reason: { type: ['string', 'null'] },
      },
      required: ['risk', 'decision', 'reason'],
      additionalProperties: false,
    },
  },
} as const;

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

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionGate permissionGate: IAgentPermissionGate,
    @IModelCatalog private readonly models: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocols: IProtocolAdapterRegistry,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
  ) {
    super();
    if (this.flags.enabled(AUTO_REVIEW_FLAG_ID)) {
      void this.loadProjectInstructions();
    }
    if (typeof permissionGate.registerReviewer === 'function') {
      this._register(
        permissionGate.registerReviewer(
          createAutoReviewReviewer(this.flags, this.modeService, () => this, (toolCallId) => {
            this.approvedToolCallIds.add(toolCallId);
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
    const result = await this.reviewWithDeadline(context, modelAlias, config?.timeoutMs ?? 30000, signal);
    void this.dispatcher.dispatch(new AutoReviewCompleted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      triggerPolicy: trigger,
      model: modelAlias,
      decision: result.kind === 'failed' ? 'failed' : result.decision.decision,
      risk: result.kind === 'failed' ? undefined : result.decision.risk,
      reason: result.kind === 'failed'
        ? result.reason
        : result.decision.decision === 'deny'
          ? result.decision.reason
          : undefined,
      durationMs: Date.now() - startedAt,
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
      risk: result.kind === 'failed' ? undefined : result.decision.risk,
      duration_ms: Date.now() - startedAt,
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
    if (signal.aborted) return Promise.reject(signal.reason);
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
        reject(signal.reason);
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
    const authorization = this.currentAuthorization(history);
    const cwd = this.workspace.workDir;
    const gitStatus = await abortable(this.readGitStatus(cwd, context), deadline.signal);
    const message = await this.requestModel(
      modelAlias,
      buildReviewMessages(
        history,
        authorization,
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
    const current = this.currentAuthorization();
    if (this.workspace.workDir !== cwd) return authorizationChanged();
    if (!sameAuthorization(authorization, current)) {
      return sameAuthorization(authorization, current.slice(0, authorization.length))
        ? { kind: 'appended' }
        : authorizationChanged();
    }
    if (message.toolCalls.length > 0) {
      return { kind: 'failed', reason: 'The reviewer attempted a tool call.' };
    }
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    const parsed = DecisionSchema.safeParse(parseReviewJson(text));
    if (!parsed.success) return { kind: 'failed', reason: 'The reviewer returned an invalid decision.' };
    return { kind: 'decision', decision: parsed.data };
  }

  private currentAuthorization(history: readonly ContextMessage[] = this.loop.history()): ReviewText[] {
    const local = extractAuthorization(history);
    if (
      this.scopeContext.agentId === MAIN_AGENT_ID ||
      local.some((entry) => entry.role === 'human-instruction')
    ) {
      return local;
    }
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return local;
    const inherited = extractAuthorization(
      main.accessor.get(IAgentLoopService).history(),
    ).filter((entry) => entry.role === 'human-instruction');
    return inherited.length === 0 ? local : [...inherited, ...local];
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

  private async requestModel(
    modelAlias: string,
    messages: readonly Message[],
    turnId: number,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const model = this.models.get(modelAlias);
    const overrides = this.configService.get<ModelOverrides>('modelOverrides');
    const thinkingConfig = this.configService.get<ThinkingConfig>(THINKING_SECTION);
    const strict = requiresStrictThinkingValidation(
      this.protocols,
      model.protocol,
      model.providerType,
    );
    const thinkingEffort = resolveThinkingEffortForModel('off', undefined, model, strict);
    const budget = resolveCompletionBudgetParams({
      maxOutputSize: model.maxOutputSize,
      maxCompletionTokensCap: overrides?.maxCompletionTokens,
      capability: model.capabilities,
    });
    const sampling =
      overrides?.temperature === undefined && overrides?.topP === undefined
        ? undefined
        : { temperature: overrides.temperature, topP: overrides.topP };
    const params: ModelRequestParams = {
      cacheKey: `${this.session.sessionId}:${AUTO_REVIEW_REQUEST_KIND}`,
      sampling,
      thinkingEffort,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        thinkingEffort,
      ),
      maxCompletionTokens: budget?.maxCompletionTokens,
      maxContextTokens: budget?.maxContextTokens,
    };
    let message: AssistantMessage | undefined;
    let usage: TokenUsage | undefined;
    for await (const event of generateModel(
      this.protocols.request(model, params),
      {
        systemPrompt: REVIEW_POLICY,
        messages,
        responseFormat: RESPONSE_FORMAT,
      },
      signal,
      params,
    )) {
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'finish') message = event.message;
    }
    if (message === undefined) {
      throw new Error2(
        PROVIDER_API_ERROR_CODE,
        'LLM request stream ended without a finish event.',
      );
    }
    void this.usage.record(this.scopeContext.agentContext, modelAlias, usage, {
      type: 'operation',
      turnId,
      requestKind: AUTO_REVIEW_REQUEST_KIND,
    });
    return message;
  }
}

function reviewResult(outcome: AutoReviewResult | ReviewFailure): AutoReviewResult {
  return outcome.kind === 'decision' ? outcome : { kind: 'failed', reason: outcome.reason };
}

function parseReviewJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
