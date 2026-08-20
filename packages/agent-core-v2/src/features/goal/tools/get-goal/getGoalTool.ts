import { toInputJsonSchema } from '#/tool/input-schema';
import { type ToolExecution } from '#/tool/toolContract';

import { IAgentGoalService } from '#/features/goal/goal';
import { goalResultForModel } from '#/features/goal/tools/serialize';

import DESCRIPTION from './get-goal.md?raw';
import { GetGoalToolInputSchema, IGetGoalTool, type GetGoalToolInput } from './get-goal';

export class GetGoalTool implements IGetGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'GetGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetGoalToolInputSchema);

  constructor(@IAgentGoalService private readonly goal: IAgentGoalService) {}

  resolveExecution(_args: GetGoalToolInput): ToolExecution {
    return {
      description: 'Reading the current goal',
      approvalRule: this.name,
      execute: async () => {
        const result = this.goal.getGoal();
        return { output: JSON.stringify(goalResultForModel(result), null, 2) };
      },
    };
  }
}
