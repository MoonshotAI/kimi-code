/**
 * UpdateGoalTool — records the model's terminal judgment (complete / blocked) as
 * a *report*. It does not end the goal directly: the continuation controller and
 * the independent evaluator decide whether the report ends the goal. There is no
 * `impossible` option — an unachievable objective is reported as `blocked`.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { goalErrorResult, isGoalToolError, requireGoalStore } from './shared';
import DESCRIPTION from './update-goal.md';

const EvidenceSchema = z
  .object({
    summary: z.string().min(1),
    detail: z.string().optional(),
    source: z.string().optional(),
  })
  .strict();

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['complete', 'blocked'])
      .describe('The terminal judgment you are reporting.'),
    reason: z.string().min(1).describe('A short reason for the judgment.'),
    evidence: z.array(EvidenceSchema).optional().describe('Validation evidence when available.'),
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
      description: `Reporting goal status: ${args.status}`,
      approvalRule: this.name,
      execute: async () => {
        try {
          // Records a model report; does NOT change status. The continuation
          // controller / evaluator decide whether the report ends the goal.
          const snapshot = await store.recordModelReport({
            requestedStatus: args.status,
            reason: args.reason,
            evidence: args.evidence,
          });
          return {
            output: JSON.stringify({ goal: snapshot, goalBudgetReport: snapshot.budget }, null, 2),
          };
        } catch (error) {
          return goalErrorResult(error);
        }
      },
    };
  }
}
