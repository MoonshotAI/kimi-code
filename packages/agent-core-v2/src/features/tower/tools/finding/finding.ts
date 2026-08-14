/**
 * `tools` domain — `ITowerFindingTool` contract (the `TowerFinding` tool).
 *
 * Public contract of the structured finding filer (bug / improve / vuln /
 * idea) for the tower to route; workers use it for anything notable outside
 * their mission scope instead of fixing it directly. Exports the
 * model-facing `TowerFindingToolInputSchema` / `TowerFindingToolInput` and
 * the `ITowerFindingTool` DI decorator. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerFindingToolInputSchema = z
  .object({
    type: z.enum(['bug', 'improve', 'vuln', 'idea']).describe('Finding category'),
    title: z.string().describe('Short finding title'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    summary: z.string().describe('What was found, in a sentence or two'),
    location: z.string().optional().describe('File/symbol the finding concerns'),
    details: z.string().describe('Full details: evidence, reproduction, impact'),
    suggested_fix: z.string().describe('What you would do about it'),
  })
  .strict();

export type TowerFindingToolInput = z.infer<typeof TowerFindingToolInputSchema>;

export interface ITowerFindingTool extends AgentTool<TowerFindingToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerFindingTool = createDecorator<ITowerFindingTool>('towerFindingTool');
