import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexOrchestrator } from '#/features/artex/engine/artexOrchestrator';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './goal_met.md?raw';

export const GoalMetInputSchema = z.object({
  reason: z.string(),
});

export type GoalMetInput = z.infer<typeof GoalMetInputSchema>;

const PARAMETERS = toInputJsonSchema(GoalMetInputSchema);

export const IArtexGoalMetTool: ServiceIdentifier<AgentTool<GoalMetInput>> =
  createDecorator<AgentTool<GoalMetInput>>('artexGoalMetTool');

export class ArtexGoalMetTool implements AgentTool<GoalMetInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'goal_met' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {}

  resolveExecution(args: GoalMetInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Marking the ARTEX task complete',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: GoalMetInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const goals = await handle.store.listByKind('goal');
    const open = goals.filter((node) => node.state !== 'met').length;
    if (open > 0) {
      return artexErr(
        `goal_met refused: ${String(open)} of ${String(
          goals.length,
        )} goals of this task are still open; the task stays open. Prove each one with prove_goal(goal_id, evidence_id, reason): the task completes automatically when its last goal is marked met.`,
      );
    }
    await handle.store.markExplorationAchieved(args.reason);
    this.orchestrator?.notifyGoalMet(handle.explorationId, args.reason);
    return { output: 'acknowledged: goal marked met' };
  }
}
