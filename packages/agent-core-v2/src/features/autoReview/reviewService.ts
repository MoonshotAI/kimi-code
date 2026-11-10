import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { createDeadlineAbortSignal, isAbortError, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { readRetryAfterMs, retryBackoffDelay, sleepForRetry } from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, isError2 } from '#/errors';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import type { TokenUsage } from '#human/llm-requester/usage';
import type { AssistantMessage, Message } from '#human/llm/message';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { completionBudgetParams, resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';
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
  PROVIDER_AUTH_ERROR_CODE,
  PROVIDER_CONNECTION_ERROR_CODE,
  PROVIDER_OVERLOADED_ERROR_CODE,
  PROVIDER_RATE_LIMIT_ERROR_CODE,
  classifyApiError,
} from '#/llm-adapter/contract/errors';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { AutoReviewCompleted, AutoReviewStarted } from './autoReviewEvents';
import REVIEW_POLICY from './auto-review-policy.md?raw';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import { buildReviewMessages, extractAuthorization, sameAuthorization } from './context';
import { IAutoReviewService, type AutoReviewResult } from './review';

const AUTO_REVIEW_REQUEST_KIND = 'auto_review';
const MAX_REVIEW_ATTEMPTS = 3;

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
      anyOf: [
        {
          type: 'object',
          properties: {
            risk: { type: 'string', enum: ['low', 'medium'] },
            decision: { type: 'string', enum: ['allow'] },
            reason: { type: 'null' },
          },
          required: ['risk', 'decision', 'reason'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            risk: { type: 'string', enum: ['medium', 'high'] },
            decision: { type: 'string', enum: ['deny'] },
            reason: { type: ['string', 'null'] },
          },
          required: ['risk', 'decision', 'reason'],
          additionalProperties: false,
        },
      ],
    },
  },
} as const;

interface ProjectInstructions {
  readonly agentsMd: string | undefined;
  readonly agentsMdPaths: readonly string[] | undefined;
}

export class AutoReviewService extends Service implements IAutoReviewService {
  declare readonly _serviceBrand: undefined;
  private readonly projectInstructions: Promise<ProjectInstructions>;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IModelCatalog private readonly models: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocols: IProtocolAdapterRegistry,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.projectInstructions = this.instructions.ready.then(() => ({
      agentsMd: this.instructions.agentsMd,
      agentsMdPaths: this.instructions.agentsMdPaths === undefined
        ? undefined
        : [...this.instructions.agentsMdPaths],
    }));
    void this.projectInstructions.catch(() => undefined);
  }

  async review(context: ResolvedToolExecutionHookContext, trigger: string): Promise<AutoReviewResult> {
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
    try {
      const projectInstructions = await this.projectInstructions;
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
          outcome = deadline.signal.aborted
            ? { kind: 'failed', reason: 'Review timed out.' }
            : { kind: 'failed', reason: error instanceof Error ? error.message : String(error), error };
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
        if (delayMs <= 0 || deadline.signal.aborted) return { kind: 'failed', reason: 'Review timed out.' };
        await sleepForRetry(delayMs, deadline.signal);
      }
      return { kind: 'failed', reason: 'Review timed out.' };
    } catch (error) {
      context.signal.throwIfAborted();
      return {
        kind: 'failed',
        reason: deadline.signal.aborted
          ? 'Review timed out.'
          : error instanceof Error ? error.message : String(error),
      };
    } finally {
      deadline.clear();
    }
  }

  private async reviewOnce(
    context: ResolvedToolExecutionHookContext,
    modelAlias: string,
    projectInstructions: ProjectInstructions,
    deadline: DeadlineAbortSignal,
  ): Promise<ReviewAttempt> {
    const history = this.context.get();
    const authorization = extractAuthorization(history);
    const cwd = this.workspace.workDir;
    const message = await this.requestModel(
      modelAlias,
      buildReviewMessages(
        history,
        authorization,
        projectInstructions.agentsMd,
        projectInstructions.agentsMdPaths,
        cwd,
        context,
      ),
      context.turnId,
      deadline.signal,
    );
    const current = extractAuthorization(this.context.get());
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
    const maxCompletionTokensCap = overrides?.maxCompletionTokens;
    const budget = completionBudgetParams({
      budget: resolveCompletionBudget({
        maxOutputSize: model.maxOutputSize,
        maxCompletionTokensCap,
      }),
      capability: model.capabilities,
    });
    const optedOut = maxCompletionTokensCap !== undefined && maxCompletionTokensCap <= 0;
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
      maxCompletionTokens: optedOut ? maxCompletionTokensCap : budget?.maxCompletionTokens,
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
  if (outcome.error !== undefined) return retryableRequestError(outcome.error);
  return outcome.reason === 'The reviewer returned an invalid decision.';
}

function contextOverflow(error: unknown): boolean {
  return classifyApiError(error).kind === 'context_overflow';
}

function retryableRequestError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (!isError2(error) || error.code === PROVIDER_AUTH_ERROR_CODE) return false;
  const statusCode = error.details?.['statusCode'];
  if (typeof statusCode === 'number') return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  return error.code === PROVIDER_RATE_LIMIT_ERROR_CODE
    || error.code === PROVIDER_OVERLOADED_ERROR_CODE
    || error.code === PROVIDER_CONNECTION_ERROR_CODE;
}

function authorizationChanged(): AutoReviewResult {
  return { kind: 'failed', reason: 'Authorization changed during review.' };
}

registerScopedService(
  LifecycleScope.Agent,
  IAutoReviewService,
  AutoReviewService,
  ScopeActivation.OnScopeCreated,
  'autoReview',
);
