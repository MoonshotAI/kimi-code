import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { AutoReviewCompleted } from './autoReviewEvents';
import REVIEW_POLICY from './auto-review-policy.md?raw';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import { buildReviewMessages, extractAuthorization, sameAuthorization } from './context';
import { IAutoReviewService, type AutoReviewResult } from './review';

const AUTO_REVIEW_REQUEST_KIND = 'auto_review';

const DecisionSchema = z.union([
  z.object({
    risk: z.enum(['low', 'medium']),
    decision: z.literal('allow'),
    reason: z.null(),
  }).strict().transform(({ risk, decision }) => ({ risk, decision })),
  z.object({
    risk: z.enum(['medium', 'high']),
    decision: z.literal('deny'),
    reason: z.string().max(1000).nullable(),
  }).strict().transform(({ risk, decision, reason }) => ({ risk, decision, reason: reason ?? undefined })),
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
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
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
      const first = await this.reviewOnce(context, modelAlias, projectInstructions, deadline);
      if (first.kind !== 'appended') return first;
      const second = await this.reviewOnce(context, modelAlias, projectInstructions, deadline);
      return second.kind === 'appended' ? authorizationChanged() : second;
    } catch (error) {
      context.signal.throwIfAborted();
      return {
        kind: 'failed',
        reason: deadline.timedOut()
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
  ): Promise<AutoReviewResult | { readonly kind: 'appended' }> {
    const history = this.context.get();
    const authorization = extractAuthorization(history);
    const cwd = this.workspace.workDir;
    const response = await abortable(this.loop.requester.request({
      modelAlias,
      systemPrompt: REVIEW_POLICY,
      messages: buildReviewMessages(
        history,
        authorization,
        projectInstructions.agentsMd,
        projectInstructions.agentsMdPaths,
        cwd,
        context,
      ),
      source: {
        type: 'operation',
        turnId: context.turnId,
        requestKind: AUTO_REVIEW_REQUEST_KIND,
        cacheBreakBaseline: false,
      },
      responseFormat: RESPONSE_FORMAT,
      cacheKey: `${this.session.sessionId}:${AUTO_REVIEW_REQUEST_KIND}`,
      thinkingEffort: 'off',
    }, undefined, deadline.signal), deadline.signal);
    const current = extractAuthorization(this.context.get());
    if (this.workspace.workDir !== cwd) return authorizationChanged();
    if (!sameAuthorization(authorization, current)) {
      return sameAuthorization(authorization, current.slice(0, authorization.length))
        ? { kind: 'appended' }
        : authorizationChanged();
    }
    if (response.message.toolCalls.length > 0) {
      return { kind: 'failed', reason: 'The reviewer attempted a tool call.' };
    }
    const text = response.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    const parsed = DecisionSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { kind: 'failed', reason: 'The reviewer returned an invalid decision.' };
    return { kind: 'decision', decision: parsed.data };
  }
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
