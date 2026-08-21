import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { AgentGoal, type GoalRuntime } from '#/agent/goal/goalAgentRuntime';
import { IAgentManager } from '#/session/agentManager/agentManager';
import { goalResultForModel } from '#/agent/goal/tools/serialize';

import DESCRIPTION from './get-goal.md?raw';
import { GetGoalToolInputSchema, IGetGoalTool, type GetGoalToolInput } from './get-goal';

export class GetGoalTool implements IGetGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'GetGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetGoalToolInputSchema);

  private readonly goal: GoalRuntime;

  constructor(
    @IAgentManager manager: IAgentManager,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    this.goal = manager.resolve(scope.agentContext, AgentGoal);
  }

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

registerAgentToolService(IGetGoalTool, GetGoalTool, {
  name: 'GetGoal',
  domain: 'goal',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
