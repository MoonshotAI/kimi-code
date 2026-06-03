/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked` / `paused`) or keeps going
 * (`active`).
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal. The tool is only offered to the model while a goal exists (see the
 * `loopTools` filter in the tool manager).
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import { buildGoalCompletionMessage } from '../../../agent/goal/completion';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { goalErrorResult, isGoalToolError, requireGoalStore } from './shared';
import DESCRIPTION from './update-goal.md';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'paused', 'blocked'])
      .describe('The lifecycle status to set for the current goal.'),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    const store = requireGoalStore(this.agent, this.name);
    if (isGoalToolError(store)) return store;

    return {
      description: `Setting goal status: ${args.status}`,
      stopBatchAfterThis: args.status !== 'active',
      approvalRule: this.name,
      execute: async () => {
        try {
          if (args.status === 'active') {
            await store.resumeGoal({ actor: 'model' });
            return { output: 'Goal resumed.' };
          }
          if (args.status === 'complete') {
            const completed = await store.markComplete({ actor: 'model' });
            // `complete` is transient — markComplete announces then clears the
            // record. Store the deterministic completion line as a system
            // reminder, so the next provider request ends with a user message
            // after the UpdateGoal tool result. Anthropic-compatible providers
            // reject trailing assistant messages as unsupported prefill.
            if (completed !== null) {
              this.agent.context.appendSystemReminder(buildGoalCompletionMessage(completed), {
                kind: 'system_trigger',
                name: 'goal_completion',
              });
            }
            return { output: 'Goal marked complete.', stopTurn: true };
          }
          if (args.status === 'blocked') {
            await store.markBlocked({ actor: 'model' });
            return { output: 'Goal marked blocked.', stopTurn: true };
          }
          await store.pauseGoal({ actor: 'model' });
          return { output: 'Goal paused.', stopTurn: true };
        } catch (error) {
          return goalErrorResult(error);
        }
      },
    };
  }
}
