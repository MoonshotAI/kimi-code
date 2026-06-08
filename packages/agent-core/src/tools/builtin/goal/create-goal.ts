/**
 * CreateGoalTool — lets the main agent start an explicit goal on the user's
 * behalf. The goal becomes durable, structured state owned by the session goal
 * store, not text parsed from a slash command.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { goalErrorResult, isGoalToolError, requireGoalStore } from './shared';
import DESCRIPTION from './create-goal.md';

export const CreateGoalToolInputSchema = z
  .object({
    objective: z.string().min(1).describe('The objective to pursue. Must have a verifiable end state.'),
    completionCriterion: z
      .string()
      .optional()
      .describe('How to verify the goal is complete. Include when the user provides one.'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace an existing active or paused goal instead of failing.'),
  })
  .strict();

export type CreateGoalToolInput = z.infer<typeof CreateGoalToolInputSchema>;

export class CreateGoalTool implements BuiltinTool<CreateGoalToolInput> {
  readonly name = 'CreateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CreateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: CreateGoalToolInput): ToolExecution {
    const store = requireGoalStore(this.agent, this.name);
    if (isGoalToolError(store)) return store;

    return {
      description: 'Creating a goal',
      approvalRule: this.name,
      execute: async () => {
        try {
          const snapshot = await store.createGoal({
            objective: args.objective,
            completionCriterion: args.completionCriterion,
            replace: args.replace,
            actor: 'model',
          });
          return { output: JSON.stringify({ goal: snapshot }, null, 2) };
        } catch (error) {
          return goalErrorResult(error);
        }
      },
    };
  }
}
