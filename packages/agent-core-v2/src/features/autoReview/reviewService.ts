import { z } from 'zod';

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { readRetryAfterMs, retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
} from '@moonshot-ai/core/llm/thinking';
import type { TokenUsage } from '@moonshot-ai/core/llm/usage';
import type { AssistantMessage, Message } from '@moonshot-ai/core/llm/message';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import { credentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { PermissionApprovalResolved } from '#/agent/toolApproval/toolApprovalService';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { resolveMaxOutputTokens } from '#/llm-adapter/model/completion-budget';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import {
  requiresStrictThinkingValidation,
  type ThinkingConfig,
} from '#/llm-adapter/model/thinking';
import {
  errorFromLlmMessage,
  llmMessageFromError,
  withErrorDiagnostics,
  classifyApiError,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import { translateProviderError } from '#/llm-adapter/protocol/errors';
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
import { ISessionWorkdir } from '#/session/workdir/workdir';
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

type ReviewAttempt =
  | Extract<AutoReviewResult, { readonly kind: 'decision' }>
  | { readonly kind: 'appended' }
  | ReviewFailure;

interface ReviewFailure {
  readonly kind: 'failed';
  readonly reason: string;
  readonly retryable: boolean;
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
  private inheritedAuthorization: readonly ReviewText[] | undefined;
  private activeReviews = 0;
  private readonly reviewSlots: Array<() => void> = [];
  private readonly approvedToolCallIds = new Set<string>();

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionGate permissionGate: IAgentPermissionGate,
    @IEventBus eventBus: IEventBus,
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
    @ref(ISessionWorkdir) private readonly workdir: LiveRef<ISessionWorkdir>,
  ) {
    super();
    if (this.flags.enabled(AUTO_REVIEW_FLAG_ID)) {
      void this.loadProjectInstructions();
      this.inheritedAuthorization = this.readInheritedAuthorization();
    }
    this._register(
      eventBus.subscribe(PermissionApprovalResolved, (event) => {
        if (event.agentId === this.scopeContext.agentId && event.decision === 'approved') {
          this.approvedToolCallIds.add(event.toolCallId);
        }
      }),
    );
    this._register(
      permissionGate.registerReviewer(
        createAutoReviewReviewer(this.flags, this.modeService, this),
      ),
    );
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
    const result = await this.reviewWithDeadline(context, modelAlias, config?.timeoutMs ?? 30000);
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
  ): Promise<AutoReviewResult> {
    const deadline = createDeadlineAbortSignal(context.signal, timeoutMs);
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
          outcome = {
            kind: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            retryable: isRetryableGenerateError(error),
            error,
          };
        }
        if (outcome.kind === 'appended') {
          if (appended) return authorizationChanged();
          appended = true;
          continue;
        }
        if (outcome.kind === 'decision' || attempt === MAX_REVIEW_ATTEMPTS || !outcome.retryable) {
          return reviewResult(outcome);
        }
        const delayMs = Math.min(
          readRetryAfterMs(outcome.error) ?? retryBackoffDelay(attempt - 1),
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
      return { kind: 'failed', reason: 'The reviewer attempted a tool call.', retryable: false };
    }
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    const parsed = DecisionSchema.safeParse(parseReviewJson(text));
    if (!parsed.success) {
      return { kind: 'failed', reason: 'The reviewer returned an invalid decision.', retryable: true };
    }
    return { kind: 'decision', decision: parsed.data };
  }

  private currentAuthorization(history: readonly ContextMessage[] = this.loop.history()): ReviewText[] {
    const local = extractAuthorization(history);
    const inherited = (this.inheritedAuthorization ??= this.readInheritedAuthorization());
    return inherited.length === 0 ? local : [...inherited, ...local];
  }

  private readInheritedAuthorization(): readonly ReviewText[] {
    if (
      this.scopeContext.agentId === MAIN_AGENT_ID ||
      (this.scopeContext.meta?.forkedFrom ?? this.scopeContext.forkedFrom) !== undefined
    ) {
      return [];
    }
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return [];
    return extractAuthorization(main.accessor.get(IAgentLoopService).history())
      .filter((entry) => entry.role === 'human-instruction');
  }

  private async readGitStatus(
    cwd: string,
    context: ResolvedToolExecutionHookContext,
  ): Promise<ReviewGitStatus | undefined> {
    const git = this.workdir?.current?.git;
    if (git === undefined) return undefined;
    const argCwd = isRecord(context.args) && typeof context.args['cwd'] === 'string' && context.args['cwd'].length > 0
      ? context.args['cwd']
      : undefined;
    const targetCwd = argCwd === undefined ? cwd : this.workspace.resolve(argCwd);
    try {
      const status = await git.statusAt(targetCwd, {
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
    const thinkingEffort = resolveThinkingEffortForModel('off', undefined, model.spec, strict);
    const sampling =
      overrides?.temperature === undefined && overrides?.topP === undefined
        ? undefined
        : { temperature: overrides.temperature, topP: overrides.topP };
    const params: InitializedLlmRequestPart = {
      model: {
        cacheKey: `${this.session.sessionId}:${AUTO_REVIEW_REQUEST_KIND}`,
        sampling,
        thinking: {
          effort: thinkingEffort,
          keep: resolveThinkingKeep(
            overrides?.thinkingKeep,
            thinkingConfig?.keep,
            thinkingEffort,
          ),
        },
        maxOutputTokens: resolveMaxOutputTokens({
          maxOutputSize: model.maxOutputSize,
          maxCompletionTokensCap: overrides?.maxCompletionTokens,
        }),
      },
    };
    const outcome = await this.protocols.request(model, params).with({
      model: { responseFormat: RESPONSE_FORMAT },
      profile: { systemPrompt: REVIEW_POLICY, tools: [] },
      content: { messages },
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: [credentialRecovery],
      },
    }).generate({}, { signal });
    if (outcome.type === 'aborted') throw signal.reason;
    if (outcome.type === 'failed') throw reviewRequestError(outcome);
    const message: AssistantMessage = outcome.message;
    const usage: TokenUsage | undefined = outcome.usage;
    void this.usage.record(this.scopeContext.agentContext, modelAlias, usage, {
      type: 'operation',
      turnId,
      requestKind: AUTO_REVIEW_REQUEST_KIND,
    });
    return message;
  }
}

function reviewRequestError(outcome: Extract<LlmOutcome, { readonly type: 'failed' }>): Error {
  const classified =
    outcome.error.kind === 'unknown' && outcome.rawError !== undefined
      ? llmMessageFromError(outcome.rawError)
      : undefined;
  if (outcome.error.kind === 'unknown' && classified === undefined && outcome.rawError instanceof Error) {
    return withErrorDiagnostics(translateProviderError(outcome.rawError), outcome.diagnostics);
  }
  return errorFromLlmMessage(classified ?? outcome.error, outcome.diagnostics);
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

function contextOverflow(error: unknown): boolean {
  return classifyApiError(error).kind === 'context_overflow';
}

function authorizationChanged(): ReviewFailure {
  return { kind: 'failed', reason: 'Authorization changed during review.', retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
