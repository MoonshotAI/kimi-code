import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  resolveSpawnMaxThreads,
  SPINE_SPAWN_SECTION,
  type SpineSpawnConfig,
} from '#/agent/spine/configSection';
import { SPINE_FLAG_ID, SPINE_SPAWN_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_SPAWN } from '#/agent/spine/spine';
import { maxSpawnBranchCount, MIN_SPAWN_TASKS } from '#/agent/spine/spineSpawn';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { toSpawnResult } from './controlResult';
import {
  SPINE_SPAWN_DESCRIPTION,
  SPINE_SPAWN_PROMPT_DESCRIPTION,
  SPINE_SPAWN_SUMMARY_DESCRIPTION,
  SPINE_SPAWN_TASKS_DESCRIPTION,
  spawnTaskCountDescription,
} from './descriptions';

const SpineSpawnInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        summary: z.string().min(1).describe(SPINE_SPAWN_SUMMARY_DESCRIPTION),
        prompt: z.string().min(1).describe(SPINE_SPAWN_PROMPT_DESCRIPTION),
      }),
    )
    .min(MIN_SPAWN_TASKS)
    .describe(SPINE_SPAWN_TASKS_DESCRIPTION),
});

export type SpineSpawnInput = z.infer<typeof SpineSpawnInputSchema>;

export interface ISpineSpawnTool extends AgentTool<SpineSpawnInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineSpawnTool = createDecorator<ISpineSpawnTool>('spineSpawnTool');

export class SpineSpawnTool implements ISpineSpawnTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_SPAWN;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineSpawnInputSchema);

  constructor(
    @IAgentSpineService private readonly spine: IAgentSpineService,
    @IConfigService private readonly config: IConfigService,
  ) {
    const maxBranches = maxSpawnBranchCount(
      resolveSpawnMaxThreads(this.config.get<SpineSpawnConfig>(SPINE_SPAWN_SECTION)),
    );
    this.description = `${SPINE_SPAWN_DESCRIPTION} ${spawnTaskCountDescription(MIN_SPAWN_TASKS, maxBranches)}`;
  }

  resolveExecution(input: SpineSpawnInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Spawn parallel Spine branches',
      execute: async (ctx) => toSpawnResult(await this.spine.executeSpawn(input.tasks, ctx.signal)),
    };
  }
}

function spawnCapacityAtLeastTwo(config: IConfigService): boolean {
  const maxThreads = resolveSpawnMaxThreads(config.get<SpineSpawnConfig>(SPINE_SPAWN_SECTION));
  return maxSpawnBranchCount(maxThreads) >= 2;
}

registerAgentToolService(ISpineSpawnTool, SpineSpawnTool, {
  name: SPINE_TOOL_SPAWN,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_FLAG_ID) &&
    accessor.get(IFlagService).enabled(SPINE_SPAWN_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === 'main' &&
    spawnCapacityAtLeastTwo(accessor.get(IConfigService)),
});
