import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { IConfigService } from '#/app/config/config';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IModelRequester } from '#/llm-adapter/model/model-requester';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import REVIEW_POLICY from './auto-review-policy.md?raw';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import { authorizationEntries, buildReviewMessages } from './context';
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
  private readonly projectInstructions: Promise<ProjectInstructions>;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IModelRequester private readonly requester: IModelRequester,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
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
    const modelAlias = config?.model ?? this.profile.resolveModelContext().modelAlias;
    const result = await this.reviewWithDeadline(context, modelAlias, config?.timeoutMs ?? 30000);
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
    const authorization = authorizationEntries(history);
    const cwd = this.workspace.workDir;
    const params = modelAlias === this.profile.resolveModelContext().modelAlias
      ? this.profile.resolveRequestParams()
      : undefined;
    const response = await abortable(this.requester.request({
      modelAlias,
      params,
      systemPrompt: REVIEW_POLICY,
      messages: buildReviewMessages(
        history,
        projectInstructions.agentsMd,
        projectInstructions.agentsMdPaths,
        cwd,
        context,
      ),
      responseFormat: RESPONSE_FORMAT,
      cacheKey: `${this.session.sessionId}:${AUTO_REVIEW_REQUEST_KIND}`,
    }, deadline.signal), deadline.signal);
    void this.usage.record(this.scopeContext.agentContext, modelAlias, response.usage, {
      type: 'operation',
      turnId: context.turnId,
      requestKind: AUTO_REVIEW_REQUEST_KIND,
    });
    const current = authorizationEntries(this.context.get());
    if (this.workspace.workDir !== cwd) return authorizationChanged();
    if (!sameEntries(authorization, current)) {
      return sameEntries(authorization, current.slice(0, authorization.length))
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

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
