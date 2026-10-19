import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

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

export interface ITowerReviewTool extends AgentTool<TowerReviewToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerReviewTool = createDecorator<ITowerReviewTool>('towerReviewTool');
