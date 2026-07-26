/**
 * GetGoalTool — returns the current goal snapshot (objective, status, budgets,
 * and usage counters) so the model can decide whether to continue, report
 * completion via UpdateGoal, report a blocker, or respect a pause. Registered
 * for the main agent only, mirroring v1's `agent.type === 'main'` gate.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type AgentTool, type ToolExecution } from '#/tool/toolContract';
import { registerAgentTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import DESCRIPTION from './get-goal.md?raw';
import { goalResultForModel } from './serialize';

export const GetGoalToolInputSchema = z.object({}).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export interface IGetGoalTool extends AgentTool<GetGoalToolInput> { readonly _serviceBrand: undefined }
export const IGetGoalTool = createDecorator<IGetGoalTool>('getGoalTool');

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

registerAgentTool(IGetGoalTool, GetGoalTool, {
  name: 'GetGoal',
  domain: 'goal',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
