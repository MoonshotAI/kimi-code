import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_OPEN } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { toControlResult } from './controlResult';
import { SPINE_OPEN_DESCRIPTION, SPINE_OPEN_SUMMARY_DESCRIPTION } from './descriptions';
import { isSpineControlHost } from './gate';

export interface SpineOpenInput {
  readonly summary: string;
}

const SpineOpenInputSchema: z.ZodType<SpineOpenInput> = z.object({
  summary: z.string().min(1).describe(SPINE_OPEN_SUMMARY_DESCRIPTION),
});

export interface ISpineOpenTool extends AgentTool<SpineOpenInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineOpenTool = createDecorator<ISpineOpenTool>('spineOpenTool');

export class SpineOpenTool implements ISpineOpenTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_OPEN;
  readonly description = SPINE_OPEN_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineOpenInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineOpenInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Open a Spine child node',
      execute: async (_ctx) => toControlResult(this.spine.acceptOpen(input.summary)),
    };
  }
}

registerAgentToolService(ISpineOpenTool, SpineOpenTool, {
  name: SPINE_TOOL_OPEN,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) && isSpineControlHost(accessor),
});
