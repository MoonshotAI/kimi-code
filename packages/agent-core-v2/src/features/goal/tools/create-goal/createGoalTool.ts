import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { GOAL_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { type ToolExecution } from '#/tool/toolContract';

import { IAgentGoalService } from '#/features/goal/goal';
import { goalForModel } from '#/features/goal/tools/serialize';

import DESCRIPTION from './create-goal.md?raw';
import {
  CreateGoalToolInputSchema,
  ICreateGoalTool,
  type CreateGoalToolInput,
} from './create-goal';

export class CreateGoalTool implements ICreateGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'CreateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CreateGoalToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: CreateGoalToolInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, GOAL_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    const goalAtResolution = this.goal.getGoal().goal;
    return {
      description: 'Creating a goal',
      display: this.resolveGoalStartDisplay(args),
      approvalRule: this.name,
      execute: async ({ turnId }) => {
        const currentGoal = this.goal.getGoal().goal;
        if (
          currentGoal?.goalId !== goalAtResolution?.goalId &&
          (currentGoal === null || !this.goal.isGoalToolTarget(turnId, currentGoal.goalId))
        ) {
          return { output: 'Goal not created: the current goal changed.' };
        }
        const snapshot = await this.goal.createGoal(
          {
            objective: args.objective,
            completionCriterion: args.completionCriterion,
            replace: args.replace,
          },
          'model',
        );
        return { output: JSON.stringify({ goal: goalForModel(snapshot) }, null, 2) };
      },
    };
  }

  private resolveGoalStartDisplay(args: CreateGoalToolInput): ToolInputDisplay | undefined {
    const mode = this.permissionMode.mode;
    if (mode === 'auto') return undefined;
    return {
      kind: 'goal_start',
      objective: args.objective,
      completionCriterion: args.completionCriterion,
      mode,
    };
  }
}
