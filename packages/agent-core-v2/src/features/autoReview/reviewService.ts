import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import { authorizationFingerprint, buildReviewMessages } from './context';
import { REVIEW_POLICY } from './policy';
import { IAutoReviewService, type AutoReviewDecision, type AutoReviewResult } from './review';

const AUTO_REVIEW_MODEL_NAME = 'kimi-k2.8';
const AUTO_REVIEW_PROVIDER = 'kimi-code';

const DecisionSchema = z.object({
  risk: z.enum(['low', 'medium', 'high']),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'allow' && (value.risk === 'high' || value.reason !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'invalid allow decision' });
  }
  if (value.decision === 'deny' && value.risk === 'low') {
    ctx.addIssue({ code: 'custom', message: 'invalid deny decision' });
  }
});

export class AutoReviewService extends Service implements IAutoReviewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IModelCatalog private readonly models: IModelCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {
    super();
  }

  async review(context: ResolvedToolExecutionHookContext): Promise<AutoReviewResult> {
    try {
      await this.instructions.ready;
      const history = this.context.get();
      const fingerprint = authorizationFingerprint(history);
      const agentsMd = this.instructions.agentsMd;
      const cwd = this.workspace.workDir;
      const model = this.resolveModel();
      const config = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION);
      const deadline = createDeadlineAbortSignal(
        context.signal,
        config?.timeoutMs ?? 30000,
      );
      try {
        const response = await abortable(this.loop.requester.request({
          modelAlias: model,
          responseFormat: {
            type: 'json_schema',
            jsonSchema: {
              name: 'auto_review_decision',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  risk: { type: 'string', enum: ['low', 'medium', 'high'] },
                  decision: { type: 'string', enum: ['allow', 'deny'] },
                  reason: { type: 'string' },
                },
                required: ['risk', 'decision'],
                additionalProperties: false,
              },
            },
          },
          systemPrompt: REVIEW_POLICY,
          tools: [],
          messages: buildReviewMessages(
            history,
            agentsMd,
            this.instructions.agentsMdPaths,
            cwd,
            this.tools.resolve(context.toolCall.name),
            context,
          ),
          maxOutputSize: 512,
          source: { type: 'operation', turnId: context.turnId, requestKind: 'auto_review' },
        }, undefined, deadline.signal), deadline.signal);
        if (deadline.timedOut()) return { kind: 'failed', reason: 'Review timed out.' };
        if (
          authorizationFingerprint(this.context.get()) !== fingerprint ||
          this.instructions.agentsMd !== agentsMd ||
          this.workspace.workDir !== cwd
        ) {
          return { kind: 'failed', reason: 'Authorization changed during review.' };
        }
        if (response.message.toolCalls.length > 0) {
          return { kind: 'failed', reason: 'The reviewer attempted a tool call.' };
        }
        const text = response.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        const parsed = DecisionSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return { kind: 'failed', reason: 'The reviewer returned an invalid decision.' };
        return { kind: 'decision', decision: parsed.data as AutoReviewDecision };
      } finally {
        deadline.clear();
      }
    } catch (error) {
      context.signal.throwIfAborted();
      return {
        kind: 'failed',
        reason: error instanceof Error && error.name === 'AbortError'
          ? 'Review timed out.'
          : error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveModel(): string {
    const configured = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION)?.model;
    if (configured !== undefined) return configured;
    const managed = this.models.findByName(AUTO_REVIEW_MODEL_NAME).find((alias) => {
      try {
        return this.models.get(alias).providerName === AUTO_REVIEW_PROVIDER;
      } catch {
        return false;
      }
    });
    return managed ?? this.profile.resolveModelContext().modelAlias;
  }
}
