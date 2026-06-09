/**
 * GetGoalTool — returns the current goal snapshot (objective, status, budgets,
 * and usage counters) so the model can decide whether to continue, report
 * completion via UpdateGoal, report a blocker, or respect a pause.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './get-goal.md';

export const GetGoalToolInputSchema = z.object({}).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export class GetGoalTool implements BuiltinTool<GetGoalToolInput> {
  readonly name = 'GetGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GetGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: GetGoalToolInput): ToolExecution {
    const store = this.agent.goal;
    return {
      description: 'Reading the current goal',
      approvalRule: this.name,
      execute: async () => {
        const result = store.getGoal();
        return { output: JSON.stringify(result, null, 2) };
      },
    };
  }
}
