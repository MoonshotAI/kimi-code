import { z } from 'zod';

import { type ToolDefinition } from '@moonshot-ai/agent-core';

import DESCRIPTION from './review.md?raw';
import {
  callerName,
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  type TowerToolDeps,
} from './support';

export const TowerReviewToolInputSchema = z
  .object({
    target: z.string().describe('The branch you were assigned to review'),
    status: z
      .string()
      .regex(/^(clean|p[12]-\d+items)$/)
      .describe(
        'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority',
      ),
    merge: z
      .enum(['merge', 'fix-then-merge', 'hold'])
      .describe('Merge recommendation for the tower'),
    findings: z.string().describe('Full findings text (markdown); write "none" when clean'),
    checks: z
      .array(z.string())
      .optional()
      .describe('Checklist items you verified (e.g. "tests pass", "no secrets")'),
    decision: z.string().describe('The reasoning behind your verdict'),
  })
  .strict();

export type TowerReviewToolInput = z.infer<typeof TowerReviewToolInputSchema>;

export function createTowerReviewTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerReview',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerReviewToolInputSchema),
    execute({ toolCall }) {
      const parsed = parseTowerArgs(TowerReviewToolInputSchema, toolCall.arguments, 'TowerReview');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const state = await store.load();
        const caller = callerName(deps.agentId, store, state);
        const rel = await store.submitReview(caller, {
          target: args.target,
          status: args.status,
          merge: args.merge,
          findings: args.findings,
          checks: args.checks,
          decision: args.decision,
        });
        return text(
          `review submitted: ${rel}\nAlso notify the branch author (or the tower) with TowerSend so the verdict is seen.`,
        );
      });
    },
  };
}
