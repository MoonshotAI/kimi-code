/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked`) or keeps going (`active`).
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import type { BuiltinTool, ToolExecution } from '#/agent/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns.',
      ),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(@IAgentGoalService private readonly goal: IAgentGoalService) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    if (!isUpdateGoalStatus(args.status)) {
      return {
        isError: true,
        output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
      };
    }

    const status = args.status;
    const currentGoal = this.goal.getGoal().goal;
    const goalIsActive = currentGoal?.status === 'active';

    return {
      description: `Setting goal status: ${status}`,
      stopBatchAfterThis: status !== 'active' && goalIsActive,
      approvalRule: this.name,
      execute: async () => {
        if (status === 'active') {
          await this.goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (status === 'complete') {
          await this.goal.markComplete({}, 'model');
          return { output: 'Goal marked complete.', stopTurn: true };
        }
        if (status === 'blocked') {
          await this.goal.markBlocked({}, 'model');
          return { output: 'Goal marked blocked.', stopTurn: true };
        }
        return {
          isError: true,
          output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
        };
      },
    };
  }
}

function isUpdateGoalStatus(status: unknown): status is UpdateGoalToolInput['status'] {
  return status === 'active' || status === 'complete' || status === 'blocked';
}

registerTool(UpdateGoalTool);
