import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { interactions } from '#/human/interaction/facade';

import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr } from '../toolSupport';
import DESCRIPTION from './ask_operator.md?raw';

export const AskOperatorInputSchema = z.object({
  question: z.string().min(1),
  image_path: z.string().optional(),
});

export type AskOperatorInput = z.infer<typeof AskOperatorInputSchema>;

const PARAMETERS = toInputJsonSchema(AskOperatorInputSchema);

export const IArtexAskOperatorTool: ServiceIdentifier<AgentTool<AskOperatorInput>> =
  createDecorator<AgentTool<AskOperatorInput>>('artexAskOperatorTool');

export class ArtexAskOperatorTool implements AgentTool<AskOperatorInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ask_operator' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly artexSession: IArtexSessionContext,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  resolveExecution(args: AskOperatorInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Asking ARTEX operator for input',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AskOperatorInput): Promise<ExecutableToolResult> {
    if (this.artexSession.getActiveExplorationId() === undefined) return ARTEX_INACTIVE_RESULT;
    const question = args.question.trim();
    if (question === '') return artexErr('question is required');
    const intentRaw = this.scope.meta?.labels?.['artexIntentId'];
    const intentId = intentRaw === undefined ? undefined : Number(intentRaw);
    if (intentId === undefined || !Number.isInteger(intentId) || intentId <= 0) {
      return artexErr('ask_operator can only be used inside an ARTEX worker intent run');
    }
    await interactions.request({
      kind: 'question',
      payload: {
        question,
        imagePath: args.image_path,
        intentId,
        explorationId: this.artexSession.getActiveExplorationId(),
      },
      tags: {
        sessionId: this.session.sessionId,
        agentId: this.scope.agentId,
        artexIntentId: String(intentId),
      },
    });
    return {
      output:
        'Question delivered to the operator. Finish the current step and record facts; the operator reply resumes this run as your next input.',
    };
  }
}