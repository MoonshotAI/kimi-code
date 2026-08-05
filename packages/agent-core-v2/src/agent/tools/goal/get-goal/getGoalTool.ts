/**
 * `tools` domain — `IGetGoalTool` implementation.
 *
 * Reads the current goal snapshot from the goal service (`goal`) and returns
 * it serialized for the model, so the model can decide whether to continue,
 * report completion via UpdateGoal, report a blocker, or respect a pause.
 * Registered for the main agent only, mirroring v1's `agent.type === 'main'`
 * gate. Bound at Agent scope.
 */

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import { goalResultForModel } from '#/agent/goal/tools/serialize';

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

registerAgentToolService(IGetGoalTool, GetGoalTool, {
  name: 'GetGoal',
  domain: 'goal',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
