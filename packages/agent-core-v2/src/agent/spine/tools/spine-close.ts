import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_CLOSE } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { toControlResult } from './controlResult';
import { SPINE_CLOSE_DESCRIPTION, SPINE_NODE_MEMORY_DESCRIPTION } from './descriptions';
import { isSpineControlHost } from './gate';

export interface SpineCloseInput {
  readonly memory: string;
}

const SpineCloseInputSchema: z.ZodType<SpineCloseInput> = z.object({
  memory: z.string().min(1).describe(SPINE_NODE_MEMORY_DESCRIPTION),
});

export interface ISpineCloseTool extends AgentTool<SpineCloseInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineCloseTool = createDecorator<ISpineCloseTool>('spineCloseTool');

export class SpineCloseTool implements ISpineCloseTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_CLOSE;
  readonly description = SPINE_CLOSE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineCloseInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineCloseInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Close the current Spine node',
      execute: async (_ctx) => toControlResult(this.spine.acceptClose(input.memory)),
    };
  }
}

registerAgentToolService(ISpineCloseTool, SpineCloseTool, {
  name: SPINE_TOOL_CLOSE,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) && isSpineControlHost(accessor),
});
