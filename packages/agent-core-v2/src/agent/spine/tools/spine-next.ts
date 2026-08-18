import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_NEXT } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { toControlResult } from './controlResult';
import {
  SPINE_NEXT_DESCRIPTION,
  SPINE_NEXT_SUMMARY_DESCRIPTION,
  SPINE_NODE_MEMORY_DESCRIPTION,
} from './descriptions';
import { isSpineControlHost } from './gate';

export interface SpineNextInput {
  readonly summary: string;
  readonly memory: string;
}

const SpineNextInputSchema: z.ZodType<SpineNextInput> = z.object({
  summary: z.string().min(1).describe(SPINE_NEXT_SUMMARY_DESCRIPTION),
  memory: z.string().min(1).describe(SPINE_NODE_MEMORY_DESCRIPTION),
});

export interface ISpineNextTool extends AgentTool<SpineNextInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineNextTool = createDecorator<ISpineNextTool>('spineNextTool');

export class SpineNextTool implements ISpineNextTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_NEXT;
  readonly description = SPINE_NEXT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineNextInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineNextInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Finish this node and open the next sibling',
      execute: async (_ctx) =>
        toControlResult(this.spine.acceptNext(input.summary, input.memory)),
    };
  }
}

registerAgentToolService(ISpineNextTool, SpineNextTool, {
  name: SPINE_TOOL_NEXT,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) && isSpineControlHost(accessor),
});
