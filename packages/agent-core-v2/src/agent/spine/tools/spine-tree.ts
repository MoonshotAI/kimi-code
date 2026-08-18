import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_TREE } from '#/agent/spine/spine';
import { IFlagService } from '#/app/flag/flag';
import { SPINE_TREE_DESCRIPTION } from './descriptions';

const SpineTreeInputSchema = z.object({});

export interface ISpineTreeTool extends AgentTool<Record<string, never>> {
  readonly _serviceBrand: undefined;
}
export const ISpineTreeTool = createDecorator<ISpineTreeTool>('spineTreeTool');

export class SpineTreeTool implements ISpineTreeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_TREE;
  readonly description = SPINE_TREE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineTreeInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Inspect the Spine tree',
      execute: async () => ({ isError: false, output: this.spine.renderTree() }),
    };
  }
}

registerAgentToolService(ISpineTreeTool, SpineTreeTool, {
  name: SPINE_TOOL_TREE,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === 'main',
});
