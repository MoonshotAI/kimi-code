/**
 * GetGoalTool — returns the current goal snapshot (objective, status, budgets,
 * and usage counters) so the model can decide whether to continue, report
 * completion via UpdateGoal, report a blocker, or respect a pause. Registered
 * for the main agent only, mirroring v1's `agent.type === 'main'` gate.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import DESCRIPTION from './get-goal.md?raw';
import { goalResultForModel } from './serialize';

export const GetGoalToolInputSchema = z.object({}).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export class GetGoalTool implements BuiltinTool<GetGoalToolInput> {
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

registerTool(GetGoalTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
