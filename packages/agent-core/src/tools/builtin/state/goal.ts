import { z } from 'zod';

import type { GoalData, GoalManager } from '../../../agent/goal';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop';
import { toInputJsonSchema } from '../../support/input-schema';

const CreateGoalInputSchema = z.object({
  objective: z
    .string()
    .min(1)
    .regex(/\S/, 'String must contain at least one non-whitespace character')
    .refine((objective) => Array.from(objective).length <= 4_000, {
      message: 'String must contain at most 4000 Unicode code points',
    }),
  token_budget: z.number().int().positive().optional(),
});

const UpdateGoalInputSchema = z.object({
  status: z.enum(['complete', 'blocked']),
});

export class GetGoalTool implements BuiltinTool<Record<string, never>> {
  readonly name = 'get_goal';
  readonly description =
    'Get the current goal, including status, budgets, token usage, elapsed active time, and remaining token budget.';
  readonly parameters = toInputJsonSchema(z.object({}));

  constructor(private readonly goal: GoalManager) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({ isError: false, output: JSON.stringify(goalResponse(this.goal.get())) }),
    };
  }
}

export class CreateGoalTool implements BuiltinTool<z.infer<typeof CreateGoalInputSchema>> {
  readonly name = 'create_goal';
  readonly description =
    'Create a goal only when the user or system explicitly requests it. Do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal already exists.';
  readonly parameters = toInputJsonSchema(CreateGoalInputSchema);

  constructor(private readonly goal: GoalManager) {}

  resolveExecution(args: z.infer<typeof CreateGoalInputSchema>): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({
        isError: false,
        output: JSON.stringify(goalResponse(this.goal.create(args.objective, args.token_budget))),
      }),
    };
  }
}

export class UpdateGoalTool implements BuiltinTool<z.infer<typeof UpdateGoalInputSchema>> {
  readonly name = 'update_goal';
  readonly description =
    'Set status to complete only when the objective is fully achieved. Set blocked only after the same blocker repeats for at least three consecutive goal turns and meaningful progress requires user input or an external-state change. Do not use blocked because work is hard, slow, uncertain, or incomplete.';
  readonly parameters = toInputJsonSchema(UpdateGoalInputSchema);

  constructor(private readonly goal: GoalManager) {}

  resolveExecution(args: z.infer<typeof UpdateGoalInputSchema>): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => ({
        isError: false,
        output: JSON.stringify(goalResponse(updateGoal(this.goal, args.status), true)),
      }),
    };
  }
}

function updateGoal(goal: GoalManager, status: 'complete' | 'blocked'): GoalData {
  return status === 'complete' ? goal.complete() : goal.block();
}

function goalResponse(goal: GoalData | null, includeCompletionReport = false) {
  return {
    goal,
    remaining_tokens: goal?.remainingTokens,
    completion_budget_report:
      includeCompletionReport && goal?.status === 'complete'
        ? `Goal completed with ${String(goal.tokensUsed)} tokens used over ${String(goal.timeUsedSeconds)} active seconds.`
        : undefined,
  };
}
